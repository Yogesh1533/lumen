'use strict';
// Step 8 — quick wins: usage stats, read aloud, find in conversation, export, chat tabs,
// retry with another model / compare, troubleshooting.
// Loaded after app.js. Both are classic scripts, so app.js's top-level consts (state, api,
// esc, pref, …) live in the same global scope and are used here.

// ---- shared formatting ----------------------------------------------------
const num = (n) => (n || 0).toLocaleString();
const msLabel = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + ' s' : Math.round(n || 0) + ' ms');
// Cloud models run outside this machine — always mark them.
const cloudMark = (id) => {
  const m = state.models.find((x) => x.id === id);
  return m && m.cloud ? ' <span class="cloudmark" title="Runs on the model provider’s servers, not on this computer">☁ cloud</span>' : '';
};

// Every feature registers here; app.js calls the lists after a render / a message click.
const afterRender = [];
const msgActions = [];
hooks.onRender = () => { for (const f of afterRender) f(); };
hooks.onMsgAction = (act, m, idx) => { for (const f of msgActions) if (f(act, m, idx)) return true; return false; };

// ---- usage stats ----------------------------------------------------------
async function openUsage() {
  let u;
  try { u = await api('/usage'); } catch (e) { return toast(e.message); }
  const t = u.totals || {}, models = u.byModel || [], days = u.byDay || [];
  $('#usageTotals').innerHTML = [
    ['Output tokens', num(t.evalTokens)], ['Prompt tokens', num(t.promptTokens)],
    ['Speed', (t.tokensPerSecond || 0) + ' tok/s'], ['Replies', num(t.messages)],
    ['Generation time', msLabel(t.totalMs)],
  ].map(([k, v]) => `<div class="ustat"><b>${v}</b><span>${k}</span></div>`).join('');
  const cols = '<tr><th>Model</th><th>Replies</th><th>In</th><th>Out</th><th>tok/s</th></tr>';
  $('#usageModels').innerHTML = models.length
    ? `<table class="utable">${cols}${models.map((r) => `<tr><td>${esc(r.model)}${cloudMark(r.model)}</td><td>${num(r.messages)}</td><td>${num(r.promptTokens)}</td><td>${num(r.evalTokens)}</td><td>${r.tokensPerSecond}</td></tr>`).join('')}</table>`
    : '<p class="sub">Nothing yet — usage appears after the first reply.</p>';
  const dayCols = '<tr><th>Day</th><th>Replies</th><th>Out</th><th>tok/s</th></tr>';
  $('#usageDays').innerHTML = days.length
    ? `<table class="utable">${dayCols}${days.slice().reverse().map((r) => `<tr><td>${esc(r.day)}</td><td>${num(r.messages)}</td><td>${num(r.evalTokens)}</td><td>${r.tokensPerSecond}</td></tr>`).join('')}</table>`
    : '<p class="sub">Nothing yet.</p>';
  $('#usageDlg').showModal();
}
$('#usageBtn').onclick = openUsage;
$('#usageClose').onclick = () => $('#usageDlg').close();

// ---- read aloud ------------------------------------------------------------
// Markdown -> plain text, so the speech engine does not read the markup.
function plainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, (b) => b.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim()).join(' '))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
let speakingIdx = null; // index of the message being read aloud
function stopSpeaking() {
  if (speakingIdx === null) return false;
  const synth = window.speechSynthesis;
  if (synth && typeof synth.cancel === 'function') synth.cancel();
  speakingIdx = null;
  return true;
}
function speakMessage(idx, chat) {
  const c = chat || state.chat;
  const m = c.messages[idx];
  if (!m) return;
  if (speakingIdx === idx) { stopSpeaking(); renderAll(); return; } // the button doubles as a stop control
  stopSpeaking();
  const synth = window.speechSynthesis, Utterance = window.SpeechSynthesisUtterance;
  if (!synth || typeof synth.speak !== 'function' || !Utterance) return toast('This browser cannot read text aloud');
  const text = plainText(m.content || '');
  if (!text) return toast('Nothing to read aloud');
  const u = new Utterance(text);
  const want = pref('voice');
  if (want) { const v = (synth.getVoices() || []).find((x) => x.name === want); if (v) u.voice = v; }
  u.onend = u.onerror = () => { speakingIdx = null; renderAll(); };
  speakingIdx = idx;
  synth.speak(u);
  renderAll();
}
msgActions.push((act, m, idx) => { if (act !== 'speak') return false; speakMessage(idx); return true; });
afterRender.push(() => {
  document.querySelectorAll('#messages .msg').forEach((el) => {
    const b = el.querySelector('[data-act=speak]');
    if (b) b.textContent = +el.dataset.idx === speakingIdx ? 'Stop' : 'Read aloud';
  });
});
hooks.onReply = (reply, c) => {
  if (pref('autoRead') !== '1') return;
  const idx = c.messages.indexOf(reply);
  if (idx >= 0) speakMessage(idx, c);
};
// Voice picker (the list of voices arrives asynchronously in most browsers).
function renderVoices() {
  const sel = $('#voiceSel');
  if (!sel) return;
  const synth = window.speechSynthesis;
  const voices = synth && typeof synth.getVoices === 'function' ? (synth.getVoices() || []) : [];
  const cur = pref('voice') || '';
  sel.innerHTML = '<option value="">System default</option>' +
    voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
  sel.value = voices.some((v) => v.name === cur) ? cur : '';
}
$('#voiceSel').onchange = (e) => pref('voice', e.target.value);
$('#autoRead').checked = pref('autoRead') === '1';
$('#autoRead').onchange = (e) => pref('autoRead', e.target.checked ? '1' : '0');
$('#controlsBtn').addEventListener('click', renderVoices);
renderVoices();
const speech = window.speechSynthesis;
if (speech && typeof speech.addEventListener === 'function') speech.addEventListener('voiceschanged', renderVoices);

