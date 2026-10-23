'use strict';
const $ = (s) => document.querySelector(s);
// The second pane of Lumen (features/splitview.js) is this app in an embed mode: no
// sidebar, a compact header. One source of truth for the mode — the feature scripts
// read `isEmbed` from here instead of working it out a second time.
const isEmbed = new URLSearchParams(location.search).get('embed') === '1';
if (isEmbed) {
  document.body.classList.add('embed');
  const embedHead = document.querySelector('header');
  if (embedHead) embedHead.classList.add('compact');
}
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
  settings: { memoryEnabled: true, memories: [], styles: [] },
  skills: [],          // the skills of the user (folders with a SKILL.md)
  mcp: [],             // MCP servers incl. status + tools
  toolsOn: true,
  toolsBusy: false,    // a tool-call round is running / awaiting approval
  stopTools: false,
  project: null,       // active project id
  projectData: null,   // active project incl. knowledge text
};

// Feature hooks: optional steps register callbacks here (see public/features/).
const hooks = {
  onMsgAction: null,   // (act, m, idx) => true when the feature handled the click
  onOpenChat: null,    // (chat) after a chat is opened
  onNewChat: null,     // () after a new chat starts
  onReply: null,       // (reply) after an assistant reply finishes
  onRender: null,      // () after the messages are re-rendered
  onToolsRender: null, // () after the list of MCP servers is re-rendered
  onChatsRender: null, // () after the list of chats has been rendered
  onPersist: null,     // (chatId) after a chat was saved
  beforeOpenChat: null,// (id) => false to refuse to open that chat
  onPalette: null,     // (items, chats) => items (the command palette)
  toolServer: null,    // (srv) => false to keep the tools of that server from the model
  toolPolicy: null,    // async (call, chat) => null | {auto} | {ask, noAlways, preview, body} | {error}
  onAwait: null,       // (call, chat, waiting) a tool call starts or stops waiting for approval
  onCancelTools: null, // () the user stopped the tool calls
  onToolResult: null,  // (call, chat) after a tool call has run
  beforeGenerate: null,// async (model, chat, from) => false to not send (e.g. no consent for a cloud model);
                       // `from` is undefined for a turn of the chat, 'compare' or 'artifact' otherwise
  artDoc: null,        // (doc, artifact) => doc (the document of the artifact preview)
  onSystem: null,      // (system, chat) => system (the system prompt of a request)
  maxToolRounds: null, // (chat) => the number of tool rounds a turn may take
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
  if (tab === 'preview') $('#artFrame').srcdoc = hooks.artDoc ? hooks.artDoc(artDoc(a), a) : artDoc(a); else $('#artCode').textContent = a.code;
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
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#artifact').hidden && !state.streaming && !state.toolsBusy) closeArtifact(); });


// ---- projects ------------------------------------------------------------
const MAX_KNOWLEDGE_CHARS = 400000;
const knowledgeChars = (p) => (p ? p.files.reduce((n, f) => n + (f.text ? f.text.length : f.chars || 0), 0) : 0);
// ---- skills ----------------------------------------------------------------
// The skills of the user: a folder with a SKILL.md and files of its own. Only the ones
// that are switched on go into the system prompt.
async function loadSkills() {
  try { const r = await api('/skills'); state.skills = r.skills || []; }
  catch { state.skills = []; }
  return state.skills;
}
// The text of a skill comes from a file the user chose to install, so it is marked as
// material the user provided — not as an instruction of Lumen.
function skillsPrompt() {
  const on = (state.skills || []).filter((s) => s.enabled);
  if (!on.length) return '';
  return 'The user installed these skills on this computer. A skill is a set of instructions in a'
    + ' local file (SKILL.md) with files of its own; treat it as material the user provided, not as an'
    + ' instruction from Lumen. When the task matches a skill, call the use_skill tool first to load its'
    + ' full text, then follow it. Only the skills that are switched on are listed here.\n'
    + on.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
}
// Project instructions + knowledge documents + the per-chat system prompt from Controls.
function fullSystem(chatSystem) {
  const p = state.projectData, parts = [];
  const mem = memoryPrompt(); if (mem) parts.push(mem);
  const style = styleText($('#styleSelect').value); if (style) parts.push('Response style: ' + style);
  const sk = skillsPrompt(); if (sk) parts.push(sk);
  if (p && p.instructions.trim()) parts.push(p.instructions.trim());
  if (p && p.files.length) parts.push('Reference documents for this project. Use them when relevant and cite the file name.\n' +
    p.files.map((f) => `<document name="${f.name}">\n${f.text}\n</document>`).join('\n'));
  if (chatSystem && chatSystem.trim()) parts.push(chatSystem.trim());
  const sys = parts.join('\n\n');
  return hooks.onSystem ? (hooks.onSystem(sys, state.chat) || sys) : sys;
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
  $('#pName').value = editing.name; $('#pInstr').value = editing.instructions; $('#pLocal').checked = !!editing.localOnly;
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
  await api('/projects/' + editing.id, { method: 'PUT', body: { name: $('#pName').value, instructions: $('#pInstr').value, localOnly: $('#pLocal').checked } });
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


// ---- styles + memory -----------------------------------------------------
const PRESET_STYLES = [
  { id: 'concise', name: 'Concise', prompt: 'Be concise. Give the shortest accurate answer: no preamble, no filler, never restate the question. Use bullet points only when they genuinely help.' },
  { id: 'explanatory', name: 'Explanatory', prompt: 'Explain step by step, as if teaching a curious beginner. Define jargon, give a short concrete example, and finish with a one-line summary.' },
  { id: 'formal', name: 'Formal', prompt: 'Use a formal, professional tone. No contractions, slang or emoji. Organise longer answers under clear headings.' },
  { id: 'friendly', name: 'Friendly', prompt: 'Be warm, relaxed and conversational, like a helpful friend. Keep it light, and avoid heavy formatting.' },
];
function styleText(id) {
  if (!id) return '';
  const s = PRESET_STYLES.find((x) => x.id === id) || state.settings.styles.find((x) => x.id === id);
  return s ? s.prompt : '';
}
function renderStyleSelect(keep) {
  const sel = $('#styleSelect'), cur = keep !== undefined ? keep : sel.value;
  sel.innerHTML = '<option value="">Style: Normal</option>' +
    PRESET_STYLES.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') +
    (state.settings.styles.length ? '<optgroup label="Custom">' + state.settings.styles.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') + '</optgroup>' : '');
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}
// Facts the user asked us to remember. Never used (or saved) in Temporary chats.
function memoryPrompt() {
  const { memoryEnabled, memories } = state.settings;
  if (!memoryEnabled || state.temp || !memories.length) return '';
  return 'Things you remember about the user from earlier conversations. Treat them as background; do not bring them up unless relevant.\n' +
    memories.map((m) => '- ' + m.text).join('\n');
}
async function addMemory(text) {
  if (!state.settings.memoryEnabled) return toast('Memory is turned off (🧠 in the sidebar)');
  try {
    const item = await api('/memories', { method: 'POST', body: { text: text.trim().slice(0, 500) } });
    state.settings.memories.push(item); renderSettings();
    toast('Saved to memory');
  } catch (e) { toast(e.message); }
}
// "Remember that I prefer tabs" -> saved automatically. Questions are left alone.
const REMEMBER_RE = /^\s*(?:please\s+)?remember(?:\s+that|\s*:)?\s+(\S[\s\S]{2,})$/i;
function rememberRequest(text) {
  if (state.temp || /\?\s*$/.test(text)) return null;
  const m = text.match(REMEMBER_RE);
  return m ? m[1].trim() : null;
}
async function loadSettings() { state.settings = await api('/settings'); renderStyleSelect(pref('style') || ''); }

let editingStyle = null;
function renderSettings() {
  $('#memEnabled').checked = state.settings.memoryEnabled;
  const ml = $('#memList'); ml.innerHTML = '';
  for (const m of state.settings.memories) {
    const row = document.createElement('div'); row.className = 'memrow';
    row.innerHTML = `<input value="${esc(m.text)}" maxlength="500" aria-label="Memory"><button type="button" class="icon" title="Forget">✕</button>`;
    const input = row.querySelector('input');
    input.onchange = async () => {
      if (!input.value.trim()) { input.value = m.text; return; }
      try { Object.assign(m, await api('/memories/' + m.id, { method: 'PUT', body: { text: input.value } })); toast('Memory updated'); } catch (e) { toast(e.message); }
    };
    row.querySelector('button').onclick = async () => {
      await api('/memories/' + m.id, { method: 'DELETE' });
      state.settings.memories = state.settings.memories.filter((x) => x.id !== m.id); renderSettings();
    };
    ml.appendChild(row);
  }
  const sl = $('#styleList'); sl.innerHTML = '';
  for (const st of state.settings.styles) {
    const row = document.createElement('div'); row.className = 'strow';
    row.innerHTML = `<span class="nm">${esc(st.name)}</span><span class="pv">${esc(st.prompt)}</span><button type="button" class="icon" data-a="ed" title="Edit">✎</button><button type="button" class="icon" data-a="rm" title="Delete">✕</button>`;
    row.querySelector('[data-a=ed]').onclick = () => { editingStyle = st.id; $('#stName').value = st.name; $('#stPrompt').value = st.prompt; $('#stSave').textContent = 'Save style'; $('#stCancel').hidden = false; };
    row.querySelector('[data-a=rm]').onclick = async () => {
      await api('/styles/' + st.id, { method: 'DELETE' });
      state.settings.styles = state.settings.styles.filter((x) => x.id !== st.id);
      if (editingStyle === st.id) resetStyleForm();
      renderStyleSelect(); renderSettings();
    };
    sl.appendChild(row);
  }
}
function resetStyleForm() { editingStyle = null; $('#stName').value = ''; $('#stPrompt').value = ''; $('#stSave').textContent = 'Add style'; $('#stCancel').hidden = true; }
$('#settingsBtn').onclick = () => { renderSettings(); $('#settingsDlg').showModal(); };
$('#setClose').onclick = () => $('#settingsDlg').close();
$('#memEnabled').onchange = async (e) => { state.settings = await api('/settings', { method: 'PUT', body: { memoryEnabled: e.target.checked } }); };
$('#memAdd').onclick = async () => { const t = $('#memInput').value.trim(); if (t) { await addMemory(t); $('#memInput').value = ''; } };
$('#memInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#memAdd').click(); } });
$('#memClear').onclick = async () => { if (state.settings.memories.length && confirm('Forget everything?')) { await api('/memories', { method: 'DELETE' }); state.settings.memories = []; renderSettings(); } };
$('#stCancel').onclick = resetStyleForm;
$('#stSave').onclick = async () => {
  const body = { name: $('#stName').value, prompt: $('#stPrompt').value };
  if (!body.name.trim() || !body.prompt.trim()) return toast('A style needs a name and instructions');
  try {
    if (editingStyle) { const u = await api('/styles/' + editingStyle, { method: 'PUT', body }); state.settings.styles = state.settings.styles.map((x) => (x.id === u.id ? u : x)); }
    else state.settings.styles.push(await api('/styles', { method: 'POST', body }));
    resetStyleForm(); renderStyleSelect(); renderSettings();
  } catch (e) { toast(e.message); }
};
$('#styleSelect').onchange = () => {
  pref('style', $('#styleSelect').value);
  state.chat.style = $('#styleSelect').value;
  if (state.chat.id && !state.temp) api('/chats/' + state.chat.id, { method: 'PUT', body: { style: state.chat.style } }).catch(() => {});
};


