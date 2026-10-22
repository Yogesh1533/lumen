'use strict';
// Step 11 — side chat and split view.
//
// The second pane of Lumen is Lumen itself: an <iframe src="/?embed=1&chat=ID"> of this
// very page. Same origin, and it has NO sandbox attribute at all: the pane is a full
// user of the app — it sends messages, uses tools and approves tool calls.
//
// It is NOT the artifact preview. The artifact preview (public/index.html, #artFrame)
// keeps its opaque origin (sandbox="allow-scripts allow-forms", never the same origin)
// and is not touched by this file: two different elements, two different mechanisms.
//
// The embed mode is a MODE of this app: app.js knows it (isEmbed) and lays the page
// out for it (no sidebar, a compact header). There is no second copy of the app and
// no app-embed.js.
//
// The side chat is a chat record of its own. It never writes to the main chat: the
// only way into the main chat is the "Insert into chat" button, which adds a message
// of the user and lets the normal persist() save it.
//
// This file never replaces a function of app.js. It uses the hooks of app.js
// (onChatsRender, onPersist, beforeOpenChat, onPalette) and the two hooks that were
// there before (onOpenChat, onNewChat — chained, never replaced).

// ---- who this window is ----------------------------------------------------
// Every window has an id: the main window is 'main', every pane has an id of its own.
// The windows tell each other which chat they have open, so that two windows are
// never on the same chat: the app saves the whole list of messages of a chat every
// time, and two windows that write the same chat take each other's messages away.
const svQS = new URLSearchParams(location.search);
const svChatParam = (svQS.get('chat') || '').trim();   // the chat of the address of a pane
const svMyId = isEmbed ? 'pane-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4) : 'main';
let svMyChat = null;         // the chat this window has open
let svEmbedChat = isEmbed ? svChatParam : null;   // the chat of the address of a pane
const svPeers = new Map();   // the id of a window -> the chat it has open

// ---- the channel of the windows --------------------------------------------
// One BroadcastChannel for the whole app. Two kinds of messages:
//   {type:'pane', id, chat}  a window says which chat it has open;
//   {type:'sync', chat, list} the messages of a chat changed (chat) and/or the list
//                            of the chats changed (list).
const svChannelName = 'lumen';
let svChannel = null;
try { if (typeof BroadcastChannel !== 'undefined') svChannel = new BroadcastChannel(svChannelName); }
catch (e) { svChannel = null; }   // a browser without it has no cross-pane refresh, and no error
let svRx = 0;
window.__lumenRx = 0;      // the messages this window received (the test reads it)
window.__lumenPosts = [];  // what this window posted (the test reads it)

function svPost(msg) {
  window.__lumenPosts.push(msg);
  try { if (svChannel) svChannel.postMessage(msg); } catch (e) { /* the channel is gone */ }
}

// The posts of the refresh protocol are merged: a change that touches the list of the
// chats AND the messages of a chat is one message, not two.
let svPostTimer = null, svPending = null;
function svQueueSync(chat, list) {
  if (!svChannel) return;
  if (!svPending) svPending = { type: 'sync', chat: null, list: false };
  if (chat) svPending.chat = chat;
  if (list) svPending.list = true;
  if (svPostTimer) return;
  svPostTimer = setTimeout(() => {
    svPostTimer = null;
    const p = svPending; svPending = null;
    if (p) svPost(p);
  }, 25);
}

// > 0 while this window refreshes because of another window. A refresh that another
// window caused is never posted back — the post is DROPPED, not queued: a pane that
// answers the refresh of another pane would make the panes spin.
let svPeerRefresh = 0;

// The list of chats as the sidebar shows it — the fingerprint of the list. The order
// does not matter (the windows may sort the list differently), only what is in it.
const svListSig = () => JSON.stringify((state.chats || []).map((c) => [c.id, c.title, !!c.pinned, c.project || null]).sort());
let svLastSig = null;