// ---- find in conversation --------------------------------------------------
// Matches are highlighted inside the rendered messages; the bar shows "current/total".
const find = { q: '', hits: [], cur: -1 };
function clearFind() {
  document.querySelectorAll('#messages mark.find-hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  find.hits = []; find.cur = -1;
}
function markCurrent() {
  find.hits.forEach((h, i) => h.classList.toggle('cur', i === find.cur));
  $('#findCount').textContent = find.hits.length ? `${find.cur + 1}/${find.hits.length}` : '0/0';
}
function applyFind() {
  clearFind();
  const q = find.q.toLowerCase();
  if (!q) { markCurrent(); return; }
  const walker = document.createTreeWalker($('#messages'), NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    const el = node.parentElement;
    if (!el || !el.closest('.content') || el.closest('details.think')) continue; // message text only
    const text = node.nodeValue, low = text.toLowerCase();
    let i = low.indexOf(q);
    if (i < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (i >= 0) {
      if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
      const mark = document.createElement('mark');
      mark.className = 'find-hit';
      mark.textContent = text.slice(i, i + q.length);
      frag.appendChild(mark);
      find.hits.push(mark);
      last = i + q.length;
      i = low.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    el.replaceChild(frag, node);
  }
  find.cur = find.hits.length ? 0 : -1;
  markCurrent();
}
function stepFind(d) {
  if (!find.hits.length) return;
  find.cur = (find.cur + d + find.hits.length) % find.hits.length;
  markCurrent();
  find.hits[find.cur].scrollIntoView({ block: 'center' });
}
function openFind() {
  $('#findBar').hidden = false;
  $('#findInput').focus();
  $('#findInput').select();
  applyFind();
}
function closeFind() {
  $('#findBar').hidden = true;
  find.q = '';
  $('#findInput').value = '';
  clearFind();
  markCurrent();
}
$('#findBtn').onclick = () => ($('#findBar').hidden ? openFind() : closeFind());
$('#findInput').addEventListener('input', (e) => { find.q = e.target.value; applyFind(); });
$('#findNext').onclick = () => stepFind(1);
$('#findPrev').onclick = () => stepFind(-1);
$('#findClose').onclick = closeFind;
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
  else if (e.key === 'Escape' && !$('#findBar').hidden) { e.preventDefault(); closeFind(); }
});
afterRender.push(() => { if (find.q) applyFind(); });
SHORTCUTS.push([`${MOD}F`, 'Find in conversation']);

// ---- export -------------------------------------------------------------------
// The chat as Markdown; thinking and tool calls are optional.
function chatMarkdown(c, opts) {
  const o = { thinking: false, tools: false, ...(opts || {}) };
  const out = [`# ${c.title || 'Chat'}`, ''];
  if (c.model) out.push(`*Model: ${c.model}*`, '');
  for (const m of c.messages || []) {
    if (m.role === 'user') { out.push('## You', '', m.content || '', ''); continue; }
    out.push(`## ${m.model || 'Assistant'}`, '');
    if (o.thinking && m.thinking) out.push('<details><summary>Thinking</summary>', '', m.thinking, '', '</details>', '');
    if (o.tools && m.toolCalls) for (const tc of m.toolCalls) {
      out.push(`> **Tool call:** ${tc.serverName || 'tool'} › ${tc.tool}`, `> ${JSON.stringify(tc.arguments || {})}`, '');
    }
    out.push(m.content || '', '');
  }
  return out.join('\n');
}
const exportOpts = () => ({ thinking: $('#expThinking').checked, tools: $('#expTools').checked });
function refreshExportPreview() { $('#expPreview').textContent = chatMarkdown(state.chat, exportOpts()); }
function openExport() {
  refreshExportPreview();
  $('#exportDlg').showModal();
}
$('#exportChatBtn').onclick = openExport;
$('#expClose').onclick = () => $('#exportDlg').close();
$('#expThinking').onchange = refreshExportPreview;
$('#expTools').onchange = refreshExportPreview;
$('#expDownload').onclick = () => {
  const md = chatMarkdown(state.chat, exportOpts());
  const name = (state.chat.title || 'chat').replace(/[^\w-]+/g, '-').toLowerCase().slice(0, 60) || 'chat';
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Markdown downloaded');
};
$('#expCopy').onclick = async () => {
  const md = chatMarkdown(state.chat, exportOpts());
  try { await navigator.clipboard.writeText(md); toast('Markdown copied'); }
  catch (e) { toast('Could not copy: ' + (e.message || e)); }
};
$('#expPrint').onclick = () => { $('#exportDlg').close(); setTimeout(() => window.print(), 50); };

// ---- retry with another model -------------------------------------------------------
// "Try another model" forks the reply and answers it with a different model; the old
// answer stays available as another version of the same message.
function openModelPick(idx) {
  if (!state.models.length) { toast('No models found — is Ollama running?'); return; }
  const box = $('#modelPickList');
  box.innerHTML = '';
  for (const m of state.models) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.dataset.model = m.id;
    b.textContent = m.id + (m.cloud ? ' ☁' : '');
    b.onclick = () => { $('#modelPickDlg').close(); retryWithModel(idx, m.id); };
    box.appendChild(b);
  }
  $('#modelPickDlg').showModal();
}
async function retryWithModel(idx, model) {
  const spec = beginFork(idx);
  await generate(spec, model);
}
msgActions.push((act, m, idx) => { if (act !== 'regen2') return false; openModelPick(idx); return true; });
$('#modelPickCancel').onclick = () => $('#modelPickDlg').close();

