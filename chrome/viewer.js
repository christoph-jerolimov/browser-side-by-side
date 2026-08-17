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
  activity: document.getElementById('activity'),
  message: document.getElementById('message'),
  freshness: document.getElementById('freshness'),
  openLink: document.getElementById('open-link'),
};

// ------------------------------------------------------------------- cache

const CACHE_KEY = 'ticketCache';
const CACHE_MAX_ENTRIES = 50;

async function readCache() {
  const obj = await api.storage.local.get({ [CACHE_KEY]: {} });
  return obj[CACHE_KEY] || {};
}

async function writeCache(key, issue) {
  const cache = await readCache();
  cache[key] = { issue, fetchedAt: new Date().toISOString() };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX_ENTRIES) {
    keys.sort((a, b) => Date.parse(cache[a].fetchedAt) - Date.parse(cache[b].fetchedAt));
    for (const stale of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete cache[stale];
  }
  await api.storage.local.set({ [CACHE_KEY]: cache });
}

function setFreshness(text, changed) {
  els.freshness.textContent = text;
  els.freshness.className = changed ? 'changed' : '';
}

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

  renderActivity(issue.activity);
}

function renderActivity(a) {
  els.activity.textContent = '';
  if (!a) return;
  const box = document.createElement('div');
  box.className = a.kind === 'status' ? 'activity status' : 'activity';
  const who = document.createElement('div');
  who.className = 'who';
  const what = a.kind === 'comment' ? '💬 Latest comment' : '🔄 Status update';
  who.textContent = `${what} — ${a.author}, ${relativeTime(a.when)}`;
  const body = document.createElement('div');
  body.className = 'body';
  const text = String(a.text || '');
  body.textContent = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  box.append(who, body);
  els.activity.appendChild(box);
}

function showMessage(html) {
  els.message.textContent = '';
  const box = document.createElement('div');
  box.className = 'note';
  box.append(...html);
  els.message.appendChild(box);
}

async function fetchIssue(base) {
  const fields = 'summary,status,issuetype,priority,assignee,reporter,updated,comment';
  const resp = await fetch(
    `${base}/rest/api/2/issue/${encodeURIComponent(ticketKey)}?fields=${fields}&expand=changelog`,
    { credentials: 'include', headers: { Accept: 'application/json' } },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Newest of: the latest comment, or the latest status transition from the
// changelog — whichever happened more recently.
function latestActivity(issue) {
  let latest = null;

  const comments = (issue.fields && issue.fields.comment && issue.fields.comment.comments) || [];
  if (comments.length) {
    const c = comments[comments.length - 1];
    latest = {
      kind: 'comment',
      author: (c.author && c.author.displayName) || 'Unknown',
      when: c.updated || c.created,
      text: typeof c.body === 'string' ? c.body : '(comment)',
    };
  }

  const histories = (issue.changelog && issue.changelog.histories) || [];
  for (let i = histories.length - 1; i >= 0; i--) {
    const h = histories[i];
    const item = (h.items || []).find((it) => it.field === 'status');
    if (!item) continue;
    if (!latest || Date.parse(h.created) > Date.parse(latest.when)) {
      latest = {
        kind: 'status',
        author: (h.author && h.author.displayName) || 'Unknown',
        when: h.created,
        text: `Status changed from "${item.fromString}" to "${item.toString}"`,
      };
    }
    break; // histories are chronological, so the first hit from the end is the newest
  }

  return latest;
}

// Compact snapshot of everything the viewer renders — this is what gets
// cached and compared, so unrelated API noise doesn't count as a change.
function toModel(issue) {
  const f = issue.fields || {};
  return {
    fields: {
      summary: f.summary,
      status: f.status && {
        name: f.status.name,
        statusCategory: f.status.statusCategory && { colorName: f.status.statusCategory.colorName },
      },
      issuetype: f.issuetype && { name: f.issuetype.name },
      priority: f.priority && { name: f.priority.name },
      assignee: f.assignee && { displayName: f.assignee.displayName },
      reporter: f.reporter && { displayName: f.reporter.displayName },
      updated: f.updated,
    },
    activity: latestActivity(issue),
  };
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

  // Render the last known state immediately, then refresh from Jira and only
  // repaint if something actually changed.
  const cached = (await readCache())[ticketKey];
  if (cached) {
    render(cached.issue);
    setFreshness(`Showing cached data from ${relativeTime(cached.fetchedAt)} — refreshing…`);
  }

  try {
    const model = toModel(await fetchIssue(base));
    const changed = !cached
      || JSON.stringify(cached.issue) !== JSON.stringify(model);
    if (changed) {
      render(model);
      setFreshness(cached ? 'Updated just now' : 'Loaded just now', !!cached);
    } else {
      setFreshness('Up to date — checked just now');
    }
    await writeCache(ticketKey, model);
  } catch (e) {
    if (cached) {
      setFreshness(`Couldn't refresh (${e.message}) — showing cached data from ${relativeTime(cached.fetchedAt)}`);
      return;
    }
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
