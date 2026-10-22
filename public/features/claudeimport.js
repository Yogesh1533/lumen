'use strict';
// Step 9 — import from Claude Desktop: the review dialog for the servers of Claude's config,
// the extension bundles (.mcpb / .dxt), the per-tool switches and the MCP log viewer.
// Loaded after app.js. Both are classic scripts, so app.js's top-level consts (state, api,
// esc, pref, …) live in the same global scope and are used here.

// ---- tool switches ---------------------------------------------------------
// A checkbox per tool: a tool that is switched off is not sent to the model and the server
// refuses to run it. The switches live in Lumen's own settings (settings.toolToggles).
// The state of the switches is kept here as well. Two clicks in a row must not lose one
// another: the second click starts from the state of the first one, not from the state of
// the last render. The requests of one server go one after the other, so the last one
// carries the whole set of the switches.
const toolOff = new Map();   // server id -> Set of the tools that are off
const toolBusy = new Map();  // server id -> the number of the requests that are on the way
const toolChain = new Map(); // server id -> the request that is running

function renderToolToggles() {
  const box = $('#toolToggles');
  if (!box) return;
  box.innerHTML = '';
  const servers = (state.mcp || []).filter((s) => s.tools && s.tools.length);
  if (!servers.length) { box.innerHTML = '<span class="sub">No tools yet — connect a server first.</span>'; return; }
  for (const srv of servers) {
    // While a request is on the way, the state of the switches is the one of this page.
    // Otherwise it comes from the server.
    if (!toolBusy.get(srv.id)) toolOff.set(srv.id, new Set((srv.tools || []).filter((t) => t.enabled === false).map((t) => t.name)));
    const off = toolOff.get(srv.id) || new Set();
    const d = document.createElement('div');
    d.className = 'toggles';
    d.dataset.id = srv.id;
    d.innerHTML = `<div class="nm">${esc(srv.name)}</div>`;
    for (const t of srv.tools) {
      const row = document.createElement('label');
      row.className = 'tog';
      row.innerHTML = `<input type="checkbox" ${off.has(t.name) ? '' : 'checked'}><span class="tn">${esc(t.name)}</span><span class="td">${esc(t.description).slice(0, 90)}</span>`;
      row.querySelector('input').onchange = (e) => {
        const on = e.target.checked;
        const set = toolOff.get(srv.id) || new Set();
        if (on) set.delete(t.name); else set.add(t.name);
        toolOff.set(srv.id, set);
        toolBusy.set(srv.id, (toolBusy.get(srv.id) || 0) + 1);
        const list = [...set];
        toast(on ? `${t.name} is on` : `${t.name} is switched off`);
        const prev = toolChain.get(srv.id) || Promise.resolve();
        const next = prev.catch(() => {}).then(async () => {
          try { await api(`/mcp/${srv.id}/tools`, { method: 'PUT', body: { disabled: list } }); }
          catch (err) { toast(err.message); }
          const n = (toolBusy.get(srv.id) || 1) - 1;
          toolBusy.set(srv.id, n);
          if (n <= 0) {
            toolChain.delete(srv.id);
            try { await loadMcp(); renderMcp(); } catch (e) { /* the list stays as it is */ }
          }
        });
        toolChain.set(srv.id, next);
      };
      d.appendChild(row);
    }
    box.appendChild(d);
  }
}
const prevToolsRender = hooks.onToolsRender;
hooks.onToolsRender = () => { if (prevToolsRender) prevToolsRender(); renderToolToggles(); addLogButtons(); };