// ---- the hooks of app.js ----------------------------------------------------
hooks.onChatsRender = () => {
  const sig = svListSig();
  const changed = svLastSig !== null && sig !== svLastSig;
  svLastSig = sig;                     // the baseline is always fresh
  // A local change that lands inside a refresh of another window loses its list
  // post (the baseline above is updated anyway): the next event re-syncs the list.
  if (changed && svPeerRefresh === 0) svQueueSync(null, true);
  if (isEmbed) svFillPicker();
};
hooks.onPersist = (chatId) => {
  if (chatId) svQueueSync(chatId, false);
  // The chat of this window may have just got its id: a new chat gets one when it is
  // saved for the first time, and no openChat is called then. The other windows must
  // learn that the chat is taken — otherwise a pane could open it, and the two
  // windows would take each other's messages away.
  const cur = state.chat && state.chat.id;
  if (cur !== svMyChat) svAnnounce(cur);
};
hooks.beforeOpenChat = (id) => {
  // The main window opens whatever the user clicks: it is the primary surface, and a
  // pane that had the chat moves away.
  if (!isEmbed) return;
  // A pane keeps the chat of its own address. The picker of the pane may switch it
  // (it sets svEmbedChat first), a pane never opens a chat of another window.
  if (id && id === svEmbedChat) return;
  if (id && id === (state.chat && state.chat.id)) return;
  return false;
};
hooks.onPalette = (items) => {
  // The chats of the user do not make sense in a pane (a pane keeps its own chat).
  if (isEmbed) return items.filter((it) => it.hint !== 'chat');
  items.push({ label: 'Side chat', hint: `${MOD}Alt+S`, run: () => svOpenSide() });
  items.push({ label: 'Split view', hint: `${MOD}Alt+P`, run: () => svToggleSplit() });
  return items;
};

// quickwins.js (loaded before this file) keeps the tab strip in sync through
// onOpenChat and onNewChat. They are chained, not replaced: a feature that took the
// hook of another feature away would break the tab strip.
const svPrevOpenChat = hooks.onOpenChat;
hooks.onOpenChat = (chat) => { if (svPrevOpenChat) svPrevOpenChat(chat); svAnnounce(chat && chat.id); };
const svPrevNewChat = hooks.onNewChat;
hooks.onNewChat = () => { if (svPrevNewChat) svPrevNewChat(); svAnnounce(null); };

// ---- the announcements ------------------------------------------------------
// A window says which chat it has open. A window that hears an id it does not know
// answers once with its own announcement, so that both sides learn each other. The
// answer is not answered again (the id is known from now on): no loop.
function svAnnounce(chat, force) {
  const id = chat || null;
  if (!force && id === svMyChat) return;
  svMyChat = id;
  svPost({ type: 'pane', id: svMyId, chat: id });
}

// A pane moves away when it learns that another window has the chat it has open: it
// opens a new empty chat and stops writing to that chat. The main window never moves
// away — it is the primary surface, and the user clicking a chat must not be undone.
function svMoveAway() {
  if (!isEmbed) return;
  svEmbedChat = null;   // the pane has no chat of its own any more
  try { newChat(); } catch (e) { /* the app is busy */ }
  toast('Another window has this chat');
}

if (svChannel) {
  svChannel.onmessage = (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    svRx++; window.__lumenRx = svRx;
    if (d.type === 'pane') {
      const known = svPeers.has(d.id);
      svPeers.set(d.id, d.chat || null);
      if (!known) svAnnounce(svMyChat, true);   // a new window: answer once
      if (d.chat && d.chat === svMyChat && d.id !== svMyId) svMoveAway();
      if (isEmbed) svFillPicker();
      return;
    }
    if (d.type === 'sync') svOnSync(d);
  };
  // Every window says who it is when it starts, so that a window that starts later
  // learns the others: the answer of the other window carries the chat it has open.
  // (A window that starts later answers with its own announcement, and the answer is
  // not answered again — the id is known from then on.)
  svAnnounce(null, true);
}

async function svOnSync(d) {
  if (d.list) {
    svPeerRefresh++;
    if (svPending) svPending.list = false;   // a refresh of another window is not ours to post
    try { await refreshChats(); } catch (e) { /* the server is gone */ } finally { svPeerRefresh--; }
  }
  if (d.chat) {
    const c = state.chat;
    if (c && c.id === d.chat && !state.streaming && !state.toolsBusy) {
      svPeerRefresh++;
      try { await openChat(d.chat); } catch (e) { /* the chat is gone */ } finally { svPeerRefresh--; }
    }
  }
}

