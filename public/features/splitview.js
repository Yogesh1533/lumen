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
// The embed mode is a MODE of this app: a class on <body> (no sidebar, a compact
// header). There is no second copy of the app and no app-embed.js.
//
// The side chat is a chat record of its own. It never writes to the main chat: the
// only way into the main chat is the "Insert into chat" button, which adds a message
// of the user and lets the normal persist() save it.

// ---- the mode of the page --------------------------------------------------
const svQS = new URLSearchParams(location.search);
const svEmbed = svQS.get('embed') === '1';      // the second pane of Lumen
const svEmbedChat = (svQS.get('chat') || '').trim();

if (svEmbed) {
  document.body.classList.add('embed');
  const svHead = document.querySelector('header');
  if (svHead) svHead.classList.add('compact');
}

// ---- the channel of the panes ----------------------------------------------
// One BroadcastChannel for the whole app. A pane posts when the chat list changed
// (a chat was created, renamed, deleted, pinned or moved) and when the messages of a
// chat changed. A pane that refreshes because of another pane never posts about that
// refresh (the counter below), so the panes cannot spin.
const svChannelName = 'lumen';
let svChannel = null;
try { if (typeof BroadcastChannel !== 'undefined') svChannel = new BroadcastChannel(svChannelName); }
catch (e) { svChannel = null; }   // a browser without it simply has no cross-pane refresh
let svSuppress = 0;   // > 0 while this pane refreshes because of another pane
let svPending = null; // a post that waits for the end of the refresh
let svRx = 0;         // the messages this pane received (the test reads it)
window.__lumenRx = 0;
window.__lumenPosts = [];   // what this pane posted (the test reads it)

function svPostNow(type, extra) {
  window.__lumenPosts.push(Object.assign({ type: type }, extra || {}));
  try { svChannel.postMessage(Object.assign({ type: type }, extra || {})); } catch (e) { /* the channel is gone */ }
}
function svPost(type, extra) {
  if (!svChannel) return;
  // A pane that refreshes because of another pane must not post about that refresh —
  // the panes would spin. A post of its own waits for the end of the refresh.
  if (svSuppress > 0) { svPending = Object.assign({ type: type }, extra || {}); return; }
  svPostNow(type, extra);
}
function svRelease() {
  svSuppress--;
  if (svSuppress === 0 && svPending) { const p = svPending; svPending = null; svPostNow(p.type, p); }
}

// The list of chats as the sidebar shows it — the fingerprint of the list. The order
// does not matter (the panes may sort the list differently), only what is in it.
const svListSig = () => JSON.stringify((state.chats || []).map((c) => [c.id, c.title, !!c.pinned, c.project || null]).sort());
let svLastSig = null;

const svRefreshChats = refreshChats;
refreshChats = async function () {
  const r = await svRefreshChats.apply(null, arguments);
  const sig = svListSig();
  if (svLastSig !== null && sig !== svLastSig) { svPost('list'); svFillPicker(); }
  svLastSig = sig;
  return r;
};

const svPersist = persist;
persist = async function () {
  const r = await svPersist.apply(null, arguments);
  const c = state.chat;
  if (c && c.id) svPost('messages', { chat: c.id });
  return r;
};

if (svChannel) {
  svChannel.onmessage = (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    svRx++; window.__lumenRx = svRx;
    if (d.type === 'list') {
      svSuppress++;
      Promise.resolve(refreshChats()).catch(() => {}).finally(svRelease);
    } else if (d.type === 'messages') {
      const c = state.chat;
      if (d.chat && c && c.id === d.chat && !state.streaming && !state.toolsBusy) {
        svSuppress++;
        Promise.resolve(openChat(d.chat)).catch(() => {}).finally(svRelease);
      }
    }
  };
}