// ---- the log viewer --------------------------------------------------------
// Every server keeps its last stderr lines; the viewer shows them per server.
async function openLogs(id, name) {
  $('#logTitle').textContent = name || id;
  $('#logBox2').textContent = 'Loading…';
  // The Refresh button needs to know which server it belongs to.
  $('#mcpLogsDlg').dataset.srv = id;
  $('#mcpLogsDlg').showModal();
  try {
    const r = await api(`/mcp/${id}/logs`);
    const lines = (r.lines || []).map((l) => `${new Date(l.t).toISOString().slice(11, 19)} ${l.text}`);
    $('#logBox2').textContent = lines.join('\n') || '(no output yet)';
  } catch (e) { $('#logBox2').textContent = 'Could not read the log: ' + (e.message || e); }
}
$('#logClose2').onclick = () => $('#mcpLogsDlg').close();
$('#logRefresh2').onclick = () => openLogs($('#mcpLogsDlg').dataset.srv, $('#logTitle').textContent);
// A "logs" button on every server row.
function addLogButtons() {
  for (const row of document.querySelectorAll('#mcpList .mcp')) {
    const id = row.dataset.id;
    if (!id || row.querySelector('[data-a=log]')) continue;
    const srv = state.mcp.find((s) => s.id === id) || {};
    if (srv.builtin) continue; // the built-in web tools have no process and no log
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'icon'; b.dataset.a = 'log'; b.title = 'Server log';
    b.textContent = '≡';
    b.onclick = () => openLogs(id, srv.name);
    row.querySelector('.mh').appendChild(b);
    {
      const e = document.createElement('button');
      e.type = 'button'; e.className = 'icon'; e.dataset.a = 'env'; e.title = 'Environment variables';
      e.textContent = '✎';
      e.onclick = () => openEnv(srv);
      row.querySelector('.mh').appendChild(e);
    }
  }
}

// ---- environment variables --------------------------------------------------
// The values are secrets: the server keeps them and never sends them back. To change one,
// a new value is sent — the old one is never read.
function openEnv(srv) {
  const box = $('#envFields');
  box.innerHTML = '';
  $('#envTitle').textContent = srv.name;
  $('#envDlg').dataset.srv = srv.id;
  const keys = srv.envKeys || [];
  if (!keys.length) box.innerHTML = '<p class="sub">This server has no environment variables.</p>';
  for (const k of keys) {
    const row = document.createElement('div');
    row.className = 'envrow';
    row.innerHTML = `<code>${esc(k)}</code><span class="meta">${esc((srv.env || {})[k] || '')}</span>
      <input type="password" placeholder="new value" autocomplete="off" aria-label="New value for ${esc(k)}">
      <button type="button" class="ghost">Remove</button>`;
    row.querySelector('button').onclick = async () => {
      try { await api(`/mcp/${srv.id}/env`, { method: 'PUT', body: { key: k, clear: true } }); toast('Removed'); await loadMcp(); renderMcp(); $('#envDlg').close(); }
      catch (err) { toast(err.message); }
    };
    box.appendChild(row);
  }
  $('#envDlg').showModal();
}
$('#envCancel').onclick = () => $('#envDlg').close();
$('#envSave').onclick = async () => {
  const id = $('#envDlg').dataset.srv;
  let changed = 0;
  for (const row of document.querySelectorAll('#envFields .envrow')) {
    const key = row.querySelector('code').textContent;
    const input = row.querySelector('input');
    if (!input.value) continue;
    try { await api(`/mcp/${id}/env`, { method: 'PUT', body: { key, value: input.value } }); changed++; }
    catch (e) { toast(e.message); }
  }
  $('#envDlg').close();
  await loadMcp(); renderMcp();
  toast(changed ? 'Environment updated' : 'Nothing to change');
};
// "Reload all": every enabled server is started again.
$('#mcpReloadAll').onclick = async () => {
  try { await api('/mcp/reload', { method: 'POST' }); await loadMcp(); renderMcp(); toast('Servers reloaded'); }
  catch (e) { toast(e.message); }
};

// ---- importing from Claude Desktop -----------------------------------------
const claudeState = { servers: [], path: '', exists: false, extensions: [], pending: null };

