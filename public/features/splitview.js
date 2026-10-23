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

// ---- the invariant ---------------------------------------------------------
// At no time may two windows (the main window, the split pane, the side pane) have
// the same chat open: the app saves the whole list of the messages of a chat every
// time, so two windows on one chat take each other's messages away — the message of
// the main window is gone from the server. Three rules keep the windows apart:
//
//   1. A pane does not act before it knows: it asks the other windows which chat
//      they have open (the "who has what" round) and waits for their answers before
//      it opens the chat of its address. The wait is bounded: the pane must still
//      come up when nobody answers.
//   2. A window says which chat it has open, and a pane that hears that another
//      window has the chat of its address gives it up — and takes it out of its
//      address, so that a reloaded pane cannot take it back.
//   3. A conflict that two windows reach at the same time has one resolution: the
//      main window always keeps the chat (the user clicking a chat in the sidebar
//      must not be undone), and between two panes the one with the smaller id keeps
//      it. Both sides can compute it: they know both ids.

// ---- who this window is ----------------------------------------------------
// Every window has an id: the main window is 'main', every pane has an id of its own.
// The windows tell each other which chat they have open, so that two windows are
// never on the same chat.
const svQS = new URLSearchParams(location.search);
const svChatParam = (svQS.get('chat') || '').trim();   // the chat of the address of a pane
const svMyId = isEmbed ? 'pane-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4) : 'main';
let svMyChat = null;         // the chat this window has open
let svEmbedChat = isEmbed ? svChatParam : null;   // the chat of the address of a pane
const svPeers = new Map();   // the id of a window -> { chat, claim, frame }

// The id of this window (the main window of a tab): the panes of a window are
// remembered under it, so that two windows of the app do not fight over them.
const svWinId = (() => {
  if (isEmbed) return '';
  try {
    let w = sessionStorage.getItem('lumen.win');
    if (!w) { w = 'w' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('lumen.win', w); }
    return w;
  } catch (e) { return 'wdefault'; }
})();

// How long a window waits for the answers of the other windows. The round must be
// short (a pane comes up in it) and long enough for the answer of a window that is
// busy to arrive.
const svSettleMs = 400;
const svSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the channel of the windows --------------------------------------------
// One BroadcastChannel for the whole app. Four kinds of messages:
//   {type:'pane', id, chat, claim, frame} a window says which chat it has open
//        (chat) and which chat it is about to open (claim);
//   {type:'who', id, chat}  the "who has what" round: every window answers;
//   {type:'has', id, to, chat, claim}  the answer of the round;
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
  if (!id) return;
  // A pane may re-open the chat it has open. (Not the chat it only claims: a claim
  // is a promise, and the promise can be broken by another window at any time.)
  if (id === (state.chat && state.chat.id)) return;
  // A pane never opens a chat that another window has open or has claimed — not even
  // the chat of its own address. The window that has the chat keeps it and the pane
  // gives it up.
  if (svTakenChats().has(id)) return false;
  return;
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
  svPost({ type: 'pane', id: svMyId, chat: id, claim: svEmbedChat || null, frame: svFrameId() });
}

// The id of the frame this window lives in ('' when it is not in a frame). The main
// window uses it to know which of its frames a window is in.
//
// The name of the frame alone is not enough: every window of the app has a
// 'sideFrame' and a 'splitFrame', and a window must never touch the frames of
// another window (a pane in the side frame of another tab would empty the side
// frame of this one). The id of the window the frame lives in is part of the id:
// the pane asks its own window for it.
function svFrameId() {
  try {
    const el = window.frameElement;
    if (!el) return '';
    let owner = '';
    try { owner = String(window.parent.eval('svWinId') || ''); } catch (e) { owner = ''; }
    return owner + '|' + el.id;
  } catch (e) { return ''; }
}

// The id of a frame of THIS window (the main window of a tab).
function svOwnFrameId(name) {
  return svWinId + '|' + name;
}

// The "who has what" round: the window asks the other windows which chat they have
// open (and which chat they claim) and waits for their answers. The wait is bounded
// — the window must still come up when nobody answers.
async function svWhoHasWhat(chat) {
  svPost({ type: 'who', id: svMyId, chat: chat || null });
  const end = Date.now() + svSettleMs;
  while (Date.now() < end) await svSleep(25);
}

