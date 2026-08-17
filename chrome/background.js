// Docs Side-by-Side — background script.
//
// Owns the companion ("sidebar") window and the follow/pause state.
// Works both as a Chrome MV3 service worker and a Firefox MV2 background
// script: all state lives in storage.local, and every API used here returns
// promises in both browsers.
'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const actionApi = api.action ?? api.browserAction;

const DEFAULT_STATE = {
  following: true,
  companionWindowId: null,
  companionTabId: null,
  lastUrl: null,
};

function getState() {
  return api.storage.local.get(DEFAULT_STATE);
}

function setState(patch) {
  return api.storage.local.set(patch);
}

let configPromise = null;
function getConfig() {
  configPromise ??= fetch(api.runtime.getURL('config.json')).then((r) => r.json());
  return configPromise;
}

async function companionAlive(state) {
  if (state.companionTabId == null) return false;
  try {
    await api.tabs.get(state.companionTabId);
    return true;
  } catch (e) {
    return false;
  }
}

async function clearCompanion() {
  await setState({ companionWindowId: null, companionTabId: null, lastUrl: null });
}

async function updateBadge() {
  const state = await getState();
  try {
    await actionApi.setBadgeText({ text: state.following ? 'ON' : '❚❚' });
    await actionApi.setBadgeBackgroundColor({ color: state.following ? '#188038' : '#5f6368' });
  } catch (e) { /* badge is cosmetic */ }
}

// ------------------------------------------------------------------ tiling

function halves(scr) {
  const half = Math.floor(scr.width / 2);
  return {
    left: { left: scr.left, top: scr.top, width: half, height: scr.height },
    right: { left: scr.left + half, top: scr.top, width: scr.width - half, height: scr.height },
  };
}

async function setBounds(windowId, bounds) {
  // A maximized window rejects bounds updates, so un-maximize first.
  try { await api.windows.update(windowId, { state: 'normal' }); } catch (e) { /* ignore */ }
  try { await api.windows.update(windowId, bounds); } catch (e) { /* ignore */ }
}

// --------------------------------------------------------------- companion

async function openCompanion(url, docWindowId, scr) {
  const state = await getState();

  // Already have one? Just navigate it.
  if (await companionAlive(state)) {
    await api.tabs.update(state.companionTabId, { url });
    await setState({ lastUrl: url });
    return;
  }

  const cfg = await getConfig().catch(() => ({}));
  let bounds = null;
  if (cfg.autoTile !== false && scr && scr.width) {
    const h = halves(scr);
    bounds = h.right;
    if (docWindowId != null) await setBounds(docWindowId, h.left);
  }

  const createData = { url };
  if (bounds) Object.assign(createData, bounds);
  let win;
  try {
    // focused:false keeps the caret in the doc; not every platform honors it.
    win = await api.windows.create(Object.assign({}, createData, { focused: false }));
  } catch (e) {
    win = await api.windows.create(createData);
  }

  let tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  if (tabId == null) {
    const tabs = await api.tabs.query({ windowId: win.id });
    tabId = tabs[0] ? tabs[0].id : null;
  }
  await setState({ companionWindowId: win.id, companionTabId: tabId, lastUrl: url });

  // Hand focus back to the document window so the user keeps typing there.
  if (docWindowId != null) {
    try { await api.windows.update(docWindowId, { focused: true }); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- messages

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'getConfig':
      return getConfig();

    case 'match': {
      const state = await getState();
      if (!state.following) return { status: 'paused' };
      if (!(await companionAlive(state))) return { status: 'needsOpen' };
      if (state.lastUrl !== msg.url) {
        await api.tabs.update(state.companionTabId, { url: msg.url });
        await setState({ lastUrl: msg.url });
      }
      return { status: 'followed' };
    }

    case 'open': {
      const docWindowId = sender.tab ? sender.tab.windowId : msg.windowId;
      await openCompanion(msg.url, docWindowId, msg.screen);
      return { status: 'opened' };
    }

    case 'getStatus': {
      const state = await getState();
      return {
        following: state.following,
        hasCompanion: await companionAlive(state),
        lastUrl: state.lastUrl,
      };
    }

    case 'setFollowing':
      await setState({ following: !!msg.value });
      await updateBadge();
      return { ok: true };

    case 'closeCompanion': {
      const state = await getState();
      if (state.companionWindowId != null) {
        try { await api.windows.remove(state.companionWindowId); } catch (e) { /* gone */ }
      }
      await clearCompanion();
      return { ok: true };
    }

    case 'tile': {
      const state = await getState();
      const h = halves(msg.screen);
      if (msg.windowId != null) await setBounds(msg.windowId, h.left);
      if (await companionAlive(state)) await setBounds(state.companionWindowId, h.right);
      return { ok: true };
    }
  }
  return { error: `unknown message type: ${msg.type}` };
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async response
});

api.windows.onRemoved.addListener(async (windowId) => {
  const state = await getState();
  if (windowId === state.companionWindowId) await clearCompanion();
});

api.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (tabId === state.companionTabId) await clearCompanion();
});

updateBadge();