function envText(srv) {
  const keys = srv.envKeys || [];
  if (!keys.length) return '';
  return keys.map((k) => `${k} = ${(srv.env && srv.env[k]) || ''}`).join('  ');
}
function renderClaudeServers() {
  const box = $('#claudeList');
  box.innerHTML = '';
  if (!claudeState.exists) { box.innerHTML = '<p class="sub">No Claude Desktop config was found on this computer.</p>'; return; }
  if (!claudeState.servers.length) { box.innerHTML = '<p class="sub">Claude Desktop has no MCP servers in its config.</p>'; return; }
  for (const s of claudeState.servers) {
    const d = document.createElement('div');
    d.className = 'cimp';
    d.dataset.key = s.key;
    const cmd = [s.command || s.url || '', ...(s.args || [])].filter(Boolean).join(' ');
    d.innerHTML = `<div class="nm">${esc(s.name)}</div>
      <div class="meta">${esc(cmd)}</div>
      ${envText(s) ? `<div class="meta env">${esc(envText(s))}</div>` : ''}
      ${s.duplicate ? '<div class="meta">Already in Lumen</div>' : ''}`;
    if (!s.duplicate) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ghost'; b.textContent = 'Add';
      b.onclick = () => addClaudeServer(s, cmd);
      d.appendChild(b);
    }
    box.appendChild(d);
  }
}
// The trust confirmation — the same one as for a server that is added by hand.
async function addClaudeServer(s, cmd) {
  const env = envText(s);
  if (!confirm(`Run this on your computer?\n\n${cmd}${env ? '\n\nEnvironment: ' + env : ''}\n\nOnly continue if you trust it.`)) return;
  try {
    await api('/claude/import', { method: 'POST', body: { key: s.key, confirm: true } });
    toast(`Added "${s.name}"`);
    await loadClaude();
    await loadMcp();
    renderMcp();
  } catch (e) { toast(e.message); }
}

