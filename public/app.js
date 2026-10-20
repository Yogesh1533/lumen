'use strict';
const $ = (s) => document.querySelector(s);
const SUGGESTIONS = [
  'Explain how a transformer neural network works, simply',
  'Write a Python script that renames files by date taken',
  'Give me a 3-day itinerary for Kyoto',
  'Help me prepare for a system design interview',
];

const state = {
  chat: null,          // {id|null, title, model, system, messages[]}
  chats: [],           // sidebar summaries
  models: [],
  streaming: null,     // AbortController while a reply is in flight
  temp: false,
  pending: [],         // attachments queued in the composer
  processing: 0,       // files still being read
};

// ---- utilities -----------------------------------------------------------
const api = async (path, opts = {}) => {
  const r = await fetch('/api' + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('lumen.' + k); localStorage.setItem('lumen.' + k, v); } catch { return null; } };

// ---- markdown (small, HTML-safe) ----------------------------------------
function inline(s) {
  s = esc(s);
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
       .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}
function markdown(src) {
  const out = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><div class="bar"><span>${esc(fence[1] || 'code')}</span><button type="button" data-copy>Copy</button></div><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(buf.join('\n'))}</blockquote>`); continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`); continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); i += 2; const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>|\s*([-*+]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}


// ---- attachments ---------------------------------------------------------
const MAX_TEXT = 200000; // chars of text kept per attached file
const isImage = (f) => /^image\/(png|jpe?g|webp|gif|bmp)$/.test(f.type);
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const fileToDataURL = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });

async function readImage(f) {
  const url = await fileToDataURL(f);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
  const data = cv.toDataURL('image/jpeg', 0.85).split(',')[1];
  return { kind: 'image', name: f.name || 'image.jpg', mime: 'image/jpeg', data, size: Math.round(data.length * 0.75) };
}
async function readFile(f) {
  if (isImage(f)) return readImage(f);
  if (isPdf(f)) {
    const data = (await fileToDataURL(f)).split(',')[1];
    const { text, pages } = await api('/extract', { method: 'POST', body: { data } });
    if (!text) throw new Error('no extractable text (scanned PDF?)');
    return { kind: 'text', name: f.name, mime: 'application/pdf', text: text.slice(0, MAX_TEXT), pages, truncated: text.length > MAX_TEXT, size: f.size };
  }
  if (f.size > 5e6) throw new Error('file too large (5 MB max for text files)');
  const text = await f.text();
  if (text.includes('\u0000')) throw new Error('binary files are not supported');
  return { kind: 'text', name: f.name, mime: f.type || 'text/plain', text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, size: f.size };
}
async function addFiles(files) {
  for (const f of files) {
    state.processing++; renderChips();
    try { state.pending.push(await readFile(f)); }
    catch (e) { toast(`${f.name || 'file'}: ${e.message || e}`); }
    state.processing--; renderChips();
  }
}
const sizeLabel = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
function renderChips() {
  const box = $('#chips'); box.innerHTML = '';
  state.pending.forEach((a, i) => {
    const d = document.createElement('div'); d.className = 'chip';
    const thumb = a.kind === 'image' ? `<img alt="" src="data:${a.mime};base64,${a.data}">` : `<div class="ico">${esc((a.name.split('.').pop() || 'TXT').slice(0, 4).toUpperCase())}</div>`;
    d.innerHTML = `${thumb}<div><div class="nm">${esc(a.name)}</div><div class="meta">${sizeLabel(a.size)}${a.pages ? ` · ${a.pages}p` : ''}${a.truncated ? ' · truncated' : ''}</div></div><button type="button" title="Remove">✕</button>`;
    d.querySelector('button').onclick = () => { state.pending.splice(i, 1); renderChips(); };
    box.appendChild(d);
  });
  if (state.processing) box.insertAdjacentHTML('beforeend', '<div class="chip busy"><div class="nm">Reading…</div></div>');
}
// What the model actually sees: text attachments are inlined, images go in `images`.
function buildContent(m) {
  const files = (m.attachments || []).filter((a) => a.kind === 'text');
  return (m.content || '') + files.map((a) => `\n\n<attachment name="${a.name}">\n${a.text}\n</attachment>`).join('');
}
const toOllama = ({ role, content, attachments, ...rest }) => {
  const images = (attachments || []).filter((a) => a.kind === 'image').map((a) => a.data);
  return { role, content: buildContent({ content, attachments }), ...(images.length ? { images } : {}) };
};