// ---- tools / MCP ---------------------------------------------------------
const approvals = new Map(); // call id -> resolve(choice)
const MAX_TOOL_ROUNDS = 8;
const toolAllow = () => { try { return new Set(JSON.parse(pref('toolAllow') || '[]')); } catch { return new Set(); } };
const saveAllow = (set) => pref('toolAllow', JSON.stringify([...set]));
const slug = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'srv';

async function loadMcp() { try { state.mcp = await api('/mcp'); } catch { state.mcp = []; } updateToolsBtn(); }
function connectedServers() { return state.mcp.filter((x) => x.enabled && x.status === 'connected' && x.tools.length); }
function updateToolsBtn() {
  const n = connectedServers().reduce((t, x) => t + x.tools.length, 0), b = $('#toolsBtn');
  b.classList.toggle('on', state.toolsOn && n > 0); b.dataset.n = n;
}
// Ollama function names must be simple identifiers, so namespace them per server.
function buildTools() {
  const map = new Map(), defs = [], used = new Set();
  for (const srv of connectedServers()) {
    if (hooks.toolServer && hooks.toolServer(srv) === false) continue;
    let prefix = slug(srv.name); while (used.has(prefix)) prefix += '_';
    used.add(prefix);
    for (const t of srv.tools) {
      if (t.enabled === false) continue; // a tool that is switched off never reaches the model
      const name = (prefix + '__' + t.name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      map.set(name, { server: srv.id, serverName: srv.name, tool: t.name });
      defs.push({ type: 'function', function: { name, description: `[${srv.name}] ${t.description}`.slice(0, 1000), parameters: t.inputSchema } });
    }
  }
  return defs.length ? { defs, map } : null;
}
const trailingToolRounds = (msgs) => { let n = 0; for (let i = msgs.length - 1; i >= 0 && msgs[i].toolCalls; i--) n++; return n; };
function registerCall(tc, map) {
  const fn = tc.function || {}, hit = map && map.get(fn.name);
  return {
    id: crypto.randomUUID(), name: fn.name, server: hit ? hit.server : null, serverName: hit ? hit.serverName : 'unknown', tool: hit ? hit.tool : fn.name,
    arguments: fn.arguments && typeof fn.arguments === 'object' ? fn.arguments : {},
    status: hit ? 'queued' : 'error', ...(hit ? {} : { result: `Unknown tool "${fn.name}".` }),
  };
}
const TOOL_STATUS = { queued: 'Queued', awaiting: 'Waiting for your approval', running: 'Running…', done: 'Done', error: 'Failed', denied: 'Denied' };
function toolsHTML(m) {
  if (!m.toolCalls || !m.toolCalls.length) return '';
  return m.toolCalls.map((c) => `<div class="toolcall ${c.status}" data-call="${c.id}">
    <div class="th"><span>🔧</span><b>${esc(c.serverName)} › ${esc(c.tool)}</b><span class="ts">${TOOL_STATUS[c.status] || c.status}</span></div>
    <details><summary>Arguments</summary><pre>${esc(JSON.stringify(c.arguments, null, 2))}</pre></details>
    ${c.preview ? `<pre class="preview ${esc(c.previewKind || '')}">${esc(c.preview)}</pre>` : ''}
    ${c.status === 'awaiting' ? `<div class="appr"><button type="button" class="primary" data-tc="once">Allow once</button>${c.noAlways ? '' : '<button type="button" data-tc="always">Always allow</button>'}<button type="button" class="deny" data-tc="deny">Deny</button></div>` : ''}
    ${c.result ? `<details><summary>Result</summary><pre>${esc(c.result)}</pre></details>` : ''}
  </div>`).join('');
}
function cancelTools() {
  state.stopTools = true;
  for (const res of approvals.values()) res('deny');
  if (hooks.onCancelTools) hooks.onCancelTools();
}
// Runs the model's tool calls one by one, asking permission first. Returns true to let the model continue.
async function runToolCalls(c, reply) {
  state.toolsBusy = true; state.stopTools = false; setBusy(true);
  const repaint = () => {
    const el = $('#messages').children[c.messages.indexOf(reply)];
    if (el && state.chat === c) paint(el, reply, false);
  };
  try {
    for (const call of reply.toolCalls) {
      if (call.status === 'error') { repaint(); continue; }
      if (state.stopTools) { call.status = 'denied'; call.result = 'Cancelled by the user.'; repaint(); continue; }
      const key = `${call.server}/${call.tool}`;
      // A feature may decide how a call is approved (the workspace: reads run, writes
      // and commands show what they do and are asked every time).
      let pol = null;
      if (hooks.toolPolicy) {
        try { pol = await hooks.toolPolicy(call, c); } catch (e) { pol = { error: String(e.message || e) }; }
      }
      if (pol && pol.error) { call.status = 'error'; call.result = pol.error; repaint(); continue; }
      if (pol && pol.preview) { call.preview = pol.preview; call.previewKind = pol.previewKind || ''; }
      if (pol && pol.noAlways) call.noAlways = true;
      if (pol && pol.ask || (!pol || !pol.auto) && !toolAllow().has(key)) {
        call.status = 'awaiting'; repaint(); $('#status').textContent = 'Waiting for your approval…';
        if (hooks.onAwait) hooks.onAwait(call, c, true);
        const choice = await new Promise((res) => approvals.set(call.id, res));
        approvals.delete(call.id);
        if (hooks.onAwait) hooks.onAwait(call, c, false);
        if (choice === 'always' && !call.noAlways) { const a = toolAllow(); a.add(key); saveAllow(a); }
        if (choice === 'deny') { call.status = 'denied'; call.result = state.stopTools ? 'Cancelled by the user.' : 'The user denied permission to run this tool.'; repaint(); continue; }
      }
      call.status = 'running'; repaint(); $('#status').textContent = `Running ${call.tool}…`;
      try {
        const r = await api('/mcp/call', { method: 'POST', body: { server: call.server, tool: call.tool, arguments: call.arguments, ...((pol && pol.body) || {}) } });
        call.status = r.isError ? 'error' : 'done'; call.result = r.text;
      } catch (e) { call.status = 'error'; call.result = 'Tool call failed: ' + (e.message || e); }
      repaint();
      if (hooks.onToolResult) hooks.onToolResult(call, c);
    }
  } finally { state.toolsBusy = false; setBusy(false); }
  return !state.stopTools && state.chat === c;
}
$('#messages').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tc]'); if (!b) return;
  const res = approvals.get(b.closest('.toolcall').dataset.call);
  if (res) res(b.dataset.tc);
});

