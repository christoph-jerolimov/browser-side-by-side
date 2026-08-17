// Docs Side-by-Side — content script for Google Docs.
//
// Watches the current selection and the cursor position (via the Docs link
// bubble) inside a Google Docs document. When the selected text or the link
// under the cursor matches one of the rules in config.json, it tells the
// background script, which either navigates the existing companion window
// ("follow" mode) or shows a clickable pill offering to open one.
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;

  const MAX_SELECTION_LENGTH = 300; // ignore huge selections (e.g. select-all)
  const EVALUATE_DEBOUNCE_MS = 150;
  const POLL_INTERVAL_MS = 700;

  let rules = [];
  let currentMatch = null; // { url, label }
  let lastKey = null;      // last match url we acted on (dedupe)
  let debounceTimer = null;

  // ---------------------------------------------------------------- config

  async function loadConfig() {
    try {
      const cfg = await api.runtime.sendMessage({ type: 'getConfig' });
      rules = ((cfg && cfg.rules) || [])
        .map((r) => {
          try {
            return { name: r.name || 'rule', re: new RegExp(r.match), url: r.url };
          } catch (e) {
            console.warn('[docs-side-by-side] invalid pattern in config.json:', r, e);
            return null;
          }
        })
        .filter(Boolean);
    } catch (e) {
      console.warn('[docs-side-by-side] could not load config:', e);
    }
  }

  function applyTemplate(template, m) {
    return template.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
  }

  function matchRules(text) {
    if (!text) return null;
    for (const rule of rules) {
      const m = rule.re.exec(text);
      if (m) {
        return { url: applyTemplate(rule.url, m), label: `${rule.name}: ${m[0]}` };
      }
    }
    return null;
  }

  // ------------------------------------------------------------- detection

  // Google sometimes wraps hrefs as https://www.google.com/url?q=<target>.
  function unwrapGoogleRedirect(url) {
    try {
      const u = new URL(url);
      if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
        const q = u.searchParams.get('q');
        if (q) return q;
      }
    } catch (e) { /* not a URL */ }
    return url;
  }

  // When the caret sits on a link, Docs shows a small bubble containing the
  // target URL as a real <a>. This works even though the editor is a canvas.
  function readLinkUnderCursor() {
    for (const bubble of document.querySelectorAll('.docs-linkbubble-bubble')) {
      if (bubble.style.display === 'none') continue;
      if (!(bubble.offsetWidth || bubble.offsetHeight || bubble.getClientRects().length)) continue;
      const a = bubble.querySelector('a[href]');
      if (a && a.href) return unwrapGoogleRedirect(a.href);
    }
    return '';
  }

  // The canvas-based Docs editor mirrors the current selection into a hidden
  // same-origin iframe (used for native copy/IME). Reading it is the most
  // reliable way to get the selected text without any Docs API.
  function readSelection() {
    try {
      const s = window.getSelection && String(window.getSelection());
      if (s && s.trim()) return s.trim();
    } catch (e) { /* ignore */ }

    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (iframe) {
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          const sel = doc.getSelection && String(doc.getSelection());
          if (sel && sel.trim()) return sel.trim();
          const el = (doc.activeElement && doc.activeElement.textContent)
            ? doc.activeElement
            : doc.body;
          const t = el && el.textContent && el.textContent.trim();
          if (t) return t;
        }
      } catch (e) { /* ignore */ }
    }
    return '';
  }

  // -------------------------------------------------------------- pill UI

  let pillHost = null;
  let pillEl = null;
  let pillLabelEl = null;
  let hideTimer = null;

  function ensurePill() {
    if (pillHost && pillHost.isConnected) return;
    pillHost = document.createElement('div');
    pillHost.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    const shadow = pillHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .pill {
        display: none; align-items: center; gap: 8px; max-width: 440px;
        padding: 10px 14px; border-radius: 999px;
        font: 13px/1.3 system-ui, -apple-system, sans-serif; color: #fff;
        background: #1a73e8; cursor: pointer; user-select: none;
        box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
      }
      .pill.visible { display: flex; }
      .pill.followed { background: #188038; }
      .pill.paused { background: #5f6368; }
      .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `;
    pillEl = document.createElement('div');
    pillEl.className = 'pill';
    pillLabelEl = document.createElement('span');
    pillLabelEl.className = 'txt';
    pillEl.appendChild(pillLabelEl);
    pillEl.addEventListener('click', onPillClick);
    shadow.append(style, pillEl);
    (document.body || document.documentElement).appendChild(pillHost);
  }

  function showPill(state, label, ttlMs) {
    ensurePill();
    pillEl.className = `pill visible ${state}`;
    pillLabelEl.textContent = label;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => pillEl.classList.remove('visible'), ttlMs || 8000);
  }

  function screenInfo() {
    return {
      left: screen.availLeft || 0,
      top: screen.availTop || 0,
      width: screen.availWidth,
      height: screen.availHeight,
    };
  }

  async function onPillClick() {
    if (!currentMatch) return;
    try {
      await api.runtime.sendMessage({ type: 'open', url: currentMatch.url, screen: screenInfo() });
      showPill('followed', `Sidebar → ${currentMatch.label}`, 3000);
    } catch (e) { /* extension reloaded, ignore */ }
  }

  // ------------------------------------------------------------- main loop

  async function act(match) {
    currentMatch = match;
    let resp;
    try {
      resp = await api.runtime.sendMessage({ type: 'match', url: match.url, label: match.label });
    } catch (e) {
      return;
    }
    if (!resp) return;
    if (resp.status === 'followed') {
      showPill('followed', `Sidebar → ${match.label}`, 3000);
    } else if (resp.status === 'needsOpen') {
      showPill('needsOpen', `Open in sidebar: ${match.label}`);
    } else if (resp.status === 'paused') {
      showPill('paused', `Paused — click to open: ${match.label}`);
    }
  }

  function evaluate() {
    if (!rules.length) return;
    const link = readLinkUnderCursor();
    let match = link ? matchRules(link) : null;
    if (!match) {
      const sel = readSelection();
      if (sel && sel.length <= MAX_SELECTION_LENGTH) match = matchRules(sel);
    }
    if (!match) return;
    if (match.url === lastKey) return;
    lastKey = match.url;
    act(match);
  }

  function scheduleEvaluate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(evaluate, EVALUATE_DEBOUNCE_MS);
  }

  // Keyboard input in Docs lands inside the hidden event-target iframe, so
  // listen there too (arrow keys move the cursor without any top-level event).
  function hookEventTargetIframe() {
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (!iframe || iframe.dataset.sbsHooked) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      iframe.dataset.sbsHooked = '1';
      doc.addEventListener('keyup', scheduleEvaluate, true);
      doc.addEventListener('mouseup', scheduleEvaluate, true);
    } catch (e) { /* ignore */ }
  }

  function init() {
    loadConfig();

    document.addEventListener('mouseup', scheduleEvaluate, true);
    document.addEventListener('keyup', scheduleEvaluate, true);
    document.addEventListener('selectionchange', scheduleEvaluate);

    // Re-arm when follow is toggled so the sidebar catches up with the
    // current selection on the next tick.
    if (api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.following) {
          lastKey = null;
          scheduleEvaluate();
        }
      });
    }

    // Safety net: Docs swallows many events inside its canvas, so poll cheaply.
    setInterval(() => {
      hookEventTargetIframe();
      evaluate();
    }, POLL_INTERVAL_MS);
  }

  init();
})();