// ---- rendering -----------------------------------------------------------
function msgEl(m, idx) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role; el.dataset.idx = idx;
  const isUser = m.role === 'user';
  el.innerHTML = `<div class="avatar">${isUser ? 'You' : 'AI'}</div>
    <div class="body"><div class="who">${isUser ? 'You' : esc(state.chat.model || 'Assistant')}</div>
    <div class="content"></div>
    <div class="tools">
      <button data-act="copy">Copy</button>
      ${isUser ? '<button data-act="edit">Edit</button>' : '<button data-act="regen">Regenerate</button>'}
      <button data-act="del">Delete</button>
    </div></div>`;
  paint(el, m);
  return el;
}
function paint(el, m, live) {
  const c = el.querySelector('.content');
  if (m.role === 'user') {
    c.textContent = m.content;
    const atts = m.attachments || [];
    const wrap = el.querySelector('.atts');
    if (wrap) wrap.remove();
    if (atts.length) {
      const w = document.createElement('div'); w.className = 'atts';
      w.innerHTML = atts.map((a) => a.kind === 'image'
        ? `<div class="att"><img alt="${esc(a.name)}" title="${esc(a.name)}" src="data:${a.mime};base64,${a.data}"></div>`
        : `<div class="att file">📄 ${esc(a.name)}${a.pages ? ` · ${a.pages}p` : ''}</div>`).join('');
      c.parentNode.insertBefore(w, c);
      c.style.display = m.content ? '' : 'none';
    }
  }
  else c.innerHTML = (m.thinking ? `<div class="think">${esc(m.thinking)}</div>` : '') + markdown(m.content || '') + (m.error ? `<p class="err">${esc(m.error)}</p>` : '');
  c.classList.toggle('cursor', !!live);
}
function renderAll() {
  const box = $('#messages'); box.innerHTML = '';
  state.chat.messages.forEach((m, i) => box.appendChild(msgEl(m, i)));
  document.body.classList.toggle('chatting', state.chat.messages.length > 0);
  box.scrollTop = box.scrollHeight;
}
function renderSidebar() {
  const list = $('#chatList'); list.innerHTML = '';
  const now = Date.now(), DAY = 864e5;
  let last = '';
  for (const c of state.chats) {
    const g = c.pinned ? 'Pinned' : now - c.updated < DAY ? 'Today' : now - c.updated < 7 * DAY ? 'Previous 7 days' : 'Older';
    if (g !== last) { list.insertAdjacentHTML('beforeend', `<div class="group">${g}</div>`); last = g; }
    const d = document.createElement('div');
    d.className = 'chat' + (state.chat && state.chat.id === c.id ? ' active' : '');
    d.innerHTML = `<span class="t">${esc(c.title)}</span><span class="acts">
      <button data-a="pin" title="Pin">${c.pinned ? '★' : '☆'}</button>
      <button data-a="ren" title="Rename">✎</button><button data-a="del" title="Delete">✕</button></span>`;
    d.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'pin') { await api('/chats/' + c.id, { method: 'PUT', body: { pinned: !c.pinned } }); return refreshChats(); }
      if (a === 'ren') { const t = prompt('Rename chat', c.title); if (t) { await api('/chats/' + c.id, { method: 'PUT', body: { title: t } }); refreshChats(); } return; }
      if (a === 'del') {
        if (!confirm('Delete this chat?')) return;
        await api('/chats/' + c.id, { method: 'DELETE' });
        if (state.chat.id === c.id) newChat();
        return refreshChats();
      }
      openChat(c.id);
    };
    list.appendChild(d);
  }
}
async function refreshChats() {
  const q = $('#search').value.trim();
  state.chats = await api('/chats' + (q ? '?q=' + encodeURIComponent(q) : ''));
  renderSidebar();
}