let mcpBusy = false;
function renderMcp() {
  $('#toolsOn').checked = state.toolsOn;
  const box = $('#mcpList'); box.innerHTML = '';
  for (const srv of state.mcp) {
    const d = document.createElement('div'); d.className = 'mcp';
    d.dataset.id = srv.id;
    const cmd = [srv.command || '', ...(srv.args || [])].filter(Boolean).join(' ');
    const where = srv.builtin ? 'Built in — no process to run' : srv.transport === 'http' ? srv.url : cmd;
    d.innerHTML = `<div class="mh"><span class="dot ${srv.enabled ? srv.status : ''}" title="${srv.enabled ? srv.status : 'disabled'}"></span><span class="nm">${esc(srv.name)}</span>
      <span class="meta">${srv.enabled && srv.status === 'connected' ? srv.tools.length + ' tools' : srv.enabled ? srv.status : 'off'}</span>
      ${srv.builtin ? '' : `<label class="toggle"><input type="checkbox" data-a="en" ${srv.enabled ? 'checked' : ''}> On</label>
      <button type="button" class="icon" data-a="rc" title="Reconnect">↻</button><button type="button" class="icon" data-a="rm" title="Remove">✕</button>`}</div>
      <div class="meta" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(where)}</div>
      ${srv.extension ? `<div class="meta">Extension: ${esc(srv.extension.name || srv.extension.id)}</div>` : ''}
      ${srv.error ? `<div class="err">${esc(srv.error)}</div>` : ''}
      ${srv.stderr ? `<details><summary>Server output (stderr)</summary><pre>${esc(srv.stderr)}</pre></details>` : ''}
      ${srv.tools.length ? `<details><summary>${srv.tools.length} tools</summary>${srv.tools.map((t) => `<div><b>${esc(t.name)}</b> ${esc(t.description).slice(0, 160)}</div>`).join('')}</details>` : ''}`;
    if (srv.builtin) { box.appendChild(d); continue; }
    d.querySelector('[data-a=en]').onchange = async (e) => { await mcpAct(() => api('/mcp/' + srv.id, { method: 'PUT', body: { enabled: e.target.checked } })); };
    d.querySelector('[data-a=rc]').onclick = () => mcpAct(() => api(`/mcp/${srv.id}/reconnect`, { method: 'POST' }));
    d.querySelector('[data-a=rm]').onclick = async () => {
      if (!confirm(`Remove "${srv.name}"? Its process will be stopped.`)) return;
      await mcpAct(() => api('/mcp/' + srv.id, { method: 'DELETE' }));
      const a = toolAllow(); for (const k of [...a]) if (k.startsWith(srv.id + '/')) a.delete(k); saveAllow(a); renderMcp();
    };
    box.appendChild(d);
  }
  renderWeb();
  const al = $('#allowList'); al.innerHTML = '';
  for (const key of toolAllow()) {
    const [sid, ...t] = key.split('/'), srv = state.mcp.find((x) => x.id === sid);
    const row = document.createElement('div'); row.className = 'allow';
    row.innerHTML = `<code>${esc(srv ? srv.name : 'removed server')} › ${esc(t.join('/'))}</code><button type="button" class="ghost">Revoke</button>`;
    row.querySelector('button').onclick = () => { const a = toolAllow(); a.delete(key); saveAllow(a); renderMcp(); };
    al.appendChild(row);
  }
  if (!al.children.length) al.innerHTML = '<span class="sub">None. Choose “Always allow” on a tool call to add one.</span>';
  if (hooks.onToolsRender) hooks.onToolsRender();
}
async function mcpAct(fn) {
  if (mcpBusy) return; mcpBusy = true; $('#mcMsg').textContent = 'Working…';
  try { await fn(); } catch (e) { toast(e.message); }
  await loadMcp(); mcpBusy = false; $('#mcMsg').textContent = ''; renderMcp();
}
const mcType = () => document.querySelector('input[name=mcT]:checked').value;
for (const r of document.querySelectorAll('input[name=mcT]')) r.onchange = () => { $('#mcCmd').hidden = mcType() === 'http'; $('#mcUrl').hidden = mcType() !== 'http'; };
$('#toolsBtn').onclick = async () => { await loadMcp(); renderMcp(); $('#toolsDlg').showModal(); };
$('#toolsClose').onclick = () => $('#toolsDlg').close();
$('#toolsOn').onchange = (e) => { state.toolsOn = e.target.checked; pref('tools', state.toolsOn ? '1' : '0'); updateToolsBtn(); };
$('#mcAdd').onclick = async () => {
  const env = {};
  for (const line of $('#mcEnv').value.split('\n')) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2]; }
  const body = { name: $('#mcName').value, transport: mcType(), command: $('#mcCmd').value, url: $('#mcUrl').value, env };
  if (!body.name.trim()) return toast('Give the server a name');
  const what = body.transport === 'http' ? body.url : body.command;
  if (!what.trim()) return toast(body.transport === 'http' ? 'Enter a URL' : 'Enter a command');
  if (!confirm(`Run this on your computer?\n\n${what}\n\nOnly continue if you trust it.`)) return;
  await mcpAct(async () => {
    const srv = await api('/mcp', { method: 'POST', body });
    $('#mcName').value = ''; $('#mcCmd').value = ''; $('#mcUrl').value = ''; $('#mcEnv').value = '';
    if (srv.status !== 'connected') toast('Added, but it could not connect — see the error below');
  });
};