// A conflict: two windows have the same chat open. Exactly one of them keeps it, and
// the rule is the same in every window: the main window always keeps the chat (the
// user clicking a chat in the sidebar must not be undone), and between two panes the
// one with the smaller id keeps it. Both sides can compute the outcome: they know
// both ids. The pane side of the rule is the one that moves.
function svKeeps(peerId) {
  if (peerId === 'main') return false;   // the main window keeps it: this pane moves
  if (svMyId === 'main') return true;    // the main window keeps it
  return svMyId < peerId;                // between two panes: the smaller id keeps it
}

function svConflict(peerId) {
  if (svKeeps(peerId)) {
    // This window keeps the chat. It says so, so that the other one gives it up.
    svAnnounce(svMyChat, true);
    return;
  }
  svMoveAway();
}

// A pane moves away when it learns that another window has the chat it has open: it
// opens a new empty chat and stops writing to that chat. The main window never moves
// away — it is the primary surface, and the user clicking a chat must not be undone.
function svMoveAway() {
  if (!isEmbed) return;
  svEmbedChat = null;   // the pane has no chat of its own any more
  svClearAddress();     // and its address does not name the chat either
  svGuardTemp();        // the aborted turn must not save the empty chat
  try { newChat(); } catch (e) { /* the app is busy */ }
  toast('Another window has this chat');
  svAnnounce(null, true);
}

// The address of a pane that has no chat is /?embed=1: a pane that gave a chat up
// must not name it any more, or a reloaded pane would take it back.
function svClearAddress() {
  try { history.replaceState(null, '', '/?embed=1'); } catch (e) { /* the address stays */ }
}

// ---- the empty chat of a pane that gave its chat up -------------------------
// The turn of the pane that is aborted by the move-away saves the chat that the
// move-away put in the place of the old one — and a chat without an id is a NEW chat
// ("New Chat", no messages). The store must not gain that empty chat. The only way
// out of it inside app.js is the temporary chat: a temporary chat is not saved at
// all. The empty state of the pane is therefore temporary until the user writes in
// it (the first keystroke or the first send ends the guard).
let svTempGuard = false;
function svGuardTemp() {
  if (!isEmbed || svTempGuard) return;
  svTempGuard = true;
  state.temp = true;
  const t = document.querySelector('#tempToggle');
  if (t) t.checked = true;
  // A backstop: the turn of the pane is over long before this, so the guard is
  // lifted even if the user never writes in the pane.
  setTimeout(() => svUnguardTemp(), 2000);
}
function svUnguardTemp() {
  if (!svTempGuard) return;
  svTempGuard = false;
  state.temp = false;
  const t = document.querySelector('#tempToggle');
  if (t) t.checked = false;
}
document.addEventListener('input', svUnguardTemp, true);    // the composer (a paste too)
document.addEventListener('submit', svUnguardTemp, true);   // the send button