// ---- chat lifecycle ------------------------------------------------------
function settings() {
  const o = { temperature: +$('#temperature').value, top_p: +$('#topP').value, num_ctx: +$('#numCtx').value || 4096 };
  if ($('#numPredict').value) o.num_predict = +$('#numPredict').value;
  return o;
}
function newChat() {
  if (state.streaming) state.streaming.abort();
  state.chat = { id: null, title: 'New Chat', model: $('#modelSelect').value, system: $('#systemPrompt').value, messages: [] };
  renderAll(); renderSidebar(); $('#input').focus();
}
async function openChat(id) {
  if (state.streaming) state.streaming.abort();
  state.chat = await api('/chats/' + id);
  if (state.chat.model) $('#modelSelect').value = state.chat.model;
  $('#systemPrompt').value = state.chat.system || '';
  renderAll(); renderSidebar();
}
async function persist() {
  const c = state.chat;
  if (state.temp) return;
  if (!c.id) {
    const first = c.messages.find((m) => m.role === 'user');
    c.title = first ? (first.content || (first.attachments && first.attachments[0].name) || 'New Chat').replace(/\s+/g, ' ').slice(0, 48) : 'New Chat';
    const made = await api('/chats', { method: 'POST', body: { title: c.title, model: c.model, system: c.system, messages: c.messages } });
    c.id = made.id;
  } else {
    await api('/chats/' + c.id, { method: 'PUT', body: { messages: c.messages, model: c.model, system: c.system } });
  }
  refreshChats();
}

function setBusy(b) {
  $('#sendBtn').hidden = b; $('#stopBtn').hidden = !b;
  $('#status').textContent = b ? 'Generating…' : '';
}

async function generate() {
  const c = state.chat;
  c.model = $('#modelSelect').value; c.system = $('#systemPrompt').value.trim();
  if (!c.model) return toast('No model selected — is Ollama running?');
  const reply = { role: 'assistant', content: '' };
  c.messages.push(reply);
  renderAll();
  const el = $('#messages').lastElementChild;
  const ac = state.streaming = new AbortController();
  setBusy(true);
  const t0 = performance.now(); let tokens = 0;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: c.model, system: c.system, options: settings(),
        messages: c.messages.slice(0, -1).map(toOllama) }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', raf = 0;
    const flush = () => { raf = 0; paint(el, reply, true); $('#messages').scrollTop = $('#messages').scrollHeight; };
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
        if (j.message) {
          reply.content += j.message.content || '';
          if (j.message.thinking) reply.thinking = (reply.thinking || '') + j.message.thinking;
          if (j.message.content) tokens++;
        }
        if (!raf) raf = requestAnimationFrame(flush);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') reply.error = String(e.message || e);
  }
  state.streaming = null; setBusy(false);
  if (!reply.content && !reply.error && !reply.thinking) c.messages.pop();
  paint(el, reply, false);
  renderAll();
  if (tokens) $('#status').textContent = `${tokens} chunks in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  persist().catch((e) => toast('Save failed: ' + e.message));
}

async function send(text) {
  text = text.trim();
  if ((!text && !state.pending.length) || state.streaming) return;
  await state.ready; // model list may still be loading right after page load
  if (state.processing) return toast('Still reading attachments…');
  const atts = state.pending;
  const model = state.models.find((m) => m.id === $('#modelSelect').value);
  if (atts.some((a) => a.kind === 'image') && model && !model.caps.includes('vision'))
    return toast(`${model.id} can't see images — pick a vision-capable model`);
  const msg = { role: 'user', content: text };
  if (atts.length) msg.attachments = atts;
  state.chat.messages.push(msg);
  state.pending = []; renderChips();
  $('#input').value = ''; autosize();
  await generate();
}