// ---- web access (built-in tools) -------------------------------------------
function renderWeb() {
  const w = state.settings.web || { enabled: false, provider: '' };
  $('#webOn').checked = w.enabled;
  $('#webCfg').hidden = !w.enabled;
  $('#webProv').value = w.provider || '';
  $('#webUrl').value = w.searxngUrl || '';
  $('#webUrl').hidden = w.provider !== 'searxng' && $('#webProv').value !== 'searxng';
  $('#webKey').hidden = $('#webProv').value !== 'brave';
  $('#webKey').placeholder = w.hasBraveKey ? 'Key saved — leave blank to keep it' : 'Brave Search API key';
}
async function saveWeb(web) {
  state.settings = await api('/settings', { method: 'PUT', body: { web } });
  await loadMcp(); renderMcp();
}
$('#webOn').onchange = (e) => saveWeb({ enabled: e.target.checked }).catch((err) => toast(err.message));
$('#webProv').onchange = () => { $('#webUrl').hidden = $('#webProv').value !== 'searxng'; $('#webKey').hidden = $('#webProv').value !== 'brave'; };
$('#webSave').onclick = async () => {
  try {
    await saveWeb({ provider: $('#webProv').value, searxngUrl: $('#webUrl').value, braveKey: $('#webKey').value });
    $('#webKey').value = ''; toast('Web settings saved');
  } catch (e) { toast(e.message); }
};