// ---- extensions ------------------------------------------------------------
// The extensions Claude Desktop has installed (imported by reference) and the bundles the
// user uploads. Both end in the same form, built from the user_config of the manifest.
function renderExtensions() {
  const box = $('#claudeExt');
  box.innerHTML = '';
  if (!claudeState.extensions.length) box.innerHTML = '<p class="sub">Claude Desktop has no extensions installed.</p>';
  for (const e of claudeState.extensions) {
    const d = document.createElement('div');
    d.className = 'cimp';
    d.innerHTML = `<div class="nm">${esc(e.name)} <span class="meta">${esc(e.version)}</span></div>
      <div class="meta">${esc(e.path)}</div>${e.installed ? '<div class="meta">Already in Lumen</div>' : ''}`;
    if (!e.installed) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ghost'; b.textContent = 'Import';
      b.onclick = () => showExtForm({ id: e.id, name: e.name, source: 'claude', userConfig: e.userConfig || {} });
      d.appendChild(b);
    }
    box.appendChild(d);
  }
}
// A form from the user_config of a manifest. A sensitive field is a password field and
// its default never goes into the page: a secret is only ever typed by the user.
function showExtForm(ext) {
  claudeState.pending = ext;
  const box = $('#extFields');
  box.innerHTML = '';
  const schema = ext.userConfig || {};
  const keys = Object.keys(schema);
  for (const k of keys) {
    const def = schema[k];
    const l = document.createElement('label');
    const title = def.title || k;
    const note = `<span class="sub">${esc(def.type)}${def.required ? ', required' : ''}${def.sensitive ? ', secret' : ''}</span>`;
    if (def.type === 'boolean') {
      l.innerHTML = `<input type="checkbox" data-k="${esc(k)}" data-t="boolean" ${def.default ? 'checked' : ''}><span>${esc(title)}</span>`;
      l.className = 'check';
    } else if (def.multiple) {
      // A list: one value per line. A list that is not a secret shows the default of the
      // manifest. A list of secrets is masked while it is typed and its default stays out
      // of the page: a secret is only ever typed by the user.
      const style = def.sensitive ? ' style="-webkit-text-security:disc;text-security:disc"' : '';
      const list = def.sensitive ? ''
        : (Array.isArray(def.default) ? def.default.join('\n') : (def.default === undefined ? '' : String(def.default)));
      l.innerHTML = `${esc(title)} ${note}
        <textarea rows="2" data-k="${esc(k)}" data-t="${def.sensitive ? 'secretlist' : 'list'}"${style}${def.required ? ' required' : ''}>${esc(list)}</textarea>`;
    } else if (def.sensitive) {
      l.innerHTML = `${esc(title)} ${note}
        <input type="password" data-k="${esc(k)}" data-t="secret" placeholder="${def.default ? '••••' : ''}" autocomplete="off">`;
    } else {
      const type = def.type === 'number' ? 'number' : 'text';
      l.innerHTML = `${esc(title)} ${note}
        <input type="${type}" data-k="${esc(k)}" data-t="${def.type === 'number' ? 'number' : 'text'}" value="${esc(def.default === undefined ? '' : def.default)}"${def.required ? ' required' : ''} autocomplete="off">`;
    }
    box.appendChild(l);
  }
  $('#extFormTitle').textContent = ext.name || ext.id;
  $('#extFormNote').textContent = ext.source === 'claude'
    ? 'The files stay where Claude Desktop put them — Lumen only points at them.'
    : 'The bundle was unpacked into Lumen’s own extensions folder.';
  $('#extForm').hidden = false;
}
function collectExtForm() {
  const out = {};
  for (const el of document.querySelectorAll('#extForm [data-k]')) {
    const k = el.dataset.k;
    const t = el.dataset.t;
    if (t === 'boolean') { out[k] = el.checked; continue; }
    if (t === 'number') { if (el.value !== '') out[k] = Number(el.value); continue; }
    if (t === 'list' || t === 'secretlist') {
      const list = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (list.length) out[k] = list;
      continue;
    }
    if (el.value !== '') out[k] = el.value;
  }
  return out;
}
$('#extCancel').onclick = () => { $('#extForm').hidden = true; claudeState.pending = null; };
$('#extInstall').onclick = async () => {
  const ext = claudeState.pending;
  if (!ext) return;
  const values = collectExtForm();
  // The command of the extension is asked for first: the user has to see what will run
  // on the computer before it runs.
  let preview;
  try {
    preview = await api('/claude/extensions/preview', { method: 'POST', body: { id: ext.id, source: ext.source, userConfig: values } });
  } catch (e) { toast(e.message || 'The extension cannot be run'); return; }
  const cmdline = [preview.command, ...(preview.args || [])].join(' ');
  if (!confirm(`Run this on your computer?\n\n${cmdline}\n\nOnly continue if you trust it.`)) return;
  try {
    const srv = await api('/claude/extensions/install', { method: 'POST', body: { id: ext.id, source: ext.source, userConfig: values, confirm: true } });
    $('#extForm').hidden = true; claudeState.pending = null;
    toast(`Installed "${srv.name}"`);
    await loadClaude();
    await loadMcp();
    renderMcp();
  } catch (e) { toast(e.message); }
};
// Upload a .mcpb / .dxt bundle: the server unpacks it and answers with its manifest.
$('#extFile').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    const ext = await api('/claude/extensions', { method: 'POST', body: { file: data, filename: f.name } });
    showExtForm({ id: ext.id, name: ext.name, source: 'upload', userConfig: ext.userConfig || {} });
  } catch (err) { toast(err.message || 'The bundle was refused'); }
};

async function loadClaude() {
  try {
    const c = await api('/claude/config');
    claudeState.path = c.path; claudeState.exists = c.exists; claudeState.servers = c.servers || [];
    $('#claudePath').textContent = c.exists ? c.path : 'No Claude Desktop config found (' + c.path + ')';
  } catch { claudeState.servers = []; $('#claudePath').textContent = 'Claude Desktop could not be read'; }
  try {
    const e = await api('/claude/extensions');
    claudeState.extensions = e.installed || [];
    $('#claudeExtDir').textContent = e.dir || '';
  } catch { claudeState.extensions = []; }
  renderClaudeServers();
  renderExtensions();
}
$('#claudeImportBtn').onclick = async () => { $('#claudeDlg').showModal(); await loadClaude(); };
$('#claudeClose').onclick = () => $('#claudeDlg').close();
$('#claudeRefresh').onclick = loadClaude;
