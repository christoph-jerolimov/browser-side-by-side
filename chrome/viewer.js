// Docs Side-by-Side — Jira ticket viewer (sidebar page).
//
// Fetches the ticket from the Jira REST API using the browser's existing
// Jira session cookies (host permission in the manifest makes the
// cross-origin request possible) and renders the key fields with colored
// issue-type / priority / status badges.
'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const params = new URLSearchParams(location.search);
const ticketKey = params.get('key') || '';
const jiraUrl = params.get('url') || '';

const els = {
  keyLink: document.getElementById('key-link'),
  summary: document.getElementById('summary'),
  badges: document.getElementById('badges'),
  meta: document.getElementById('meta'),
  message: document.getElementById('message'),
  openLink: document.getElementById('open-link'),
};

// Jira-like colors, keyed by lowercased name (fallbacks per badge kind).
const TYPE_COLORS = {
  bug: '#e5493a',
  story: '#63ba3c',
  task: '#4bade8',
  'sub-task': '#4bade8',
  subtask: '#4bade8',
  epic: '#904ee2',
  feature: '#904ee2',
};
const PRIORITY_COLORS = {
  blocker: '#ae2a19',
  highest: '#d04437',
  critical: '#d04437',
  high: '#f15c75',
  major: '#f15c75',
  medium: '#f79232',
  normal: '#f79232',
  low: '#57a55a',
  minor: '#57a55a',
  lowest: '#6b778c',
};
// Jira status categories: "blue-gray" = To Do, "yellow" = In Progress, "green" = Done.
const STATUS_CATEGORY_COLORS = {
  'blue-gray': '#42526e',
  yellow: '#0065ff',
  green: '#00875a',
};

function colorFor(map, name, fallback) {
  return map[String(name || '').toLowerCase()] || fallback;
}

function badge(kind, text, color) {
  const el = document.createElement('span');
  el.className = 'badge';
  el.style.background = color;
  el.title = kind;
  const cat = document.createElement('span');
  cat.className = 'cat';
  cat.textContent = `${kind}:`;
  el.append(cat, document.createTextNode(` ${text}`));
  return el;
}

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function render(issue) {
  const f = issue.fields || {};
  els.summary.classList.remove('spinner');
  els.summary.textContent = f.summary || '(no summary)';

  els.badges.textContent = '';
  if (f.issuetype && f.issuetype.name) {
    els.badges.appendChild(badge('Type', f.issuetype.name,
      colorFor(TYPE_COLORS, f.issuetype.name, '#6b778c')));
  }
  if (f.priority && f.priority.name) {
    els.badges.appendChild(badge('Priority', f.priority.name,
      colorFor(PRIORITY_COLORS, f.priority.name, '#6b778c')));
  }
  if (f.status && f.status.name) {
    const catColor = f.status.statusCategory && f.status.statusCategory.colorName;
    els.badges.appendChild(badge('Status', f.status.name,
      colorFor(STATUS_CATEGORY_COLORS, catColor, '#42526e')));
  }

  els.meta.textContent = '';
  const rows = [
    ['Assignee', f.assignee ? f.assignee.displayName : 'Unassigned'],
    ['Reporter', f.reporter ? f.reporter.displayName : null],
    ['Updated', f.updated ? `${relativeTime(f.updated)} (${new Date(f.updated).toLocaleString()})` : null],
  ];
  for (const [label, value] of rows) {
    if (value == null) continue;
    const row = document.createElement('p');
    row.className = 'meta';
    const b = document.createElement('b');
    b.textContent = `${label}: `;
    row.append(b, document.createTextNode(value));
    els.meta.appendChild(row);
  }
}

function showMessage(html) {
  els.message.textContent = '';
  const box = document.createElement('div');
  box.className = 'note';
  box.append(...html);
  els.message.appendChild(box);
}

async function fetchIssue(base) {
  const fields = 'summary,status,issuetype,priority,assignee,reporter,updated';
  const resp = await fetch(
    `${base}/rest/api/2/issue/${encodeURIComponent(ticketKey)}?fields=${fields}`,
    { credentials: 'include', headers: { Accept: 'application/json' } },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function init() {
  document.title = `${ticketKey} — Docs Side-by-Side`;
  els.keyLink.textContent = ticketKey;
  els.keyLink.href = jiraUrl;
  els.openLink.href = jiraUrl;

  let base = '';
  try {
    const cfg = await api.runtime.sendMessage({ type: 'getConfig' });
    base = (cfg && cfg.jiraBase) || '';
  } catch (e) { /* fall through to error below */ }

  if (!ticketKey || !base) {
    els.summary.classList.remove('spinner');
    els.summary.textContent = ticketKey || '(no ticket)';
    const a = document.createElement('a');
    a.href = jiraUrl;
    a.textContent = 'Open in Jira';
    showMessage([document.createTextNode('No jiraBase configured in config.json. '), a]);
    return;
  }

  try {
    const issue = await fetchIssue(base);
    render(issue);
  } catch (e) {
    els.summary.classList.remove('spinner');
    els.summary.textContent = ticketKey;
    const a = document.createElement('a');
    a.href = jiraUrl;
    a.target = '_blank';
    a.textContent = 'open the ticket in Jira';
    showMessage([
      document.createTextNode(
        `Couldn't load ticket data (${e.message}). You may need to log in to Jira in this browser — `),
      a,
      document.createTextNode('.'),
    ]);
  }
}

init();