// ---- compare two models ---------------------------------------------------------------
// Both models answer the same question at the same time; "keep this one" puts the
// chosen answer into the chat (the previous one stays as another version).
function modelOptions() {
  return state.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}${m.cloud ? ' ☁' : ''}</option>`).join('');
}
function openCompare() {
  if (!state.models.length) { toast('No models found — is Ollama running?'); return; }
  const opts = modelOptions();
  $('#cmpModelA').innerHTML = opts;
  $('#cmpModelB').innerHTML = opts;
  const cur = state.chat.model || (state.models[0] && state.models[0].id) || '';
  $('#cmpModelA').value = state.models.some((m) => m.id === cur) ? cur : ($('#cmpModelA').options[0] || {}).value;
  const other = state.models.find((m) => m.id !== $('#cmpModelA').value);
  $('#cmpModelB').value = other ? other.id : $('#cmpModelA').value;
  const lastUser = [...state.chat.messages].reverse().find((m) => m.role === 'user');
  $('#cmpPrompt').textContent = lastUser ? lastUser.content : 'No question yet — write one first.';
  $('#cmpOutA').textContent = ''; $('#cmpOutB').textContent = '';
  $('#cmpKeepA').disabled = true; $('#cmpKeepB').disabled = true;
  $('#compareDlg').showModal();
}
async function streamCompare(model, out) {
  const c = state.chat;
  const system = fullSystem(c.system);
  const lastUser = c.messages.map((m) => m.role).lastIndexOf('user');
  const wire = c.messages.slice(0, lastUser + 1).map(toOllama).flat();
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, system, options: settings(system.length + wire.reduce((n, m) => n + m.content.length, 0)), messages: wire }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      if (j.message && j.message.content) out.textContent += j.message.content;
    }
  }
  return out.textContent;
}
function keepCompare(which) {
  const out = $(which === 'A' ? '#cmpOutA' : '#cmpOutB');
  const model = $(which === 'A' ? '#cmpModelA' : '#cmpModelB').value;
  const text = out.textContent;
  if (!text) return;
  const c = state.chat;
  const idx = c.messages.length - 1;
  const msg = { role: 'assistant', content: text, model, t: Date.now() };
  if (idx >= 0 && c.messages[idx].role === 'assistant') {
    const spec = beginFork(idx); // the old answer stays as another version
    c.messages.push(msg);
    finishFork(spec, msg);
  } else c.messages.push(msg);
  renderAll();
  persist();
  $('#compareDlg').close();
  toast('Kept the answer from ' + model);
}
$('#compareBtn').onclick = openCompare;
$('#cmpClose').onclick = () => $('#compareDlg').close();
$('#cmpKeepA').onclick = () => keepCompare('A');
$('#cmpKeepB').onclick = () => keepCompare('B');
$('#cmpStart').onclick = async () => {
  const a = $('#cmpModelA').value, b = $('#cmpModelB').value;
  $('#cmpNameA').textContent = a; $('#cmpNameB').textContent = b;
  $('#cmpOutA').textContent = ''; $('#cmpOutB').textContent = '';
  $('#cmpKeepA').disabled = true; $('#cmpKeepB').disabled = true;
  $('#cmpStart').disabled = true;
  await Promise.all([
    streamCompare(a, $('#cmpOutA')).then(() => { $('#cmpKeepA').disabled = false; }).catch((e) => { $('#cmpOutA').textContent = 'Error: ' + (e.message || e); }),
    streamCompare(b, $('#cmpOutB')).then(() => { $('#cmpKeepB').disabled = false; }).catch((e) => { $('#cmpOutB').textContent = 'Error: ' + (e.message || e); }),
  ]);
  $('#cmpStart').disabled = false;
};

// ---- troubleshooting -------------------------------------------------------------------
// Settings > Troubleshooting: the server's own log lines and a diagnostic report.
// The report never contains chat content.
let diagReport = null;
async function refreshTrouble() {
  let d = null, l = null;
  try { d = await api('/diagnostics'); } catch (e) { d = null; }
  try { l = await api('/logs'); } catch (e) { l = null; }
  diagReport = d;
  if (d) {
    const rows = [
      ['Lumen', d.version], ['Node', d.node], ['Platform', d.platform],
      ['Uptime', Math.round(d.uptimeSec || 0) + ' s'],
      ['Data folder', d.dataDir],
      ['Ollama', d.ollama.reachable ? `reachable at ${d.ollama.url} — ${d.ollama.models.length} models` : `not reachable at ${d.ollama.url}`],
      ['Chats', d.counts.chats], ['Projects', d.counts.projects], ['Messages', d.counts.messages],
    ];
    $('#diagBox').innerHTML = rows.map(([k, v]) => `<div class="diagrow"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('');
    $('#diagModels').textContent = d.ollama.models.length ? 'Models: ' + d.ollama.models.join(', ') : 'No models found in Ollama.';
  } else $('#diagBox').innerHTML = '<p class="sub">The server did not answer.</p>';
  if (l) {
    const lines = (l.lines || []).map((x) => `${new Date(x.t).toISOString().slice(11, 19)} ${x.level} ${x.msg}`);
    $('#logBox').textContent = lines.join('\n') || '(no log lines yet)';
  }
}
async function openTrouble() {
  $('#troubleDlg').showModal();
  await refreshTrouble();
}
$('#troubleBtn').onclick = openTrouble;
$('#troubleClose').onclick = () => $('#troubleDlg').close();
$('#logRefresh').onclick = refreshTrouble;
$('#diagCopy').onclick = async () => {
  if (!diagReport) return;
  const text = JSON.stringify(diagReport, null, 2);
  try { await navigator.clipboard.writeText(text); toast('Report copied'); }
  catch (e) { toast('Could not copy: ' + (e.message || e)); }
};