// ---- the embed mode --------------------------------------------------------
// A pane shows the chat of its own address. It is a full user of the app, but it
// keeps its chat: the "continue the last chat" of the app and the restored tabs
// must not drag the pane to another conversation.
if (isEmbed) {
  const head = document.querySelector('header');
  if (head) {
    const sel = document.createElement('select');
    sel.id = 'embedChatSel';
    sel.title = 'The chat of this pane';
    sel.onchange = () => svSwitchChat(sel.value);
    head.insertBefore(sel, head.firstChild);
  }
  state.ready.then(async () => {
    if (svEmbedChat) {
      try { await openChat(svEmbedChat); }
      catch (e) { svEmbedChat = null; newChat(); toast('That chat does not exist'); }
    }
    // The announcements of the other windows arrive in the first moments: the picker
    // must not offer a chat that another window has open.
    setTimeout(() => svFillPicker(), 300);
    svAnnounce(state.chat && state.chat.id, true);
  });
}

// The chats that another window has open. A pane never offers them and never opens
// them: two windows on one chat would take each other's messages away.
function svTakenChats() {
  const s = new Set();
  for (const [, c] of svPeers) if (c) s.add(c);
  return s;
}

async function svFillPicker() {
  if (!isEmbed) return;
  const sel = document.getElementById('embedChatSel');
  if (!sel) return;
  let list = [];
  try { list = await api('/chats'); } catch (e) { return; }
  const taken = svTakenChats();
  const cur = state.chat && state.chat.id;
  sel.innerHTML = '';
  for (const c of list) {
    if (taken.has(c.id)) continue;      // another window has it open
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.title || 'New Chat';
    if (c.id === cur) o.selected = true;
    sel.appendChild(o);
  }
}

// The user picks another chat for the pane: the pane switches to it.
async function svSwitchChat(id) {
  if (!id) return;
  if (svTakenChats().has(id)) return toast('Another window has this chat');
  svEmbedChat = id;
  try { history.replaceState(null, '', '/?embed=1&chat=' + encodeURIComponent(id)); } catch (e) { /* the address stays */ }
  try { await openChat(id); } catch (e) { toast('That chat does not exist'); }
}

// ---- the side chat ---------------------------------------------------------
// The snapshot is bounded: the last 20 messages of the main chat, oldest first, and
// at most 20,000 characters in all. The seed says so — the cap is visible in it.
const svSnapMessages = 20;
const svSnapChars = 20000;
let svSide = null;   // { id, title, mainId }

function svSnapshot(messages) {
  const picked = (messages || []).slice(-svSnapMessages);
  const lines = [];
  for (const m of picked) {
    const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : (m.role || 'Message');
    const text = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (text) lines.push('[' + who + ']: ' + text);
  }
  const intro = 'This is a side question about the conversation above. Answer briefly; this is a side question, not the main conversation. The question itself comes in the next message — answer that one, briefly.';
  const cap = '[Snapshot of the main chat: the last ' + svSnapMessages + ' messages, oldest first. At most ' +
    svSnapMessages + ' messages and ' + svSnapChars.toLocaleString('en-US') + ' characters go into the snapshot.';
  const beginMark = '--- begin snapshot ---', endMark = '--- end snapshot ---';
  // The head says how much of the snapshot is really in it. Its length must be known
  // before the body is cut, so the widest possible head is measured first: the seed
  // can then never be longer than the cap.
  const headFor = (shown, chars) => cap + ' ' + shown + ' of ' + svSnapMessages + ' messages and ' +
    chars.toLocaleString('en-US') + ' of ' + svSnapChars.toLocaleString('en-US') + ' characters are shown here.]';
  const widest = headFor(svSnapMessages, svSnapChars).length;
  const room = svSnapChars - intro.length - 2 - widest - 1 - beginMark.length - 1 - 1 - endMark.length;
  let body = '', shown = 0;
  for (const l of lines) {
    if (body.length + l.length + (body ? 1 : 0) > room) break;
    body += (body ? '\n' : '') + l;
    shown++;
  }
  const head = headFor(shown, body.length);
  return intro + '\n\n' + head + '\n' + beginMark + '\n' + body + '\n' + endMark;
}

