// Lumen — a self-hosted chat UI for local LLMs (Ollama). Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { McpManager } = require('./mcp');
const webtools = require('./webtools');
const mcp = new McpManager();

const PORT = process.env.PORT || 3100;
const OLLAMA = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DATA_FILE = process.env.LUMEN_DATA || path.join(__dirname, 'data', 'chats.json');
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

// ---- storage -------------------------------------------------------------
let chats = {};
try { chats = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { chats = {}; }
const PROJ_FILE = path.join(path.dirname(DATA_FILE), 'projects.json');
let projects = {};
try { projects = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8')); } catch { projects = {}; }
const SETTINGS_FILE = path.join(path.dirname(DATA_FILE), 'settings.json');
let settings = { memoryEnabled: true, memories: [], styles: [], mcpServers: [], web: { enabled: false, provider: '', searxngUrl: '', braveKey: '' } };
try { const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); settings = { ...settings, ...saved, web: { ...settings.web, ...(saved.web || {}) } }; } catch { /* first run */ }
const timers = new Map();
function write(file, obj) {
  clearTimeout(timers.get(file));
  timers.set(file, setTimeout(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }, 150));
}
const save = () => write(DATA_FILE, chats);
const saveProjects = () => write(PROJ_FILE, projects);
const saveSettings = () => write(SETTINGS_FILE, settings);
const publicSettings = () => ({ ...settings, web: { ...settings.web, braveKey: '', hasBraveKey: !!settings.web.braveKey } });
// The built-in "Web" tools appear as a virtual MCP server when enabled.
const builtinServer = () => settings.web.enabled
  ? { id: 'builtin', name: 'Web', builtin: true, transport: 'builtin', enabled: true, status: 'connected', error: null, tools: webtools.tools(settings.web) }
  : null;
const projectSummary = ({ files, ...p }) => ({ ...p, files: files.map(({ text, ...f }) => ({ ...f, chars: text.length })) });
const summary = ({ messages, ...c }) => ({ ...c, count: messages.length });

const pdfParse = require('pdf-parse/lib/pdf-parse.js'); // skip the package's debug-mode index
const capCache = new Map();
async function capabilities(name) {
  if (capCache.has(name)) return capCache.get(name);
  try {
    const r = await fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }) });
    const caps = (await r.json()).capabilities || [];
    capCache.set(name, caps);
    return caps;
  } catch { return []; }
}

// ---- helpers -------------------------------------------------------------
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 80e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Lumen can launch programs (MCP servers), so the API must only answer the Lumen page itself.
// Without this, any website open in your browser could POST to localhost and run commands.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function guard(req, res, isApi) {
  const host = String(req.headers.host || '');
  if (!LOCAL_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase())) { send(res, 403, { error: 'Forbidden host' }); return false; } // DNS rebinding
  if (!isApi) return true;
  const origin = req.headers.origin;
  if (origin && (() => { try { return new URL(origin).host !== host; } catch { return true; } })()) { send(res, 403, { error: 'Cross-origin request blocked' }); return false; }
  if (req.headers['sec-fetch-site'] === 'cross-site') { send(res, 403, { error: 'Cross-site request blocked' }); return false; }
  const hasBody = req.method === 'POST' || req.method === 'PUT';
  if (hasBody && Number(req.headers['content-length'] || 0) > 0 && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    send(res, 415, { error: 'Content-Type must be application/json' }); return false; // blocks "simple" cross-site form posts
  }
  return true;
}

