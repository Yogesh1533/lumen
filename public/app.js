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
  projects: [],        // sidebar summaries
  project: null,       // active project id
  projectData: null,   // active project incl. knowledge text
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
      const art = ART_LANGS[(fence[1] || '').toLowerCase()];
      out.push(`<pre${art ? ' data-art' : ''}><div class="bar"><span>${esc(fence[1] || 'code')}</span><span class="right">${art ? '<button type="button" data-open-art>Open as artifact</button>' : ''}<button type="button" data-copy>Copy</button></span></div><code>${esc(buf.join('\n'))}</code></pre>`);
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


// ---- artifacts -----------------------------------------------------------
const ART_LANGS = { html: 'html', svg: 'svg', markdown: 'md', md: 'md' };
const ART_EXT = { html: 'html', svg: 'svg', md: 'md' };
state.art = { list: [], i: 0, tab: 'preview' };

// All artifact-capable fenced blocks across the chat, in order.
function collectArtifacts() {
  const list = [];
  state.chat.messages.forEach((m, mi) => {
    if (m.role !== 'assistant') return;
    const re = /```(html|svg|markdown|md)[^\n]*\n([\s\S]*?)(?:```|$)/gi;
    let x, n = 0;
    while ((x = re.exec(m.content || ''))) list.push({ mi, n: n++, lang: ART_LANGS[x[1].toLowerCase()], code: x[2].replace(/\n$/, '') });
  });
  return list;
}
function artTitle(a) {
  const t = a.lang === 'html' ? (a.code.match(/<title[^>]*>([^<]+)<\/title>/i) || a.code.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1]
    : a.lang === 'md' ? (a.code.match(/^#{1,3}\s+(.+)$/m) || [])[1] : null;
  return (t || { html: 'HTML page', svg: 'SVG image', md: 'Document' }[a.lang]).trim().slice(0, 80);
}
function artDoc(a) {
  if (a.lang === 'html') return a.code;
  if (a.lang === 'svg') return `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${a.code}</body>`;
  return `<!doctype html><meta charset="utf-8"><style>body{font:16px/1.6 -apple-system,Segoe UI,sans-serif;max-width:720px;margin:32px auto;padding:0 20px;color:#1b1b24}pre{background:#14141c;color:#eee;padding:12px;border-radius:8px;overflow:auto}code{background:#eee;padding:1px 5px;border-radius:4px}pre code{background:none;padding:0}th,td{border:1px solid #ddd;padding:4px 10px}table{border-collapse:collapse}blockquote{border-left:3px solid #ddd;margin-left:0;padding-left:12px;color:#666}</style>${markdown(a.code).replace(/<button[^>]*data-copy[^>]*>Copy<\/button>/g, '')}`;
}
function renderArtifact() {
  const { list, i, tab } = state.art, a = list[i];
  if (!a) return closeArtifact();
  $('#artifact').hidden = false; $('#controls').hidden = true;
  $('#artTitle').textContent = artTitle(a);
  $('#artMeta').textContent = a.lang === 'md' ? 'markdown' : a.lang;
  $('.art-nav').hidden = list.length < 2;
  $('#artPos').textContent = `${i + 1} / ${list.length}`;
  $('#artPrev').disabled = i === 0; $('#artNext').disabled = i === list.length - 1;
  $('#tabPreview').classList.toggle('on', tab === 'preview'); $('#tabCode').classList.toggle('on', tab === 'code');
  $('#artFrame').hidden = tab !== 'preview'; $('#artCode').hidden = tab !== 'code';
  if (tab === 'preview') $('#artFrame').srcdoc = artDoc(a); else $('#artCode').textContent = a.code;
}
function openArtifact(mi, n, tab = 'preview') {
  state.art.list = collectArtifacts();
  const i = state.art.list.findIndex((a) => a.mi === mi && a.n === n);
  if (i < 0) return;
  state.art.i = i; state.art.tab = tab; renderArtifact();
}
function closeArtifact() { $('#artifact').hidden = true; $('#artFrame').srcdoc = ''; }
// After a reply finishes, surface its most substantial html/svg block automatically.
function maybeAutoOpenArtifact() {
  if (!$('#autoArt').checked) return;
  const mi = state.chat.messages.length - 1;
  const mine = collectArtifacts().filter((a) => a.mi === mi && a.lang !== 'md' && a.code.split('\n').length >= 8);
  if (mine.length) openArtifact(mi, mine[mine.length - 1].n);
}
$('#artClose').onclick = closeArtifact;
$('#artPrev').onclick = () => { state.art.i--; renderArtifact(); };
$('#artNext').onclick = () => { state.art.i++; renderArtifact(); };
$('#tabPreview').onclick = () => { state.art.tab = 'preview'; renderArtifact(); };
$('#tabCode').onclick = () => { state.art.tab = 'code'; renderArtifact(); };
$('#artCopy').onclick = async () => { await navigator.clipboard.writeText(state.art.list[state.art.i].code); toast('Copied'); };
$('#artDownload').onclick = () => {
  const a = state.art.list[state.art.i];
  const url = URL.createObjectURL(new Blob([a.code], { type: 'text/plain' }));
  const l = document.createElement('a'); l.href = url; l.download = `${artTitle(a).replace(/[^\w-]+/g, '-').toLowerCase()}.${ART_EXT[a.lang]}`;
  l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#artifact').hidden) closeArtifact(); });


// ---- projects ------------------------------------------------------------
const MAX_KNOWLEDGE_CHARS = 400000;
const knowledgeChars = (p) => (p ? p.files.reduce((n, f) => n + (f.text ? f.text.length : f.chars || 0), 0) : 0);
// Project instructions + knowledge documents + the per-chat system prompt from Controls.
function fullSystem(chatSystem) {
  const p = state.projectData, parts = [];
  if (p && p.instructions.trim()) parts.push(p.instructions.trim());
  if (p && p.files.length) parts.push('Reference documents for this project. Use them when relevant and cite the file name.\n' +
    p.files.map((f) => `<document name="${f.name}">\n${f.text}\n</document>`).join('\n'));
  if (chatSystem && chatSystem.trim()) parts.push(chatSystem.trim());
  return parts.join('\n\n');
}
async function loadProjects() { state.projects = await api('/projects'); renderProjects(); }
function renderProjects() {
  const box = $('#projects'); box.innerHTML = '';
  for (const p of state.projects) {
    const d = document.createElement('div');
    d.className = 'proj' + (p.id === state.project ? ' active' : '');
    d.innerHTML = `<span>📁</span><span class="t">${esc(p.name)}</span><span class="n">${p.files.length ? p.files.length + ' file' + (p.files.length > 1 ? 's' : '') : ''}</span><button type="button" title="Edit project">⚙</button>`;
    d.onclick = (e) => { if (e.target.closest('button')) openProjectDialog(p.id); else selectProject(p.id === state.project ? null : p.id); };
    box.appendChild(d);
  }
  const cur = state.projects.find((p) => p.id === state.project);
  $('#projChip').hidden = !cur;
  if (cur) $('#projOpen').textContent = '📁 ' + cur.name;
}
async function setProject(id) {
  // Set id and data together so a message can never go out with a project but without its knowledge.
  const data = id ? await api('/projects/' + id).catch(() => null) : null;
  state.projectData = data; state.project = data ? id : null;
  renderProjects();
}
async function selectProject(id) {
  await setProject(id); newChat(); refreshChats();
}
async function moveChat(c) {
  const sel = $('#moveSel');
  sel.innerHTML = '<option value="">No project</option>' + state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = c.project || '';
  $('#moveDlg').dataset.chat = c.id; $('#moveDlg').showModal();
}
$('#moveCancel').onclick = () => $('#moveDlg').close();
$('#moveForm').onsubmit = async () => {
  const id = $('#moveDlg').dataset.chat, project = $('#moveSel').value || null;
  await api('/chats/' + id, { method: 'PUT', body: { project } });
  if (state.chat.id === id) { state.chat.project = project; await setProject(project); }
  toast(project ? 'Moved to project' : 'Removed from project');
  refreshChats();
};

let editing = null; // project being edited in the dialog (full data)
async function openProjectDialog(id) {
  editing = await api('/projects/' + id);
  $('#pName').value = editing.name; $('#pInstr').value = editing.instructions;
  renderProjectFiles(); $('#projDlg').showModal();
}
function renderProjectFiles() {
  const box = $('#pFiles'); box.innerHTML = '';
  for (const f of editing.files) {
    const d = document.createElement('div'); d.className = 'pfile';
    d.innerHTML = `<span>📄</span><span class="nm">${esc(f.name)}</span><span class="meta">~${Math.round(f.text.length / 4).toLocaleString()} tok</span><button type="button" class="icon" title="Remove">✕</button>`;
    d.querySelector('button').onclick = async () => {
      await api(`/projects/${editing.id}/files/${f.id}`, { method: 'DELETE' });
      editing.files = editing.files.filter((x) => x.id !== f.id); renderProjectFiles(); loadProjects();
    };
    box.appendChild(d);
  }
  const chars = knowledgeChars(editing), tok = Math.round(chars / 4);
  $('#pTokens').textContent = editing.files.length ? `~${tok.toLocaleString()} tokens in every chat` : '';
  const warn = $('#pWarn'), model = tok > 6000;
  warn.hidden = !model;
  warn.textContent = model ? 'Large knowledge base: the context window grows automatically (up to 32k), which uses more memory and slows replies. Consider trimming files.' : '';
}
$('#pAddFile').onclick = () => $('#pFileInput').click();
$('#pFileInput').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    try {
      const a = await readFile(f);
      if (a.kind !== 'text') { toast(`${f.name}: images can't be project knowledge`); continue; }
      if (knowledgeChars(editing) + a.text.length > MAX_KNOWLEDGE_CHARS) { toast(`${f.name}: project knowledge limit reached`); continue; }
      const meta = await api(`/projects/${editing.id}/files`, { method: 'POST', body: { name: a.name, text: a.text, size: a.size } });
      editing.files.push({ ...meta, text: a.text }); renderProjectFiles();
    } catch (err) { toast(`${f.name}: ${err.message || err}`); }
  }
  loadProjects();
};
$('#pCancel').onclick = () => $('#projDlg').close();
$('#projForm').onsubmit = async () => {
  await api('/projects/' + editing.id, { method: 'PUT', body: { name: $('#pName').value, instructions: $('#pInstr').value } });
  await loadProjects();
  if (state.project === editing.id) await setProject(editing.id);
  toast('Project saved');
};
$('#pDelete').onclick = async () => {
  if (!confirm(`Delete project "${editing.name}"? Its chats are kept and moved out of the project.`)) return;
  await api('/projects/' + editing.id, { method: 'DELETE' });
  $('#projDlg').close();
  const wasActive = state.project === editing.id;
  await loadProjects();
  if (wasActive) await selectProject(null); else refreshChats();
};
$('#newProject').onclick = async () => {
  const p = await api('/projects', { method: 'POST', body: { name: 'Untitled project' } });
  await loadProjects(); openProjectDialog(p.id);
};
$('#projOpen').onclick = () => state.project && openProjectDialog(state.project);
$('#projLeave').onclick = () => selectProject(null);


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
function versionsHTML(m) {
  if (!m.fk || m.fk.tails.length < 2) return '';
  const { cur, tails } = m.fk;
  return `<div class="vers"><button type="button" data-act="vprev" title="Previous version" ${cur === 0 ? 'disabled' : ''}>‹</button><span>${cur + 1}/${tails.length}</span><button type="button" data-act="vnext" title="Next version" ${cur === tails.length - 1 ? 'disabled' : ''}>›</button></div>`;
}
function msgEl(m, idx) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role; el.dataset.idx = idx;
  const isUser = m.role === 'user';
  el.innerHTML = `<div class="avatar">${isUser ? 'You' : 'AI'}</div>
    <div class="body"><div class="who">${isUser ? 'You' : esc(state.chat.model || 'Assistant')}</div>
    <div class="content"></div>
    ${versionsHTML(m)}
    <div class="tools">
      <button data-act="copy">Copy</button>
      ${isUser ? '<button data-act="edit">Edit</button>' : '<button data-act="regen">Regenerate</button>'}
      <button data-act="del">Delete</button>
    </div></div>`;
  paint(el, m);
  return el;
}
// Reasoning block: open while the model is still thinking, collapsed (and timed) once the answer starts.
const thinkOpen = new WeakMap(), thinkT0 = new WeakMap();
function thinkHTML(m, live) {
  if (!m.thinking) return '';
  const thinking = !!live && !m.content;
  const secs = m.thinkMs != null ? m.thinkMs / 1000 : thinkT0.has(m) ? (performance.now() - thinkT0.get(m)) / 1000 : null;
  const label = thinking ? `Thinking… ${secs != null ? secs.toFixed(1) + 's' : ''}` : `Thought${secs != null ? ' for ' + secs.toFixed(1) + 's' : ''}`;
  const open = thinkOpen.has(m) ? thinkOpen.get(m) : thinking;
  return `<details class="think${thinking ? ' live' : ''}" data-think${open ? ' open' : ''}><summary>${label}</summary><div class="tbody">${esc(m.thinking)}</div></details>`;
}
// Remember only deliberate user toggles (clicks), not the automatic open-while-thinking state.
$('#messages').addEventListener('click', (e) => {
  const sum = e.target.closest('details[data-think] > summary'); if (!sum) return;
  const d = sum.parentElement, m = state.chat.messages[+d.closest('.msg').dataset.idx];
  setTimeout(() => { if (m) thinkOpen.set(m, d.open); });
});
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
  else c.innerHTML = thinkHTML(m, live) + markdown(m.content || '') + (m.error ? `<p class="err">${esc(m.error)}</p>` : '');
  c.classList.toggle('cursor', !!live);
  const tb = c.querySelector('details.think[open] .tbody');
  if (tb && live && !m.content) tb.scrollTop = tb.scrollHeight;
}
// ---- branching: the head message of a fork carries `fk` = { tails, cur }.
// tails[i] is a saved snapshot of the messages from that head onward; tails[cur] is null (it is the live chat).
function beginFork(i) {
  const head = state.chat.messages[i];
  const fk = head.fk || { tails: [null], cur: 0 };
  const tail = state.chat.messages.slice(i);
  delete head.fk;
  state.chat.messages.length = i;
  return { i, fk, tail, cur: fk.cur };
}
function finishFork(spec, newHead) {
  spec.fk.tails[spec.fk.cur] = spec.tail;
  spec.fk.tails.push(null); spec.fk.cur = spec.fk.tails.length - 1;
  newHead.fk = spec.fk;
}
function undoFork(spec) {
  const { fk } = spec;
  if (fk.cur !== spec.cur) { fk.tails.pop(); fk.cur = spec.cur; fk.tails[fk.cur] = null; }
  spec.tail[0].fk = fk;
  state.chat.messages.push(...spec.tail);
}
function switchBranch(i, d) {
  const msgs = state.chat.messages, fk = msgs[i].fk, j = fk ? fk.cur + d : -1;
  if (!fk || j < 0 || j >= fk.tails.length) return;
  const tail = msgs.slice(i); delete tail[0].fk;
  fk.tails[fk.cur] = tail;
  const next = fk.tails[j]; fk.tails[j] = null; fk.cur = j;
  msgs.length = i; msgs.push(...next); msgs[i].fk = fk;
  closeArtifact(); renderAll(); persist();
}
function startEdit(el, m) {
  const c = el.querySelector('.content');
  c.style.display = ''; c.classList.add('editing');
  c.innerHTML = '<textarea class="editbox"></textarea><div class="editbar"><button type="button" class="ghost" data-act="editcancel">Cancel</button><button type="button" class="primary" data-act="editsave">Save &amp; submit</button></div>';
  const ta = c.querySelector('textarea'); ta.value = m.content; ta.focus();
}
// Short model-written title after the first exchange, unless the user already named the chat.
async function autoTitle(c, reply) {
  c.titled = true;
  try {
    const first = c.messages.find((m) => m.role === 'user');
    const { title } = await api('/title', { method: 'POST', body: { model: c.model, user: first ? first.content || (first.attachments && first.attachments[0].name) : '', assistant: reply.content } });
    if (!title) return;
    c.title = title;
    await api('/chats/' + c.id, { method: 'PUT', body: { title, titled: true } });
    refreshChats();
  } catch { /* keep the fallback title */ }
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
      <button data-a="mv" title="Move to project">📁</button><button data-a="ren" title="Rename">✎</button><button data-a="del" title="Delete">✕</button></span>`;
    d.onclick = async (e) => {
      const a = e.target.dataset.a;
      if (a === 'pin') { await api('/chats/' + c.id, { method: 'PUT', body: { pinned: !c.pinned } }); return refreshChats(); }
      if (a === 'mv') return moveChat(c);
      if (a === 'ren') { const t = prompt('Rename chat', c.title); if (t) { await api('/chats/' + c.id, { method: 'PUT', body: { title: t, titled: true } }); refreshChats(); } return; }
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
  // Searching spans every project; otherwise show only the active project's chats (or unfiled ones).
  const qs = q ? '?q=' + encodeURIComponent(q) : '?project=' + (state.project || 'none');
  state.chats = await api('/chats' + qs);
  renderSidebar();
}

// ---- chat lifecycle ------------------------------------------------------
// Ollama silently drops the *start* of an over-long prompt (our system prompt!), so grow num_ctx to fit.
function settings(promptChars = 0) {
  const need = Math.ceil((promptChars / 3.5 + 1024) / 1024) * 1024;
  const o = { temperature: +$('#temperature').value, top_p: +$('#topP').value, num_ctx: Math.min(Math.max(+$('#numCtx').value || 4096, need), 32768) };
  if ($('#numPredict').value) o.num_predict = +$('#numPredict').value;
  return o;
}
function newChat() {
  if (state.streaming) state.streaming.abort();
  closeArtifact();
  state.chat = { id: null, title: 'New Chat', model: $('#modelSelect').value, system: $('#systemPrompt').value, project: state.project, messages: [] };
  renderAll(); renderSidebar(); $('#input').focus();
}
async function openChat(id) {
  if (state.streaming) state.streaming.abort();
  closeArtifact();
  state.chat = await api('/chats/' + id);
  if ((state.chat.project || null) !== state.project) { await setProject(state.chat.project || null); refreshChats(); }
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
    const made = await api('/chats', { method: 'POST', body: { title: c.title, model: c.model, system: c.system, project: c.project, messages: c.messages } });
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

async function generate(fork) {
  const c = state.chat;
  c.model = $('#modelSelect').value; c.system = $('#systemPrompt').value.trim();
  if (!c.model) { if (fork) { undoFork(fork); renderAll(); } return toast('No model selected — is Ollama running?'); }
  const reply = { role: 'assistant', content: '' };
  c.messages.push(reply);
  if (fork) finishFork(fork, reply);
  const caps = (state.models.find((m) => m.id === c.model) || { caps: [] }).caps;
  const canThink = caps.includes('thinking');
  renderAll();
  const el = $('#messages').lastElementChild;
  const system = fullSystem(c.system);
  const wire = c.messages.slice(0, -1).map(toOllama);
  const ac = state.streaming = new AbortController();
  setBusy(true);
  const t0 = performance.now(); let tokens = 0;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: c.model, system, ...(canThink ? { think: $('#thinkToggle').checked } : {}), options: settings(system.length + wire.reduce((n, m) => n + m.content.length, 0)),
        messages: wire }),
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
          if (j.message.thinking) {
            if (!thinkT0.has(reply)) thinkT0.set(reply, performance.now());
            reply.thinking = (reply.thinking || '') + j.message.thinking;
          }
          if (j.message.content && thinkT0.has(reply) && reply.thinkMs == null) reply.thinkMs = Math.round(performance.now() - thinkT0.get(reply));
          if (j.message.content) tokens++;
        }
        if (!raf) raf = requestAnimationFrame(flush);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') reply.error = String(e.message || e);
  }
  state.streaming = null; setBusy(false);
  if (!reply.content && !reply.error && !reply.thinking) { c.messages.pop(); if (fork) undoFork(fork); }
  if (reply.thinking && reply.thinkMs == null && thinkT0.has(reply)) reply.thinkMs = Math.round(performance.now() - thinkT0.get(reply));
  paint(el, reply, false);
  renderAll();
  if (!reply.error) maybeAutoOpenArtifact();
  if (tokens) $('#status').textContent = `${tokens} chunks in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  persist().then(() => { if (c.id && !c.titled && reply.content && !state.temp) autoTitle(c, reply); }).catch((e) => toast('Save failed: ' + e.message));
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
function updateThinkUI() {
  const m = state.models.find((x) => x.id === $('#modelSelect').value);
  $('#thinkWrap').hidden = !(m && m.caps.includes('thinking'));
}
$('#thinkToggle').checked = pref('think') !== '0';
$('#thinkToggle').onchange = (e) => pref('think', e.target.checked ? '1' : '0');
$('#modelSelect').onchange = () => { updateThinkUI(); state.chat.model = $('#modelSelect').value; pref('model', state.chat.model); };
$('#systemPrompt').onchange = () => { state.chat.system = $('#systemPrompt').value; };
$('#controlsBtn').onclick = () => { $('#controls').hidden = !$('#controls').hidden; };
$('#closeControls').onclick = () => { $('#controls').hidden = true; };
for (const [id, out] of [['temperature', 'tempOut'], ['topP', 'topPOut']]) $('#' + id).oninput = (e) => { $('#' + out).textContent = e.target.value; };
const toggleSide = () => $('#sidebar').classList.toggle('closed');
$('#toggleSide').onclick = toggleSide; $('#openSide').onclick = toggleSide;
$('#exportBtn').onclick = () => { location.href = '/api/chats/export'; };
$('#clearBtn').onclick = async () => { if (confirm('Delete ALL chats? This cannot be undone.')) { await api('/chats', { method: 'DELETE' }); newChat(); refreshChats(); } };
$('#autoArt').checked = pref('autoArt') !== '0';
$('#autoArt').onchange = (e) => pref('autoArt', e.target.checked ? '1' : '0');
$('#themeBtn').onclick = () => {
  const d = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = d; pref('theme', d);
};

$('#messages').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { await navigator.clipboard.writeText(copy.closest('pre').querySelector('code').textContent); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200); return; }
  const open = e.target.closest('[data-open-art]');
  if (open) {
    const pre = open.closest('pre'), msg = pre.closest('.msg');
    return openArtifact(+msg.dataset.idx, [...msg.querySelectorAll('pre[data-art]')].indexOf(pre));
  }
  const btn = e.target.closest('[data-act]'); if (!btn || state.streaming) return;
  const idx = +btn.closest('.msg').dataset.idx, m = state.chat.messages[idx], act = btn.dataset.act;
  if (act === 'copy') { await navigator.clipboard.writeText(m.content); toast('Copied'); }
  else if (act === 'del') {
    if (m.fk && m.fk.tails.length > 1 && !confirm('This message has other versions. Delete them all?')) return;
    state.chat.messages.splice(idx, 1); renderAll(); persist();
  }
  else if (act === 'edit') startEdit(btn.closest('.msg'), m);
  else if (act === 'editcancel') renderAll();
  else if (act === 'editsave') {
    const text = btn.closest('.msg').querySelector('.editbox').value.trim();
    if (!text && !(m.attachments || []).length) return;
    const spec = beginFork(idx), nm = { role: 'user', content: text };
    if (m.attachments) nm.attachments = m.attachments;
    state.chat.messages.push(nm); finishFork(spec, nm);
    renderAll(); await generate();
  }
  else if (act === 'regen') { const spec = beginFork(idx); await generate(spec); }
  else if (act === 'vprev') switchBranch(idx, -1);
  else if (act === 'vnext') switchBranch(idx, 1);
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
    updateThinkUI();
    if (!models.length) $('#status').textContent = 'No models found. Run: ollama pull <model>';
  } catch (e) {
    sel.innerHTML = '<option value="">Ollama unreachable</option>';
    $('#status').textContent = 'Cannot reach Ollama — start it with: ollama serve';
  }
  await loadProjects();
  newChat();
  refreshChats();
})();