// ---- command palette + shortcuts -----------------------------------------
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
const SHORTCUTS = [
  [`${MOD}K`, 'Command palette'], [`${MOD}Shift+O`, 'New chat'], [`${MOD}B`, 'Toggle sidebar'],
  [`${MOD}/`, 'Keyboard shortcuts'], ['Enter / Shift+Enter', 'Send / new line'], ['Esc', 'Stop the reply, or close the artifact'],
];
const toggleSideBar = () => $('#sidebar').classList.toggle('closed');
let palItems = [], palSel = 0;
function buildPalette(chats) {
  const items = [], act = (label, hint, run) => items.push({ label, hint, run });
  act('New chat', `${MOD}Shift+O`, () => newChat());
  act('Toggle sidebar', `${MOD}B`, toggleSideBar);
  act('Toggle dark / light theme', '', () => $('#themeBtn').click());
  if (!$('#thinkWrap').hidden) act('Toggle thinking', '', () => $('#thinkToggle').click());
  act('Toggle temporary chat', '', () => $('#tempToggle').click());
  act('Open controls (system prompt, temperature…)', '', () => $('#controlsBtn').click());
  act('Tools & MCP servers', '', () => $('#toolsBtn').click());
  act('Memory & styles', '', () => $('#settingsBtn').click());
  act('New project', '', () => $('#newProject').click());
  act('Export chats', '', () => $('#exportBtn').click());
  act('Keyboard shortcuts', `${MOD}/`, openHelp);
  for (const m of state.models) act('Model: ' + m.id, 'model', () => { $('#modelSelect').value = m.id; $('#modelSelect').dispatchEvent(new Event('change')); toast('Model: ' + m.id); });
  act('Style: Normal', 'style', () => { $('#styleSelect').value = ''; $('#styleSelect').dispatchEvent(new Event('change')); });
  for (const st of [...PRESET_STYLES, ...state.settings.styles]) act('Style: ' + st.name, 'style', () => { $('#styleSelect').value = st.id; $('#styleSelect').dispatchEvent(new Event('change')); toast('Style: ' + st.name); });
  if (state.project) act('Leave project', 'project', () => selectProject(null));
  for (const p of state.projects) act('Project: ' + p.name, 'project', () => selectProject(p.id));
  for (const c of chats) act('Chat: ' + c.title, 'chat', () => openChat(c.id));
  return hooks.onPalette ? (hooks.onPalette(items, chats) || items) : items;
}
function paletteFilter(items, q) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return items.slice(0, 60);
  return items.map((it) => {
    const l = it.label.toLowerCase(); let score = 0;
    for (const t of toks) { const i = l.indexOf(t); if (i < 0) return null; score += i + (i === 0 || l[i - 1] === ' ' || l[i - 1] === ':' ? -5 : 0); }
    return { it, score: score + l.length / 100 };
  }).filter(Boolean).sort((a, b) => a.score - b.score).map((x) => x.it).slice(0, 60);
}
function renderPalette() {
  const shown = paletteFilter(palItems, $('#palIn').value); palSel = Math.min(palSel, Math.max(shown.length - 1, 0));
  const box = $('#palList'); box.innerHTML = '';
  if (!shown.length) { box.innerHTML = '<div class="pal none">No matches</div>'; return; }
  shown.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'pal' + (i === palSel ? ' sel' : ''); d.setAttribute('role', 'option');
    d.innerHTML = `<span class="l">${esc(it.label)}</span><span class="h">${esc(it.hint || '')}</span>`;
    d.onclick = () => runPalette(it); d.onmousemove = () => { if (palSel !== i) { palSel = i; renderPalette(); } };
    box.appendChild(d);
  });
  box.children[palSel].scrollIntoView({ block: 'nearest' });
  palShown = shown;
}
let palShown = [];
function runPalette(it) { $('#palette').close(); setTimeout(() => it.run(), 30); }
async function openPalette() {
  const dlg = $('#palette'); if (dlg.open) return dlg.close();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  palSel = 0; $('#palIn').value = ''; palItems = buildPalette(state.chats); renderPalette(); dlg.showModal(); $('#palIn').focus();
  try { palItems = buildPalette(await api('/chats')); renderPalette(); } catch { /* sidebar chats are enough */ } // include every project's chats
}
$('#palIn').addEventListener('input', () => { palSel = 0; renderPalette(); });
$('#palIn').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palShown.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (palShown[palSel]) runPalette(palShown[palSel]); }
});
function openHelp() {
  $('#helpList').innerHTML = SHORTCUTS.map(([k, d]) => `<div class="krow"><span>${esc(d)}</span><kbd>${esc(k)}</kbd></div>`).join('');
  $('#helpDlg').showModal();
}
$('#helpClose').onclick = () => $('#helpDlg').close();
window.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSideBar(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
  else if (mod && e.key === '/') { e.preventDefault(); openHelp(); }
  else if (e.key === 'Escape' && (state.streaming || state.toolsBusy) && !document.querySelector('dialog[open]')) $('#stopBtn').click();
});