// ---- routes --------------------------------------------------------------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const m = req.method;

  if (parts[0] === 'config') {
    return send(res, 200, { name: 'Lumen', ollama: OLLAMA, version: '1.0.0' });
  }

  if (parts[0] === 'models' && m === 'GET') {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`);
      const j = await r.json();
      const models = await Promise.all((j.models || []).map(async (x) => ({
        id: x.name, size: x.size, family: x.details && x.details.family,
        params: x.details && x.details.parameter_size, caps: await capabilities(x.name),
      })));
      return send(res, 200, { models });
    } catch (e) {
      return send(res, 502, { error: `Cannot reach Ollama at ${OLLAMA}`, models: [] });
    }
  }

  // Extract text from an uploaded PDF (base64 in JSON).
  if (parts[0] === 'extract' && m === 'POST') {
    const b = await readBody(req);
    try {
      const out = await pdfParse(Buffer.from(b.data || '', 'base64'));
      return send(res, 200, { text: out.text.trim(), pages: out.numpages });
    } catch (e) {
      return send(res, 422, { error: 'Could not read PDF: ' + (e.message || e) });
    }
  }

  // Short chat title from the first exchange (non-streaming, thinking off for speed).
  if (parts[0] === 'title' && m === 'POST') {
    const b = await readBody(req);
    try {
      const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        model: b.model, stream: false, think: false, options: { temperature: 0.3, num_predict: 30 },
        messages: [{ role: 'user', content: 'Write a title of 2 to 6 words for this conversation. Reply with only the title, no quotes or punctuation.\n\nUser: ' + String(b.user || '').slice(0, 600) + '\nAssistant: ' + String(b.assistant || '').slice(0, 600) }] }) });
      const j = await r.json();
      const title = String((j.message && j.message.content) || '').split('\n')[0].replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').slice(0, 60);
      return send(res, 200, { title });
    } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }

  // Streaming chat: proxies Ollama /api/chat as NDJSON.
  if (parts[0] === 'chat' && m === 'POST') {
    const body = await readBody(req);
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      const messages = [];
      if (body.system) messages.push({ role: 'system', content: body.system });
      messages.push(...body.messages);
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: body.model, messages, stream: true, options: body.options || {},
          ...(typeof body.think === 'boolean' ? { think: body.think } : {}),
          ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}) }),
      });
      if (!r.ok) return send(res, r.status, { error: (await r.text()).slice(0, 500) });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (!res.headersSent) send(res, 502, { error: String(e.message || e) });
      else res.end();
    }
    return;
  }

  // ---- MCP servers ----------------------------------------------------------
  if (parts[0] === 'mcp') {
    const view = (c) => ({ ...c, ...mcp.info(c.id) });
    const cleanCfg = (b, base = {}) => {
      const cfg = { ...base };
      if (b.name !== undefined) cfg.name = String(b.name).trim().slice(0, 40);
      if (b.transport !== undefined) cfg.transport = b.transport === 'http' ? 'http' : 'stdio';
      if (b.command !== undefined) cfg.command = String(b.command).trim().slice(0, 1000);
      if (b.url !== undefined) cfg.url = String(b.url).trim().slice(0, 500);
      if (b.enabled !== undefined) cfg.enabled = !!b.enabled;
      if (b.env !== undefined) {
        const env = {};
        for (const [k, v] of Object.entries(b.env || {}).slice(0, 20)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v).slice(0, 2000);
        cfg.env = env;
      }
      if (!cfg.name) throw new Error('Name is required');
      if (cfg.transport === 'http') { if (!/^https?:\/\//i.test(cfg.url || '')) throw new Error('A http(s) URL is required'); }
      else if (!cfg.command) throw new Error('A command is required');
      return cfg;
    };
    const id = parts[1];
    if (!id && m === 'GET') return send(res, 200, [builtinServer(), ...settings.mcpServers.map(view)].filter(Boolean));
    if (!id && m === 'POST') {
      if (settings.mcpServers.length >= 20) return send(res, 400, { error: 'Too many servers' });
      let cfg;
      try { cfg = { id: crypto.randomUUID(), transport: 'stdio', enabled: true, env: {}, ...cleanCfg(await readBody(req)) }; } catch (e) { return send(res, 400, { error: e.message }); }
      settings.mcpServers.push(cfg); saveSettings();
      if (cfg.enabled) await mcp.connect(cfg);
      return send(res, 200, view(cfg));
    }
    if (parts[0] === 'mcp' && id === 'call' && m === 'POST') {
      const b = await readBody(req);
      if (b.server === 'builtin') {
        const bs = builtinServer();
        if (!bs || !bs.tools.some((t) => t.name === b.tool)) return send(res, 200, { isError: true, text: 'That web tool is not available' });
        return send(res, 200, await webtools.call(String(b.tool), b.arguments, settings.web));
      }
      if (!settings.mcpServers.some((c) => c.id === b.server && c.enabled)) return send(res, 404, { error: 'Unknown or disabled server' });
      try { return send(res, 200, await mcp.call(b.server, String(b.tool), b.arguments)); }
      catch (e) { return send(res, 200, { isError: true, text: 'Tool call failed: ' + String(e.message || e).slice(0, 500) }); }
    }
    const idx = settings.mcpServers.findIndex((c) => c.id === id);
    if (idx < 0) return send(res, 404, { error: 'not found' });
    const cur = settings.mcpServers[idx];
    if (parts[2] === 'reconnect' && m === 'POST') { await mcp.connect(cur); return send(res, 200, view(cur)); }
    if (m === 'PUT') {
      let next;
      try { next = cleanCfg(await readBody(req), cur); } catch (e) { return send(res, 400, { error: e.message }); }
      settings.mcpServers[idx] = next; saveSettings();
      if (next.enabled) await mcp.connect(next); else await mcp.disconnect(next.id);
      return send(res, 200, view(next));
    }
    if (m === 'DELETE') {
      await mcp.disconnect(id);
      settings.mcpServers.splice(idx, 1); saveSettings();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === 'settings') {
    if (m === 'GET') return send(res, 200, publicSettings());
    if (m === 'PUT') {
      const b = await readBody(req);
      if (typeof b.memoryEnabled === 'boolean') settings.memoryEnabled = b.memoryEnabled;
      if (b.web && typeof b.web === 'object') {
        const w = settings.web;
        if (typeof b.web.enabled === 'boolean') w.enabled = b.web.enabled;
        if (['', 'searxng', 'brave'].includes(b.web.provider)) w.provider = b.web.provider;
        if (typeof b.web.searxngUrl === 'string') {
          const u = b.web.searxngUrl.trim();
          if (u && !/^https?:\/\//i.test(u)) return send(res, 400, { error: 'SearXNG URL must start with http:// or https://' });
          w.searxngUrl = u.slice(0, 300);
        }
        if (typeof b.web.braveKey === 'string' && b.web.braveKey.trim()) w.braveKey = b.web.braveKey.trim().slice(0, 200);
        if (b.web.clearBraveKey) w.braveKey = '';
      }
      saveSettings();
      return send(res, 200, publicSettings());
    }
  }

  // Memory facts and custom styles share the same simple CRUD shape.
  const lists = { memories: ['text'], styles: ['name', 'prompt'] };
  if (lists[parts[0]]) {
    const key = parts[0], fields = lists[key], id = parts[1];
    const clean = (b) => Object.fromEntries(fields.map((f) => [f, String(b[f] || '').trim().slice(0, key === 'memories' ? 500 : f === 'name' ? 40 : 2000)]));
    if (!id && m === 'POST') {
      const item = { id: crypto.randomUUID(), ...clean(await readBody(req)), created: Date.now() };
      if (fields.some((f) => !item[f])) return send(res, 400, { error: fields.join(' and ') + ' required' });
      if (key === 'memories' && settings.memories.length >= 100) return send(res, 400, { error: 'Memory is full (100 items) — delete some first' });
      settings[key].push(item); saveSettings();
      return send(res, 200, item);
    }
    if (!id && m === 'DELETE') { settings[key] = []; saveSettings(); return send(res, 200, { ok: true }); }
    const idx = settings[key].findIndex((x) => x.id === id);
    if (idx < 0) return send(res, 404, { error: 'not found' });
    if (m === 'PUT') {
      const next = { ...settings[key][idx], ...clean(await readBody(req)) };
      if (fields.some((f) => !next[f])) return send(res, 400, { error: fields.join(' and ') + ' required' });
      settings[key][idx] = next; saveSettings();
      return send(res, 200, next);
    }
    if (m === 'DELETE') { settings[key].splice(idx, 1); saveSettings(); return send(res, 200, { ok: true }); }
  }

  if (parts[0] === 'projects') {
    const id = parts[1];
    if (!id && m === 'GET') return send(res, 200, Object.values(projects).sort((a, b) => b.updated - a.updated).map(projectSummary));
    if (!id && m === 'POST') {
      const b = await readBody(req), now = Date.now();
      const p = { id: crypto.randomUUID(), name: (b.name || 'Untitled project').slice(0, 80), instructions: b.instructions || '', files: [], created: now, updated: now };
      projects[p.id] = p; saveProjects();
      return send(res, 200, p);
    }
    const p = projects[id];
    if (!p) return send(res, 404, { error: 'not found' });
    if (parts[2] === 'files') {
      if (m === 'POST') {
        const b = await readBody(req);
        if (!b.name || typeof b.text !== 'string') return send(res, 400, { error: 'name and text required' });
        const f = { id: crypto.randomUUID(), name: String(b.name).slice(0, 200), text: b.text, size: b.size || b.text.length };
        p.files.push(f); p.updated = Date.now(); saveProjects();
        const { text, ...meta } = f;
        return send(res, 200, { ...meta, chars: text.length });
      }
      if (m === 'DELETE' && parts[3]) {
        p.files = p.files.filter((f) => f.id !== parts[3]); p.updated = Date.now(); saveProjects();
        return send(res, 200, { ok: true });
      }
    }
    if (m === 'GET') return send(res, 200, p);
    if (m === 'PUT') {
      const b = await readBody(req);
      if (typeof b.name === 'string') p.name = b.name.trim().slice(0, 80) || p.name;
      if (typeof b.instructions === 'string') p.instructions = b.instructions;
      p.updated = Date.now(); saveProjects();
      return send(res, 200, projectSummary(p));
    }
    if (m === 'DELETE') {
      for (const c of Object.values(chats)) if (c.project === id) c.project = null; // chats are kept
      delete projects[id]; saveProjects(); save();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === 'chats') {
    const id = parts[1];
    if (!id && m === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      let list = Object.values(chats);
      const pf = url.searchParams.get('project');
      if (pf === 'none') list = list.filter((c) => !c.project);
      else if (pf) list = list.filter((c) => c.project === pf);
      if (q) list = list.filter((c) => c.title.toLowerCase().includes(q) ||
        c.messages.some((x) => x.content.toLowerCase().includes(q)));
      list.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
      return send(res, 200, list.map(summary));
    }
    if (!id && m === 'POST') {
      const b = await readBody(req);
      const now = Date.now();
      const c = { id: crypto.randomUUID(), title: b.title || 'New Chat', model: b.model || '',
        system: b.system || '', style: b.style || '', project: projects[b.project] ? b.project : null, pinned: false, created: now, updated: now, messages: b.messages || [] };
      chats[c.id] = c; save();
      return send(res, 200, c);
    }
    if (id && id !== 'export' && !chats[id]) return send(res, 404, { error: 'not found' });
    if (id === 'export' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="lumen-chats.json"' });
      return res.end(JSON.stringify(Object.values(chats), null, 2));
    }
    if (id && m === 'GET') return send(res, 200, chats[id]);
    if (id && m === 'PUT') {
      const b = await readBody(req);
      for (const k of ['title', 'model', 'system', 'pinned', 'messages', 'titled', 'style']) if (k in b) chats[id][k] = b[k];
      if ('project' in b) chats[id].project = projects[b.project] ? b.project : null;
      chats[id].updated = Date.now(); save();
      return send(res, 200, summary(chats[id]));
    }
    if (id && m === 'DELETE') { delete chats[id]; save(); return send(res, 200, { ok: true }); }
    if (!id && m === 'DELETE') { chats = {}; save(); return send(res, 200, { ok: true }); }
  }

  send(res, 404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const isApi = url.pathname.startsWith('/api/');
    if (!guard(req, res, isApi)) return;
    if (isApi) return await api(req, res, url);
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/' || p === '\\' || !path.extname(p)) p = '/index.html'; // SPA fallback
    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Lumen running at http://localhost:${PORT} (Ollama: ${OLLAMA})`);
  for (const cfg of settings.mcpServers) if (cfg.enabled) mcp.connect(cfg).then((i) => console.log(`MCP ${cfg.name}: ${i.status}${i.error ? ' — ' + i.error : ` (${i.tools.length} tools)`}`));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => mcp.closeAll().finally(() => process.exit(0)));