// ---- chat tabs -------------------------------------------------------------------
// A tab is a chat that is open in the strip above the conversation. The strip is
// remembered across reloads; the "New Chat" tab is not (it has no id yet).
const chatTabs = { list: [], active: null, closed: [] };
const tabKey = (id) => id || 'new';
// Snapshot the saved tabs before app.js boots (a new chat would otherwise overwrite them).
const savedTabs = (() => {
  try { const s = JSON.parse(pref('tabs') || 'null'); return s && Array.isArray(s.list) ? s : null; } catch { return null; }
})();
function saveTabs() { pref('tabs', JSON.stringify({ list: chatTabs.list.filter((t) => t.id), active: chatTabs.active })); }
function renderTabs() {
  const box = $('#tabStrip'), list = $('#tabList');
  if (!box) return;
  list.innerHTML = '';
  for (const t of chatTabs.list) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.key === chatTabs.active ? ' on' : '');
    el.innerHTML = `<span class="t">${esc(t.title || 'New Chat')}</span><button type="button" class="icon" title="Close tab">✕</button>`;
    el.onclick = (e) => { if (e.target.closest('button')) closeTab(t); else switchTab(t); };
    list.appendChild(el);
  }
  box.hidden = !chatTabs.list.length;
}
function openTab(chat) {
  if (!chat) return;
  const key = tabKey(chat.id);
  if (chat.id) chatTabs.list = chatTabs.list.filter((t) => t.key !== 'new'); // the unsaved chat is gone
  let tab = chatTabs.list.find((t) => t.key === key);
  if (!tab) { tab = { key, id: chat.id || null, title: chat.title || 'New Chat' }; chatTabs.list.push(tab); }
  tab.title = chat.title || tab.title;
  chatTabs.active = key;
  saveTabs(); renderTabs();
}
async function switchTab(tab) {
  if (!tab) return;
  chatTabs.active = tab.key;
  if (tab.id) await openChat(tab.id); else newChat();
  renderTabs();
}
function closeTab(tab) {
  const i = chatTabs.list.indexOf(tab);
  if (i < 0) return;
  chatTabs.list.splice(i, 1);
  chatTabs.closed.push(tab);
  if (chatTabs.active === tab.key) {
    const next = chatTabs.list[i] || chatTabs.list[i - 1] || null;
    chatTabs.active = next ? next.key : null;
    if (next) switchTab(next); else newChat();
  }
  saveTabs(); renderTabs();
}
function reopenClosedTab() {
  const tab = chatTabs.closed.pop();
  if (!tab) return toast('No closed tab to reopen');
  if (!chatTabs.list.some((t) => t.key === tab.key)) chatTabs.list.push(tab);
  switchTab(tab);
}
function stepTab(d) {
  if (chatTabs.list.length < 2) return;
  const i = Math.max(0, chatTabs.list.findIndex((t) => t.key === chatTabs.active));
  switchTab(chatTabs.list[(i + d + chatTabs.list.length) % chatTabs.list.length]);
}
// Keep the active tab in sync with the chat (it gets an id and a title once it is saved).
function syncActiveTab() {
  const c = state.chat, tab = chatTabs.list.find((t) => t.key === chatTabs.active);
  if (!c || !tab) return;
  let changed = false;
  if (c.id && tab.key === 'new') { tab.key = tabKey(c.id); tab.id = c.id; changed = true; }
  if (c.title && tab.title !== c.title) { tab.title = c.title; changed = true; }
  if (changed) { saveTabs(); renderTabs(); }
}

