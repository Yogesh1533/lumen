// Lumen — a self-hosted chat UI for local LLMs (Ollama). Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3100;
const OLLAMA = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DATA_FILE = process.env.LUMEN_DATA || path.join(__dirname, 'data', 'chats.json');
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

// ---- storage -------------------------------------------------------------
let chats = {};
try { chats = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { chats = {}; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(chats));
    fs.renameSync(tmp, DATA_FILE);
  }, 150);
}
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
        body: JSON.stringify({ model: body.model, messages, stream: true, options: body.options || {} }),
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

  if (parts[0] === 'chats') {
    const id = parts[1];
    if (!id && m === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      let list = Object.values(chats);
      if (q) list = list.filter((c) => c.title.toLowerCase().includes(q) ||
        c.messages.some((x) => x.content.toLowerCase().includes(q)));
      list.sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
      return send(res, 200, list.map(summary));
    }
    if (!id && m === 'POST') {
      const b = await readBody(req);
      const now = Date.now();
      const c = { id: crypto.randomUUID(), title: b.title || 'New Chat', model: b.model || '',
        system: b.system || '', pinned: false, created: now, updated: now, messages: b.messages || [] };
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
      for (const k of ['title', 'model', 'system', 'pinned', 'messages']) if (k in b) chats[id][k] = b[k];
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
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
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
}).listen(PORT, '127.0.0.1', () => console.log(`Lumen running at http://localhost:${PORT} (Ollama: ${OLLAMA})`));
