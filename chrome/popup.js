'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const followEl = document.getElementById('follow');
const statusEl = document.getElementById('status');

async function refresh() {
  const st = await api.runtime.sendMessage({ type: 'getStatus' });
  followEl.checked = !!st.following;
  statusEl.textContent = st.hasCompanion
    ? `Sidebar is open. Last: ${st.lastUrl || '—'}`
    : 'No sidebar window yet. Select a matching text (e.g. a ticket ID) or put the cursor on a link in your Google Doc, then click the pill.';
}

function screenInfo() {
  return {
    left: screen.availLeft || 0,
    top: screen.availTop || 0,
    width: screen.availWidth,
    height: screen.availHeight,
  };
}

followEl.addEventListener('change', async () => {
  await api.runtime.sendMessage({ type: 'setFollowing', value: followEl.checked });
  refresh();
});

document.getElementById('tile').addEventListener('click', async () => {
  const win = await api.windows.getCurrent();
  await api.runtime.sendMessage({ type: 'tile', windowId: win.id, screen: screenInfo() });
});

document.getElementById('close').addEventListener('click', async () => {
  await api.runtime.sendMessage({ type: 'closeCompanion' });
  refresh();
});

refresh();
