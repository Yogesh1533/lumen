// Step 12 — the workspace: trusted folders, the folder and the permission mode of a
// chat, approval cards with the diff of an edit and the exact command of the shell, the
// Changes pane (diffs, revert), the Terminal pane (the output of the commands, stop),
// the "needs your input" badge and notification, and the scheduled tasks.
//
// A classic script loaded after app.js (it shares its global scope). It only uses the
// hooks of app.js and chains the ones that other features use too.
//
// THIS IS NOT A SANDBOX. The server keeps the model inside the folder of the chat and
// asks for an approval token for every write (in the "ask" mode) and every command; the
// page shows the user exactly what that token approves.

const wsState = {
  info: { folders: [], projects: {}, schedules: [], limits: {} },
  cfg: { folder: null, mode: 'ask' },   // the workspace of the open chat
  waiting: new Map(),                    // a chat (id or object) -> the calls waiting for approval
  polling: null,                         // the poller of the Terminal pane
  lastRuns: new Map(),                   // the last run of every scheduled task (for the notice)
  tab: 'changes',
};

// The session of a chat on the server: its id, or — before the chat is saved, and in a
// temporary chat — an id of the page that is never saved.
function wsSid(c) {
  c = c || state.chat;
  if (c.id) return c.id;
  if (!c._wsSid) c._wsSid = 'tmp-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  return c._wsSid;
}

async function wsLoad() {
  try { wsState.info = await api('/workspace'); } catch (e) { /* the server is older */ }
  wsRenderBar();
}

// ---- the bar above the composer ---------------------------------------------
function wsRenderBar() {
  const bar = $('#wsBar');
  if (!bar) return;
  const folders = wsState.info.folders || [];
  bar.hidden = !folders.length;
  const sel = $('#wsFolder');
  sel.innerHTML = '<option value="">No folder</option>' + folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  sel.value = wsState.cfg.folder && folders.includes(wsState.cfg.folder) ? wsState.cfg.folder : '';
  $('#wsMode').value = wsState.cfg.mode === 'auto-edit' ? 'auto-edit' : 'ask';
  $('#wsMode').disabled = !sel.value;
}

// The workspace of the chat that was opened (or of the new chat).
async function wsLoadChat() {
  const c = state.chat;
  if (c.id) {
    try { wsState.cfg = await api('/workspace/session/' + c.id); } catch (e) { wsState.cfg = { folder: null, mode: 'ask' }; }
  } else {
    // A new chat of a project starts in the folder of the project.
    const pf = c.project && wsState.info.projects && wsState.info.projects[c.project];
    wsState.cfg = c._wsCfg || { folder: pf || null, mode: 'ask' };
  }
  wsRenderBar();
  wsRefreshChanges();
}

async function wsSaveCfg() {
  const c = state.chat;
  const cfg = { folder: $('#wsFolder').value || null, mode: $('#wsMode').value };
  wsState.cfg = cfg;
  c._wsCfg = cfg;
  try { wsState.cfg = await api('/workspace/session/' + wsSid(c), { method: 'PUT', body: cfg }); }
  catch (e) { toast(e.message); }
  wsRenderBar();
  // The tools of the model change with the folder (no folder: no workspace tools).
  updateToolsBtn();
}
$('#wsFolder').onchange = wsSaveCfg;
$('#wsMode').onchange = wsSaveCfg;

// A chat that is saved for the first time takes its workspace along: the session of the
// page becomes the id of the chat.
// Both the save hook and the tool policy adopt; the second one waits for the first.
function wsAdopt(c) {
  if (c._wsAdopting) return c._wsAdopting;
  if (!c.id || !c._wsSid) return Promise.resolve();
  const cfg = c._wsCfg || wsState.cfg;
  delete c._wsSid;
  c._wsAdopting = (async () => {
    if (cfg && cfg.folder) {
      try { await api('/workspace/session/' + c.id, { method: 'PUT', body: cfg }); } catch (e) { /* the next change sets it */ }
    }
  })();
  return c._wsAdopting;
}

// ---- the tools of the model ---------------------------------------------------
// The workspace tools only reach the model when the chat has a folder.
const wsPrevToolServer = hooks.toolServer;
hooks.toolServer = (srv) => {
  if (wsPrevToolServer && wsPrevToolServer(srv) === false) return false;
  if (srv.id === 'workspace') return !!wsState.cfg.folder;
};