// ---- events --------------------------------------------------------------
function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 220) + 'px'; }
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); }
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send($('#input').value); });
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
$('#input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
{
  const dz = $('#dropzone');
  for (const t of ['dragenter', 'dragover']) window.addEventListener(t, (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dz.classList.add('drag'); } });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dz.classList.remove('drag'); });
  window.addEventListener('drop', (e) => { if (e.dataTransfer?.files.length) { e.preventDefault(); dz.classList.remove('drag'); addFiles([...e.dataTransfer.files]); } });
}
$('#stopBtn').onclick = () => state.streaming && state.streaming.abort();
$('#newChat').onclick = newChat;
$('#search').addEventListener('input', () => { clearTimeout($('#search').t); $('#search').t = setTimeout(refreshChats, 200); });
$('#tempToggle').onchange = (e) => { state.temp = e.target.checked; toast(state.temp ? 'Temporary chat: nothing will be saved' : 'Chats are saved again'); };
$('#modelSelect').onchange = () => { state.chat.model = $('#modelSelect').value; pref('model', state.chat.model); };
$('#systemPrompt').onchange = () => { state.chat.system = $('#systemPrompt').value; };
$('#controlsBtn').onclick = () => { $('#controls').hidden = !$('#controls').hidden; };
$('#closeControls').onclick = () => { $('#controls').hidden = true; };
for (const [id, out] of [['temperature', 'tempOut'], ['topP', 'topPOut']]) $('#' + id).oninput = (e) => { $('#' + out).textContent = e.target.value; };
const toggleSide = () => $('#sidebar').classList.toggle('closed');
$('#toggleSide').onclick = toggleSide; $('#openSide').onclick = toggleSide;
$('#exportBtn').onclick = () => { location.href = '/api/chats/export'; };
$('#clearBtn').onclick = async () => { if (confirm('Delete ALL chats? This cannot be undone.')) { await api('/chats', { method: 'DELETE' }); newChat(); refreshChats(); } };
$('#themeBtn').onclick = () => {
  const d = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = d; pref('theme', d);
};

$('#messages').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { await navigator.clipboard.writeText(copy.closest('pre').querySelector('code').textContent); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200); return; }
  const btn = e.target.closest('[data-act]'); if (!btn || state.streaming) return;
  const idx = +btn.closest('.msg').dataset.idx, m = state.chat.messages[idx], act = btn.dataset.act;
  if (act === 'copy') { await navigator.clipboard.writeText(m.content); toast('Copied'); }
  else if (act === 'del') { state.chat.messages.splice(idx, 1); renderAll(); persist(); }
  else if (act === 'edit') { state.chat.messages.length = idx; renderAll(); state.pending = m.attachments || []; renderChips(); $('#input').value = m.content; autosize(); $('#input').focus(); }
  else if (act === 'regen') { state.chat.messages.length = idx; await generate(); }
});

// ---- boot ----------------------------------------------------------------
state.ready = (async function init() {
  document.documentElement.dataset.theme = pref('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  $('#suggestions').innerHTML = SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join('');
  $('#suggestions').onclick = (e) => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); };
  const sel = $('#modelSelect');
  try {
    const { models } = await api('/models');
    state.models = models;
    sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');
    const saved = pref('model'); if (saved && models.some((m) => m.id === saved)) sel.value = saved;
    if (!models.length) $('#status').textContent = 'No models found. Run: ollama pull <model>';
  } catch (e) {
    sel.innerHTML = '<option value="">Ollama unreachable</option>';
    $('#status').textContent = 'Cannot reach Ollama — start it with: ollama serve';
  }
  newChat();
  refreshChats();
})();