// ---- the embed mode --------------------------------------------------------
// A pane shows the chat of its own address. It is a full user of the app, but it
// keeps its chat: the "continue the last chat" of the app and the restored tabs
// must not drag the pane to another conversation.
let svAllowed = '';   // the chat the user picked in the pane (once)
if (svEmbed) {
  const svOpenChat = openChat;
  openChat = async function (id) {
    if (id !== svEmbedChat && id !== svAllowed) return;   // the pane keeps its own chat
    return svOpenChat.apply(null, arguments);
  };
  // The chat picker of the pane: any chat of the user, in a pane of its own.
  const svHead = document.querySelector('header');
  if (svHead) {
    const sel = document.createElement('select');
    sel.id = 'embedChatSel';
    sel.title = 'The chat of this pane';
    sel.onchange = () => { svAllowed = sel.value; openChat(sel.value); };
    svHead.insertBefore(sel, svHead.firstChild);
  }
  state.ready.then(async () => {
    if (!svEmbedChat) return;                       // a new chat: the normal empty state
    try {
      await svOpenChat(svEmbedChat);
    } catch (e) {
      newChat();                                    // the id does not exist: the normal empty state
      toast('That chat does not exist');
    }
    // The app may open another chat after the start (the last chat, the restored tabs).
    // The pane keeps the chat of its own address.
    setTimeout(async () => {
      if (svAllowed || !svEmbedChat) return;
      if (!state.chat || state.chat.id !== svEmbedChat) {
        try { await svOpenChat(svEmbedChat); } catch (e) { newChat(); }
      }
    }, 1500);
    svFillPicker();
  });
}

async function svFillPicker() {
  const sel = document.getElementById('embedChatSel');
  if (!sel) return;
  let list = [];
  try { list = await api('/chats'); } catch { return; }
  const cur = state.chat && state.chat.id;
  sel.innerHTML = '';
  for (const c of list) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.title;
    if (c.id === cur) o.selected = true;
    sel.appendChild(o);
  }
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
  const room = svSnapChars - intro.length - cap.length - 260;
  let body = '', shown = 0;
  for (const l of lines) {
    if (body.length + l.length + 1 > room) break;
    body += (body ? '\n' : '') + l;
    shown++;
  }
  const head = cap + ' ' + shown + ' of ' + svSnapMessages + ' messages and ' + body.length.toLocaleString('en-US') +
    ' of ' + svSnapChars.toLocaleString('en-US') + ' characters are shown here.]';
  const text = intro + '\n\n' + head + '\n--- begin snapshot ---\n' + body + '\n--- end snapshot ---';
  return text.length > svSnapChars ? text.slice(0, svSnapChars) : text;
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
      messages: [{ role: 'user', content: svSnapshot(main.messages) }],
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
// The second pane is Lumen itself. It gets a conversation of its own: two panes that
// write the same chat would take each other's messages away (the app saves the whole
// list of messages every time), so the second pane starts a new one. A chat of the
// user can be opened in it with the picker of the pane.
function svToggleSplit() {
  const pane = $('#splitPane');
  if (pane && !pane.hidden) { pane.hidden = true; return; }
  const frame = $('#splitFrame');
  frame.src = '/?embed=1';
  pane.hidden = false;
  $('#splitTitle').textContent = 'Split view';
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
  if (svEmbed) return;   // a pane is a pane — no pane in a pane
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); svOpenSide(); }
  else if (mod && e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); svToggleSplit(); }
});

// The command palette: the chats of the user do not make sense in a pane (a pane
// keeps its chat), the side chat and the split view do.
const svBuildPalette = buildPalette;
buildPalette = function (chats) {
  const items = svBuildPalette.apply(null, arguments);
  if (svEmbed) return items.filter((it) => it.hint !== 'chat');
  items.push({ label: 'Side chat', hint: `${MOD}Alt+S`, run: () => svOpenSide() });
  items.push({ label: 'Split view', hint: `${MOD}Alt+P`, run: () => svToggleSplit() });
  return items;
};