// How a workspace call is approved. The server makes the preview (the diff of an edit,
// the exact command) and an approval token for exactly these arguments; reads need no
// token. A write in the "ask" mode and every command are asked every time — there is no
// "Always allow" for them.
const wsPrevPolicy = hooks.toolPolicy;
hooks.toolPolicy = async (call, c) => {
  if (call.server !== 'workspace') return wsPrevPolicy ? wsPrevPolicy(call, c) : null;
  // A new chat is saved first, so its changes are kept under its own id.
  if (!c.id && !state.temp && c === state.chat) { await persist(); await wsAdopt(c); }
  const session = wsSid(c);
  const r = await api('/workspace/preview', { method: 'POST', body: { session, tool: call.tool, arguments: call.arguments } });
  if (r.error) return { error: r.error };
  if (!r.token) return { auto: true, body: { session } };
  if (call.tool === 'shell') wsWatchRuns(session);
  if (r.needed) return { ask: true, noAlways: true, preview: r.text, previewKind: r.kind, body: { session, approval: r.token } };
  // Auto-edit: the edit runs, and the card still shows what it did.
  return { auto: true, preview: r.text, previewKind: r.kind, body: { session, approval: r.token } };
};

const wsPrevResult = hooks.onToolResult;
hooks.onToolResult = (call, c) => {
  if (wsPrevResult) wsPrevResult(call, c);
  if (call.server !== 'workspace') return;
  if (c === state.chat) wsRefreshChanges();
};

// The Stop button stops the commands of the chat too.
const wsPrevCancel = hooks.onCancelTools;
hooks.onCancelTools = () => {
  if (wsPrevCancel) wsPrevCancel();
  api('/workspace/session/' + wsSid() + '/kill', { method: 'POST' }).catch(() => {});
};

// ---- needs your input ---------------------------------------------------------
// A chat with a call that waits for approval gets a badge in the sidebar, and a
// notification is shown when the tab is in the background.
const wsPrevAwait = hooks.onAwait;
hooks.onAwait = (call, c, waiting) => {
  if (wsPrevAwait) wsPrevAwait(call, c, waiting);
  const key = c.id || c;
  const set = wsState.waiting.get(key) || new Set();
  if (waiting) set.add(call.id); else set.delete(call.id);
  if (set.size) wsState.waiting.set(key, set); else wsState.waiting.delete(key);
  wsBadges();
  if (waiting && document.hidden) wsNotify('Lumen needs your input', `${call.serverName} › ${call.tool} is waiting for your approval`, call.id);
};
function wsWaitingCount(chatId) { const s = wsState.waiting.get(chatId); return s ? s.size : 0; }
function wsBadges() {
  const items = [...document.querySelectorAll('#chatList .chat')];
  items.forEach((el, i) => {
    const c = state.chats[i];
    const old = el.querySelector('.wait');
    const n = c ? wsWaitingCount(c.id) : 0;
    if (!n) { if (old) old.remove(); return; }
    if (old) { old.textContent = 'needs input'; return; }
    const b = document.createElement('span');
    b.className = 'wait'; b.textContent = 'needs input'; b.title = n + ' tool call(s) waiting for your approval';
    el.querySelector('.t').after(b);
  });
  let any = 0;
  for (const s of wsState.waiting.values()) any += s.size;
  document.title = (any ? '(!) ' : '') + document.title.replace(/^\(!\) /, '');
}
function wsNotify(title, body, tag) {
  // In the desktop app the notification is a native one.
  if (window.lumenDesktop) { window.lumenDesktop.notify(title, body); return; }
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { /* no notifications here */ }
}

const wsPrevChats = hooks.onChatsRender;
hooks.onChatsRender = () => { if (wsPrevChats) wsPrevChats(); wsBadges(); };
const wsPrevOpen = hooks.onOpenChat;
hooks.onOpenChat = (chat) => { if (wsPrevOpen) wsPrevOpen(chat); wsLoadChat(); };
const wsPrevNew = hooks.onNewChat;
hooks.onNewChat = () => { if (wsPrevNew) wsPrevNew(); wsLoadChat(); };
const wsPrevPersist = hooks.onPersist;
hooks.onPersist = (id) => { if (wsPrevPersist) wsPrevPersist(id); wsAdopt(state.chat); };