hooks.onOpenChat = (chat) => openTab(chat);
hooks.onNewChat = () => openTab(state.chat);
afterRender.push(syncActiveTab);
$('#tabNext').onclick = () => stepTab(1);
$('#tabPrev').onclick = () => stepTab(-1);
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); reopenClosedTab(); }
  else if (mod && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); stepTab(1); }
  else if (mod && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); stepTab(-1); }
});
SHORTCUTS.push([`${MOD}Shift+T`, 'Reopen the last closed tab']);
$('#contLast').checked = pref('contLast') === '1';
$('#contLast').onchange = (e) => pref('contLast', e.target.checked ? '1' : '0');
// On start: restore the tabs, then either continue the last chat or the active tab.
state.ready.then(async () => {
  if (savedTabs) {
    chatTabs.list = savedTabs.list.filter((t) => t && typeof t.key === 'string');
    chatTabs.active = savedTabs.active || (chatTabs.list[0] && chatTabs.list[0].key) || null;
    renderTabs();
  }
  if (pref('contLast') === '1') {
    try {
      const list = await api('/chats');
      // The chat list is sorted with pinned chats first, so "the last chat" is the
      // most recently updated one — not simply the first entry.
      const recent = list.reduce((a, b) => ((b.updated || 0) > (a.updated || 0) ? b : a), list[0]);
      if (recent) { await openChat(recent.id); return; }
    } catch { /* fall back to the restored tab */ }
  }
  const active = chatTabs.list.find((t) => t.key === chatTabs.active);
  if (active) { if (active.id) await openChat(active.id); else newChat(); }
});