// ---- voice dictation (browser speech recognition) --------------------------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
if (SpeechRec) $('#micBtn').hidden = false;
function stopDictation() { if (recog) recog.stop(); }
$('#micBtn').onclick = () => {
  if (recog) return stopDictation();
  if (pref('dictConsent') !== '1') {
    if (!confirm('Dictation uses your browser’s built-in speech recognition. In Chrome and Edge the audio is sent to the browser vendor’s servers for transcription, so it is not fully local.\n\nTurn it on?')) return;
    pref('dictConsent', '1');
  }
  const r = recog = new SpeechRec();
  r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = true;
  const base = $('#input').value, sep = base && !/\s$/.test(base) ? ' ' : '';
  let finalText = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const res = e.results[i]; if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript; }
    $('#input').value = base + sep + finalText + interim; autosize();
  };
  r.onerror = (e) => { if (!['aborted', 'no-speech'].includes(e.error)) toast(e.error === 'not-allowed' ? 'Microphone access was blocked' : 'Dictation: ' + e.error); };
  r.onend = () => { recog = null; $('#micBtn').classList.remove('on'); $('#input').focus(); };
  $('#micBtn').classList.add('on');
  try { r.start(); } catch (e) { recog = null; $('#micBtn').classList.remove('on'); toast('Could not start dictation'); }
};


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
const toOllama = ({ role, content, attachments, toolCalls }) => {
  if (role === 'assistant' && toolCalls && toolCalls.length) return [
    { role: 'assistant', content: content || '', tool_calls: toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) },
    ...toolCalls.map((c) => ({ role: 'tool', tool_name: c.name, content: c.result || '(no result)' })),
  ];
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
    <div class="body"><div class="who">${isUser ? 'You' : esc(m.model || state.chat.model || 'Assistant')}</div>
    <div class="content"></div>
    ${versionsHTML(m)}
    <div class="tools">
      <button data-act="copy">Copy</button>
      ${isUser ? '<button data-act="edit">Edit</button><button data-act="mem">Remember</button>'
        : '<button data-act="regen">Regenerate</button><button data-act="regen2">Try another model</button><button data-act="speak">Read aloud</button>'}
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
  else c.innerHTML = thinkHTML(m, live) + toolsHTML(m) + markdown(m.content || '') + (m.error ? `<p class="err">${esc(m.error)}</p>` : '');
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
    const { title } = await api('/title', { method: 'POST', body: { model: c.model, chat: c.id, project: c.project || null, user: first ? first.content || (first.attachments && first.attachments[0].name) : '', assistant: reply.content } });
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
  if (hooks.onRender) hooks.onRender();
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
  if (hooks.onChatsRender) hooks.onChatsRender();
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
  if (state.toolsBusy) cancelTools();
  closeArtifact();
  state.chat = { id: null, title: 'New Chat', model: $('#modelSelect').value, system: $('#systemPrompt').value, style: $('#styleSelect').value, project: state.project, messages: [] };
  if (hooks.onNewChat) hooks.onNewChat();
  renderAll(); renderSidebar(); $('#input').focus();
}
async function openChat(id) {
  if (hooks.beforeOpenChat && hooks.beforeOpenChat(id) === false) return;
  if (state.streaming) state.streaming.abort();
  if (state.toolsBusy) cancelTools();
  closeArtifact();
  state.chat = await api('/chats/' + id);
  for (const m of state.chat.messages) for (const tc of m.toolCalls || []) if (['queued', 'awaiting', 'running'].includes(tc.status)) { tc.status = 'error'; tc.result = tc.result || 'Interrupted before it finished.'; }
  if ((state.chat.project || null) !== state.project) { await setProject(state.chat.project || null); refreshChats(); }
  if (state.chat.model) $('#modelSelect').value = state.chat.model;
  $('#systemPrompt').value = state.chat.system || '';
  renderStyleSelect(state.chat.style || '');
  if (hooks.onOpenChat) hooks.onOpenChat(state.chat);
  renderAll(); renderSidebar();
}
async function persist() {
  const c = state.chat;
  if (state.temp) return;
  if (!c.id) {
    const first = c.messages.find((m) => m.role === 'user');
    c.title = first ? (first.content || (first.attachments && first.attachments[0].name) || 'New Chat').replace(/\s+/g, ' ').slice(0, 48) : 'New Chat';
    const made = await api('/chats', { method: 'POST', body: { title: c.title, model: c.model, system: c.system, style: c.style, project: c.project, messages: c.messages } });
    c.id = made.id;
  } else {
    await api('/chats/' + c.id, { method: 'PUT', body: { messages: c.messages, model: c.model, system: c.system, style: c.style } });
  }
  refreshChats();
  if (hooks.onPersist) hooks.onPersist(state.chat.id);
}