// ---- the Changes pane -----------------------------------------------------------
function wsDiffHTML(text) {
  return esc(text).split('\n').map((l) => {
    if (/^(\+\+\+|---)/.test(l)) return `<span class="dl-hunk">${l}</span>`;
    if (l.startsWith('+')) return `<span class="dl-add">${l}</span>`;
    if (l.startsWith('-')) return `<span class="dl-del">${l}</span>`;
    if (l.startsWith('@@')) return `<span class="dl-hunk">${l}</span>`;
    return l;
  }).join('\n');
}
async function wsRefreshChanges() {
  let list = [];
  try { list = await api('/workspace/changes/' + wsSid()); } catch (e) { list = []; }
  const changed = list.filter((f) => f.changed);
  $('#wsChangesN').textContent = changed.length;
  const box = $('#wsChangeList');
  box.innerHTML = '';
  $('#wsChangesMsg').textContent = changed.length ? `${changed.length} file(s) changed in this chat` : 'No changes in this chat';
  $('#wsRevertAll').disabled = !list.length;
  for (const f of list) {
    const d = document.createElement('div');
    d.className = 'wsfile'; d.dataset.path = f.path;
    const what = !f.changed ? 'unchanged' : !f.existed ? 'new file' : !f.exists ? 'deleted' : 'changed';
    d.innerHTML = `<div class="wh"><b title="${esc(f.path)}">${esc(f.rel)}</b><span class="sub">${what}</span><button type="button" class="ghost" data-a="rv">Revert</button></div>
      ${f.diff ? `<pre class="diff">${wsDiffHTML(f.diff)}</pre>` : ''}`;
    d.querySelector('[data-a=rv]').onclick = () => wsRevert(f.path);
    box.appendChild(d);
  }
  return list;
}
async function wsRevert(p) {
  const msg = p ? 'Put this file back the way it was before this chat changed it?' : 'Put every file back the way it was before this chat changed it?';
  if (!confirm(msg)) return;
  try { await api('/workspace/changes/' + wsSid() + '/revert', { method: 'POST', body: p ? { path: p } : {} }); toast(p ? 'File reverted' : 'All files reverted'); }
  catch (e) { toast(e.message); }
  wsRefreshChanges();
}
$('#wsRevertAll').onclick = () => wsRevert(null);

function wsOpenPane(tab) {
  wsState.tab = tab;
  $('#wsPane').hidden = false;
  $('#wsChanges').hidden = tab !== 'changes';
  $('#wsTerm').hidden = tab !== 'term';
  $('#wsTabChanges').classList.toggle('on', tab === 'changes');
  $('#wsTabTerm').classList.toggle('on', tab === 'term');
  if (tab === 'changes') wsRefreshChanges(); else wsRefreshRuns();
}
$('#wsChangesBtn').onclick = () => wsOpenPane('changes');
$('#wsTermBtn').onclick = () => wsOpenPane('term');
$('#wsTabChanges').onclick = () => wsOpenPane('changes');
$('#wsTabTerm').onclick = () => wsOpenPane('term');
$('#wsPaneClose').onclick = () => { $('#wsPane').hidden = true; };

// ---- the Terminal pane ------------------------------------------------------------
async function wsRefreshRuns() {
  let runs = [];
  try { runs = await api('/workspace/runs/' + wsSid()); } catch (e) { runs = []; }
  const box = $('#wsRunList');
  box.innerHTML = runs.length ? '' : '<p class="sub">No commands in this chat yet.</p>';
  for (const r of runs.slice().reverse()) {
    const d = document.createElement('div');
    d.className = 'wsrun ' + r.status; d.dataset.run = r.id;
    const dur = ((r.ended || Date.now()) - r.started) / 1000;
    d.innerHTML = `<div class="wh"><code>$ ${esc(r.command)}</code><span class="sub">${esc(r.status)} · ${dur.toFixed(1)} s${r.code != null ? ' · exit ' + r.code : ''}</span>
      ${r.status === 'running' ? '<button type="button" class="deny" data-a="kill">Stop</button>' : ''}</div>
      <pre>${esc(r.output || '')}${r.truncated ? '\n[output cut at 100 KB]' : ''}</pre>`;
    const k = d.querySelector('[data-a=kill]');
    if (k) k.onclick = async () => { await api('/workspace/runs/' + r.id + '/kill', { method: 'POST' }).catch(() => {}); wsRefreshRuns(); };
    box.appendChild(d);
  }
  return runs;
}
// While a command of the chat runs, the Terminal pane shows its output as it comes.
function wsWatchRuns(session) {
  if (wsState.polling) return;
  let idle = 0;
  wsState.polling = setInterval(async () => {
    if (wsSid() !== session) { clearInterval(wsState.polling); wsState.polling = null; return; }
    const runs = await wsRefreshRuns();
    if (runs.some((r) => r.status === 'running')) { idle = 0; if ($('#wsPane').hidden || wsState.tab !== 'term') wsOpenPane('term'); }
    // The approval may take a while: the poller waits for it (up to ten minutes).
    else if (++idle > 1200) { clearInterval(wsState.polling); wsState.polling = null; }
    else if (idle > 4 && !state.toolsBusy) { clearInterval(wsState.polling); wsState.polling = null; }
  }, 500);
}