async function svOpenSide() {
  const main = state.chat || { messages: [] };
  const title = ('Side chat — ' + (main.title || 'New Chat')).slice(0, 48);
  let made;
  try {
    made = await api('/chats', { method: 'POST', body: {
      title: title,
      model: main.model || ($('#modelSelect') ? $('#modelSelect').value : ''),
      system: '', style: main.style || '',
      project: main.project || null,
      messages: [{ role: 'user', content: svSnapshot(main.messages) }]
    } });
  } catch (e) { return toast('Could not open the side chat: ' + e.message); }
  // The side chat keeps its name — the app must not give it a title of its own.
  try { await api('/chats/' + made.id, { method: 'PUT', body: { title: title, titled: true } }); } catch (e) { /* the name stays as it is */ }
  svSide = { id: made.id, title: title, mainId: main.id || null };
  const frame = $('#sideFrame');
  frame.src = '/?embed=1&chat=' + encodeURIComponent(made.id);
  $('#sidePane').hidden = false;
  $('#sideTitle').textContent = title;
  refreshChats();
  toast('Side chat opened');
}

async function svInsert() {
  if (!svSide) return;
  let rec;
  try { rec = await api('/chats/' + svSide.id); } catch (e) { return toast('The side chat is gone'); }
  const msgs = rec.messages || [];
  const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && (m.content || '').trim());
  if (!answer) return toast('The side chat has no answer yet');
  // The answer goes into the chat the side chat was opened from.
  if (svSide.mainId && (!state.chat || state.chat.id !== svSide.mainId)) {
    try { await openChat(svSide.mainId); } catch (e) { /* the chat is gone */ }
  }
  const content = '[Side chat] ' + svSide.title + '\n\n' + answer.content;
  state.chat.messages.push({ role: 'user', content: content });
  renderAll();
  try { await persist(); } catch (e) { return toast('Could not save: ' + e.message); }
  toast('Inserted into the chat');
}

// ---- the split view --------------------------------------------------------
// The second pane is Lumen itself and it has a chat of its own: a chat that the main
// window does not have open and that no other pane has open. Two windows on the same
// chat would take each other's messages away (the app saves the whole list of
// messages every time), so the panes are always apart. The user can point the pane
// at another chat with the picker of the pane.
async function svToggleSplit() {
  const pane = $('#splitPane');
  if (pane && !pane.hidden) { pane.hidden = true; return; }
  const id = await svPickChatForPane();
  if (!id) return toast('There is no chat for the second pane');
  const frame = $('#splitFrame');
  frame.src = '/?embed=1&chat=' + encodeURIComponent(id);
  pane.hidden = false;
  $('#splitTitle').textContent = 'Split view';
}

async function svPickChatForPane() {
  const mine = state.chat && state.chat.id;
  const taken = svTakenChats();
  let list = [];
  try { list = await api('/chats'); } catch (e) { /* no list */ }
  // The most recent chat that no other window has open. The list of the server is
  // sorted with the pinned chats first, so the order of the list is not the order of
  // the chats — the stamp decides which one the pane gets.
  const candidates = list
    .filter((c) => c.id !== mine && !taken.has(c.id))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (candidates.length) return candidates[0].id;
  // Every chat of the user is in use: make one for the pane (a chat of its own).
  try {
    const made = await api('/chats', { method: 'POST', body: {
      title: 'New Chat', model: $('#modelSelect') ? $('#modelSelect').value : '',
      system: '', style: '', project: null, messages: []
    } });
    return made.id;
  } catch (e) { return null; }
}

// ---- the buttons and the shortcuts -----------------------------------------
const svSideBtn = $('#sideChatBtn');
if (svSideBtn) svSideBtn.onclick = () => svOpenSide();
const svSplitBtn = $('#splitBtn');
if (svSplitBtn) svSplitBtn.onclick = () => svToggleSplit();
const svInsertBtn = $('#sideInsert');
if (svInsertBtn) svInsertBtn.onclick = () => svInsert();
const svSideClose = $('#sideClose');
if (svSideClose) svSideClose.onclick = () => { $('#sidePane').hidden = true; };
const svSplitClose = $('#splitClose');
if (svSplitClose) svSplitClose.onclick = () => { $('#splitPane').hidden = true; };

SHORTCUTS.push([`${MOD}Alt+S`, 'Open the side chat']);
SHORTCUTS.push([`${MOD}Alt+P`, 'Open the split view']);
window.addEventListener('keydown', (e) => {
  if (isEmbed) return;   // a pane is a pane — no pane in a pane
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); svOpenSide(); }
  else if (mod && e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); svToggleSplit(); }
});