function setBusy(b) {
  $('#sendBtn').hidden = b; $('#stopBtn').hidden = !b;
  $('#status').textContent = b ? 'Generating…' : '';
}

async function generate(fork, model) {
  const c = state.chat;
  c.model = $('#modelSelect').value; c.system = $('#systemPrompt').value.trim();
  // A retry with another model keeps the chat's model but answers this one message with `model`.
  const useModel = model || c.model;
  // Only the call that opens the branch may finish or undo it — a follow-up answer that
  // follows a tool call continues the same branch.
  const ownsFork = !!(fork && !fork.finished);
  if (!useModel) { if (ownsFork) { undoFork(fork); renderAll(); } return toast('No model selected — is Ollama running?'); }
  if (hooks.beforeGenerate && (await hooks.beforeGenerate(useModel, c)) === false) { if (ownsFork) { undoFork(fork); renderAll(); } return; }
  const reply = { role: 'assistant', content: '', model: useModel, t: Date.now() };
  c.messages.push(reply);
  if (ownsFork) { finishFork(fork, reply); fork.finished = true; }
  const caps = (state.models.find((m) => m.id === useModel) || { caps: [] }).caps;
  const canThink = caps.includes('thinking');
  const maxRounds = hooks.maxToolRounds ? (hooks.maxToolRounds(c) || MAX_TOOL_ROUNDS) : MAX_TOOL_ROUNDS;
  const toolSet = state.toolsOn && trailingToolRounds(c.messages) < maxRounds ? buildTools() : null;
  if (toolSet && !caps.includes('tools')) { if (!state.warnedTools) toast(`${useModel} does not support tools — answering without them`); state.warnedTools = true; }
  const useTools = toolSet && caps.includes('tools') ? toolSet : null;
  renderAll();
  const el = $('#messages').lastElementChild;
  const system = fullSystem(c.system);
  const wire = c.messages.slice(0, -1).flatMap(toOllama);
  const ac = state.streaming = new AbortController();
  setBusy(true);
  const t0 = performance.now(); let tokens = 0;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, chat: c.id, project: c.project || null, system, ...(canThink ? { think: $('#thinkToggle').checked } : {}), ...(useTools ? { tools: useTools.defs } : {}), options: settings(system.length + wire.reduce((n, m) => n + m.content.length, 0)),
        messages: wire }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', raf = 0;
    const flush = () => { raf = 0; paint(el, reply, true); $('#messages').scrollTop = $('#messages').scrollHeight; };
    const onChunk = (j) => {
      if (j.error) throw new Error(j.error);
      if (j.message) {
        reply.content += j.message.content || '';
        if (j.message.thinking) {
          if (!thinkT0.has(reply)) thinkT0.set(reply, performance.now());
          reply.thinking = (reply.thinking || '') + j.message.thinking;
        }
        if (j.message.content && thinkT0.has(reply) && reply.thinkMs == null) reply.thinkMs = Math.round(performance.now() - thinkT0.get(reply));
        if (j.message.content) tokens++;
        if (j.message.tool_calls) reply.toolCalls = (reply.toolCalls || []).concat(j.message.tool_calls.map((tc) => registerCall(tc, useTools && useTools.map)));
      }
      // The final chunk carries Ollama's token counters (nanoseconds for the durations).
      if (j.done && (j.eval_count || j.prompt_eval_count)) {
        reply.stats = { prompt_eval_count: j.prompt_eval_count || 0, eval_count: j.eval_count || 0, eval_duration: j.eval_duration || 0, total_duration: j.total_duration || 0 };
      }
      if (!raf) raf = requestAnimationFrame(flush);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) onChunk(JSON.parse(line));
      }
    }
    if (buf.trim()) onChunk(JSON.parse(buf.trim())); // last line without a trailing newline
  } catch (e) {
    if (e.name !== 'AbortError') reply.error = String(e.message || e);
  }
  state.streaming = null; setBusy(false);
  if (reply.toolCalls && (reply.error || ac.signal.aborted)) delete reply.toolCalls; // never run tools from a failed/stopped turn
  if (!reply.content && !reply.error && !reply.thinking && !reply.toolCalls) { c.messages.pop(); if (ownsFork) undoFork(fork); }
  if (reply.thinking && reply.thinkMs == null && thinkT0.has(reply)) reply.thinkMs = Math.round(performance.now() - thinkT0.get(reply));
  paint(el, reply, false);
  renderAll();
  if (reply.toolCalls) {
    const go = await runToolCalls(c, reply);
    await persist().catch(() => {});
    // The follow-up answer belongs to the same branch and the same model as the answer
    // that asked for the tool — a retry with another model must not fall back to the
    // chat's model here.
    if (go) return generate(fork, useModel);
  }
  if (!reply.error) maybeAutoOpenArtifact();
  if (reply.stats && reply.stats.eval_count) {
    const secs = reply.stats.eval_duration / 1e9; // Ollama reports nanoseconds
    const tps = secs > 0 ? (reply.stats.eval_count / secs).toFixed(1) : '0';
    $('#status').textContent = `${tps} tok/s · ${reply.stats.eval_count} tokens · ${(reply.stats.total_duration / 1e9).toFixed(1)}s`;
  } else if (tokens) $('#status').textContent = `${tokens} chunks in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  if (hooks.onReply) hooks.onReply(reply, c);
  persist().then(() => { if (c.id && !c.titled && reply.content && !state.temp) autoTitle(c, reply); }).catch((e) => toast('Save failed: ' + e.message));
}

async function send(text) {
  text = text.trim();
  if ((!text && !state.pending.length) || state.streaming || state.toolsBusy) return;
  await state.ready; // model list may still be loading right after page load
  if (state.processing) return toast('Still reading attachments…');
  const atts = state.pending;
  const model = state.models.find((m) => m.id === $('#modelSelect').value);
  if (atts.some((a) => a.kind === 'image') && model && !model.caps.includes('vision'))
    return toast(`${model.id} can't see images — pick a vision-capable model`);
  const fact = rememberRequest(text);
  if (fact) await addMemory(fact);
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
$('#stopBtn').onclick = () => { if (state.streaming) state.streaming.abort(); if (state.toolsBusy) cancelTools(); };
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
  else if (act === 'mem') { if (state.temp) toast('Temporary chats do not use memory'); else await addMemory(m.content); }
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
  else if (hooks.onMsgAction) await hooks.onMsgAction(act, m, idx);
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
    sel.innerHTML = models.map((m) => `<option value="${esc(m.id)}"${m.cloud ? ' data-cloud="1"' : ''}>${esc(m.label || m.id)}${m.cloud ? ' ☁' : ''}</option>`).join('');
    const saved = pref('model'); if (saved && models.some((m) => m.id === saved)) sel.value = saved;
    updateThinkUI();
    if (!models.length) $('#status').textContent = 'No models found. Run: ollama pull <model>';
  } catch (e) {
    sel.innerHTML = '<option value="">Ollama unreachable</option>';
    $('#status').textContent = 'Cannot reach Ollama — start it with: ollama serve';
  }
  await loadProjects();
  await loadSettings();
  await loadSkills();
  state.toolsOn = pref('tools') !== '0';
  loadMcp();
  newChat();
  refreshChats();
})();