// ---- the Workspace dialog -----------------------------------------------------------
function wsRenderDialog() {
  const W = wsState.info;
  const fl = $('#wsFolders');
  fl.innerHTML = W.folders.length ? '' : '<p class="sub">No trusted folder yet.</p>';
  for (const f of W.folders) {
    const d = document.createElement('div'); d.className = 'allow';
    d.innerHTML = `<code>${esc(f)}</code><button type="button" class="ghost">Remove</button>`;
    d.querySelector('button').onclick = async () => {
      if (!confirm(`Stop trusting ${f}? Chats that use it lose access to it.`)) return;
      try { wsState.info = await api('/workspace/folders/remove', { method: 'POST', body: { path: f } }); } catch (e) { toast(e.message); }
      wsAfterChange();
    };
    fl.appendChild(d);
  }
  const opts = '<option value="">No folder</option>' + W.folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
  $('#wsProjRow').hidden = !state.project || !W.folders.length;
  $('#wsProjFolder').innerHTML = opts;
  $('#wsProjFolder').value = (state.project && W.projects[state.project]) || '';
  $('#tkFolder').innerHTML = '<option value="">No folder</option>' + W.folders.map((f) => `<option value="${esc(f)}">Folder: ${esc(f)}</option>`).join('');
  $('#tkModel').innerHTML = state.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');
  if ($('#modelSelect').value) $('#tkModel').value = $('#modelSelect').value;
  // The tools a task may use: the ones set to "Always allow", minus the ones that change
  // files or run a command (the server refuses those anyway).
  const allowed = [...toolAllow()].filter((k) => !/^workspace\/(fs_write|fs_edit|shell)$/.test(k));
  $('#tkTools').innerHTML = allowed.length
    ? 'Tools the task may use: ' + allowed.map((k) => { const [sid, ...t] = k.split('/'); const s = state.mcp.find((x) => x.id === sid); return `<label class="check"><input type="checkbox" data-k="${esc(k)}"> ${esc(s ? s.name : sid)} › ${esc(t.join('/'))}</label>`; }).join(' ')
    : 'No tools: the task answers from the model alone (set a tool to “Always allow” to offer it here).';
  const tl = $('#wsTasks');
  tl.innerHTML = W.schedules.length ? '' : '<p class="sub">No scheduled task.</p>';
  for (const t of W.schedules) {
    const d = document.createElement('div'); d.className = 'allow'; d.dataset.task = t.id;
    const when = t.kind === 'daily' ? `every day at ${t.at}` : `every ${t.every} min`;
    const last = t.lastRun ? ` · last run ${new Date(t.lastRun).toLocaleString()} (${t.lastStatus})` : '';
    d.innerHTML = `<code>${esc(t.name)}</code><span class="sub">${esc(when)} · ${esc(t.model)}${esc(last)}</span>
      <label class="toggle"><input type="checkbox" data-a="en" ${t.enabled ? 'checked' : ''}> On</label>
      <button type="button" class="ghost" data-a="run">Run now</button><button type="button" class="ghost" data-a="rm">Delete</button>`;
    d.querySelector('[data-a=en]').onchange = async (e) => { await api('/workspace/schedules/' + t.id, { method: 'PUT', body: { enabled: e.target.checked } }).catch((x) => toast(x.message)); wsAfterChange(); };
    d.querySelector('[data-a=run]').onclick = async () => {
      toast('Running ' + t.name + '…');
      try { const r = await api('/workspace/schedules/' + t.id + '/run', { method: 'POST' }); await refreshChats(); if (r.chat) toast('Done: the answer is in a new chat'); } catch (e) { toast(e.message); }
      wsAfterChange();
    };
    d.querySelector('[data-a=rm]').onclick = async () => { if (!confirm('Delete the task ' + t.name + '?')) return; await api('/workspace/schedules/' + t.id, { method: 'DELETE' }).catch(() => {}); wsAfterChange(); };
    tl.appendChild(d);
  }
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#wsNotifyState').textContent = perm === 'granted' ? 'Notifications are allowed.' : perm === 'denied' ? 'Notifications are blocked in this browser.' : perm === 'unsupported' ? 'This browser has no notifications.' : '';
  $('#wsNotify').hidden = perm === 'granted' || perm === 'unsupported';
}
async function wsAfterChange() {
  await wsLoad();
  await loadMcp();
  wsRenderDialog();
  wsLoadChat();
}
$('#wsBtn').onclick = async () => { await wsLoad(); await loadMcp(); wsRenderDialog(); $('#wsDlg').showModal(); };
$('#wsClose').onclick = () => $('#wsDlg').close();
$('#wsAddFolder').onclick = async () => {
  const p = $('#wsPath').value.trim();
  $('#wsFolderMsg').textContent = '';
  if (!p) return;
  try {
    wsState.info = await api('/workspace/folders', { method: 'POST', body: { path: p } });
    $('#wsPath').value = '';
    $('#wsFolderMsg').textContent = 'Trusted. Pick it for a chat in the bar above the message box.';
  } catch (e) { $('#wsFolderMsg').textContent = e.message; }
  wsAfterChange();
};
$('#wsPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#wsAddFolder').click(); } });
$('#wsProjFolder').onchange = async () => {
  if (!state.project) return;
  try { wsState.info = await api('/workspace/projects/' + state.project, { method: 'PUT', body: { folder: $('#wsProjFolder').value || null } }); } catch (e) { toast(e.message); }
  wsAfterChange();
};
$('#wsNotify').onclick = async () => { try { await Notification.requestPermission(); } catch (e) { /* no */ } wsRenderDialog(); };
$('#tkKind').onchange = () => { $('#tkEvery').hidden = $('#tkKind').value !== 'interval'; $('#tkAt').hidden = $('#tkKind').value !== 'daily'; };
$('#tkAdd').onclick = async () => {
  const body = { name: $('#tkName').value, prompt: $('#tkPrompt').value, model: $('#tkModel').value, kind: $('#tkKind').value,
    every: Number($('#tkEvery').value), at: $('#tkAt').value, folder: $('#tkFolder').value || null,
    allowTools: [...document.querySelectorAll('#tkTools input:checked')].map((x) => x.dataset.k) };
  $('#tkMsg').textContent = '';
  try { await api('/workspace/schedules', { method: 'POST', body }); $('#tkName').value = ''; $('#tkPrompt').value = ''; $('#tkMsg').textContent = 'Task added.'; }
  catch (e) { $('#tkMsg').textContent = e.message; }
  wsAfterChange();
};

// ---- the answers of the scheduled tasks -------------------------------------------
// The server runs the tasks; the page notices a new run, refreshes the chats and says so.
async function wsPollTasks() {
  let info;
  try { info = await api('/workspace'); } catch (e) { return; }
  wsState.info = info;
  let fresh = false;
  for (const t of info.schedules || []) {
    const before = wsState.lastRuns.get(t.id);
    if (before !== undefined && t.lastRun && t.lastRun !== before) {
      fresh = true;
      toast(`Scheduled task “${t.name}” ran — the answer is in a new chat`);
      if (document.hidden) wsNotify('Lumen: ' + t.name, 'The scheduled task ran; the answer is in a new chat', 'task-' + t.id);
    }
    wsState.lastRuns.set(t.id, t.lastRun || 0);
  }
  if (fresh) refreshChats();
}

if (!isEmbed) setInterval(wsPollTasks, 15000);
state.ready.then(async () => { await wsLoad(); await wsLoadChat(); if (!isEmbed) wsPollTasks(); });