if (svChannel) {
  svChannel.onmessage = (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    svRx++; window.__lumenRx = svRx;
    if (d.type === 'pane') {
      const known = svPeers.has(d.id);
      svPeers.set(d.id, { chat: d.chat || null, claim: d.claim || null, frame: d.frame || '' });
      if (d.frame) svFrameMoved(d.frame, d.chat || d.claim || null);
      if (!known) svAnnounce(svMyChat, true);   // a new window: answer once
      if (d.chat && d.chat === svMyChat && d.id !== svMyId) svConflict(d.id);
      if (isEmbed) svFillPicker();
      return;
    }
    if (d.type === 'who') {
      // The round: every window says which chat it has open and which chat it
      // claims. The answer is addressed to the one that asked.
      svPost({ type: 'has', id: svMyId, to: d.id, chat: svMyChat, claim: svEmbedChat || null });
      return;
    }
    if (d.type === 'has') {
      if (d.id === svMyId) return;
      if (d.to && d.to !== svMyId) return;   // the answer is for another window
      const p = svPeers.get(d.id) || {};
      svPeers.set(d.id, { chat: d.chat || null, claim: d.claim || null, frame: p.frame || '' });
      // The answer of the round can be the news that another window has the chat of
      // this window: the pane gives it up.
      if (d.chat && d.chat === svMyChat && d.id !== svMyId) svConflict(d.id);
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
  // The pane claims the chat of its address before it opens it: the other windows
  // must not take it in the meantime.
  if (svEmbedChat) svAnnounce(svEmbedChat, true);
  state.ready.then(async () => {
    if (svEmbedChat) {
      // The pane does not act before it knows: it asks the other windows which chat
      // they have open and waits for their answers (a bounded wait — the pane must
      // still come up when nobody answers).
      await svWhoHasWhat(svEmbedChat);
      if (svTakenChats().has(svEmbedChat)) {
        // Another window has this chat: the pane opens a chat of its own (the empty
        // state) and says so.
        svEmbedChat = null;
        svClearAddress();
        svGuardTemp();     // the empty state of the pane is not saved as it is
        try { newChat(); } catch (e) { /* the app is busy */ }
        toast('Another window has this chat');
      } else if ((state.chat.messages || []).length || state.streaming) {
        // The user has already written in the pane: the chat of the address is left
        // to the other windows, and the pane keeps what the user wrote.
        svEmbedChat = null;
        svClearAddress();
      } else {
        const want = svEmbedChat;
        const typed = (state.chat.messages || []).slice();
        try { await openChat(want); }
        catch (e) { svEmbedChat = null; svClearAddress(); try { newChat(); } catch (e2) { /* the app is busy */ } toast('That chat does not exist'); }
        // What the user wrote while the chat was opening must not be lost.
        if (typed.length) { state.chat.messages = state.chat.messages.concat(typed); renderAll(); }
        // The answer of the other windows can change while the chat is opening: if
        // another window has the chat now, the pane gives it up.
        if (svEmbedChat === want && svTakenChats().has(want)) svMoveAway();
      }
    }
    // The announcements of the other windows arrive in the first moments: the picker
    // must not offer a chat that another window has open.
    setTimeout(() => svFillPicker(), 300);
    svAnnounce(state.chat && state.chat.id, true);
  });
  // The pane that was reloaded after it gave its chat up says so.
  try {
    const k = 'lumen.moved.' + svFrameId();
    if (k) {
      const m = sessionStorage.getItem(k);
      if (m) { sessionStorage.removeItem(k); state.ready.then(() => toast(m)); }
    }
  } catch (e) { /* the browser says no */ }
}

// The chats that another window has open or has claimed. A pane never offers them
// and never opens them: two windows on one chat would take each other's messages
// away.
function svTakenChats() {
  const s = new Set();
  for (const [, p] of svPeers) {
    if (!p) continue;
    if (p.chat) s.add(p.chat);
    if (p.claim) s.add(p.claim);
  }
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
    // The chat of the pane itself is always in its own picker — even in a conflict.
    if (taken.has(c.id) && c.id !== cur) continue;   // another window has it open
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
  svUnguardTemp();
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
  svFrameChats.set(svOwnFrameId('sideFrame'), made.id);
  svSaveFrames();
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

// ---- the frames of the main window ------------------------------------------
// The chat of every frame of the main window. The frames come back after a reload of
// the main window: their chat is remembered in the localStorage of the app, under the
// id of the window (two windows of the app do not fight over the same frames).
const svFrameChats = new Map();   // the id of a frame -> the chat it has open
const svFramesKey = 'lumen.panes.' + svWinId;

function svSaveFrames() {
  if (isEmbed) return;
  const o = {};
  for (const [id, chat] of svFrameChats) o[id] = chat || null;
  try { localStorage.setItem(svFramesKey, JSON.stringify(o)); } catch (e) { /* the browser says no */ }
}

// The panes come back after a reload of the main window.
function svRestoreFrames() {
  if (isEmbed) return;
  let o = null;
  try { o = JSON.parse(localStorage.getItem(svFramesKey) || 'null'); } catch (e) { o = null; }
  if (!o || typeof o !== 'object') return;
  for (const id of Object.keys(o)) {
    // The name of the frame is the part behind the id of the window: the windows of
    // the app have frames with the same names.
    const name = id.indexOf('|') >= 0 ? id.slice(id.indexOf('|') + 1) : id;
    const f = document.getElementById(name);
    if (!f) continue;
    const chat = o[id] || null;
    svFrameChats.set(svOwnFrameId(name), chat);
    f.setAttribute('src', chat ? '/?embed=1&chat=' + encodeURIComponent(chat) : '/?embed=1');
    const pane = f.closest('aside');
    if (pane) pane.hidden = false;
  }
}

// A window in one of the frames of the main window has a chat (or none). The frame
// that has no chat any more must not name it either: the src of the frame is the
// address of the pane, and a reloaded pane must not take the chat back.
//
// Only the frames of THIS window are touched: a frame of another window (a pane of
// another tab) has the same name, and its id does not belong to this window.
function svFrameMoved(frameId, chat) {
  if (isEmbed) return;
  if (!svFrameChats.has(frameId)) return;   // not a frame of this window
  const had = svFrameChats.get(frameId) || null;
  if (had === chat) return;
  svFrameChats.set(frameId, chat);
  svSaveFrames();
  if (chat) return;
  const name = frameId.indexOf('|') >= 0 ? frameId.slice(frameId.indexOf('|') + 1) : frameId;
  const f = document.getElementById(name);
  if (!f) return;
  const src = f.getAttribute('src') || '';
  if (src.indexOf('chat=') < 0) return;
  // The pane that is reloaded says why it is empty.
  try { sessionStorage.setItem('lumen.moved.' + frameId, 'Another window has this chat'); } catch (e) { /* the browser says no */ }
  f.setAttribute('src', '/?embed=1');
}

// The pane of a frame is closed: it gives its chat up, and it does not come back
// after a reload of the main window.
function svCloseFrame(name) {
  const f = document.getElementById(name);
  if (!f) return;
  const key = svOwnFrameId(name);
  svFrameChats.delete(key);
  svSaveFrames();
  // The window of the frame is gone: it says that it has no chat any more, so that
  // the other windows do not keep the chat of a window that is not there.
  for (const [id, p] of [...svPeers]) {
    if (!p || p.frame !== key) continue;
    svPeers.delete(id);
    svPost({ type: 'pane', id: id, chat: null, claim: null, frame: key });
  }
  try { f.setAttribute('src', 'about:blank'); } catch (e) { /* the frame stays */ }
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
  svFrameChats.set(svOwnFrameId('splitFrame'), id);
  svSaveFrames();
  frame.src = '/?embed=1&chat=' + encodeURIComponent(id);
  pane.hidden = false;
  $('#splitTitle').textContent = 'Split view';
}

// The chat of a new pane: a chat of the user that no window has open and that no
// window has claimed. The main window asks the other windows who has what first —
// the round is bounded, a few hundred milliseconds is nothing — and uses the answer:
// a pane that has just booted has not announced yet, and the main window must not
// hand out a chat that another window has just taken.
async function svPickChatForPane() {
  const mine = state.chat && state.chat.id;
  await svWhoHasWhat(null);
  const taken = svTakenChats();     // the chats of the other windows
  const ours = svOwnFrameChats();   // the chats this window has given to its frames
  let list = [];
  try { list = await api('/chats'); } catch (e) { /* no list */ }
  // The most recent chat that no other window has open. The list of the server is
  // sorted with the pinned chats first, so the order of the list is not the order of
  // the chats — the stamp decides which one the pane gets.
  const candidates = list
    .filter((c) => c.id !== mine && !taken.has(c.id) && !ours.has(c.id))
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

// The chats that this window has given to its frames: they belong to the panes.
function svOwnFrameChats() {
  const s = new Set();
  for (const [, c] of svFrameChats) if (c) s.add(c);
  return s;
}

// ---- the buttons and the shortcuts -----------------------------------------
const svSideBtn = $('#sideChatBtn');
if (svSideBtn) svSideBtn.onclick = () => svOpenSide();
const svSplitBtn = $('#splitBtn');
if (svSplitBtn) svSplitBtn.onclick = () => svToggleSplit();
const svInsertBtn = $('#sideInsert');
if (svInsertBtn) svInsertBtn.onclick = () => svInsert();
const svSideClose = $('#sideClose');
if (svSideClose) svSideClose.onclick = () => { $('#sidePane').hidden = true; svCloseFrame('sideFrame'); };
const svSplitClose = $('#splitClose');
if (svSplitClose) svSplitClose.onclick = () => { $('#splitPane').hidden = true; svCloseFrame('splitFrame'); };

// The panes of the main window come back after a reload of it.
svRestoreFrames();

SHORTCUTS.push([`${MOD}Alt+S`, 'Open the side chat']);
SHORTCUTS.push([`${MOD}Alt+P`, 'Open the split view']);
window.addEventListener('keydown', (e) => {
  if (isEmbed) return;   // a pane is a pane — no pane in a pane
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); svOpenSide(); }
  else if (mod && e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); svToggleSplit(); }
});
