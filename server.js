// Lumen — a self-hosted chat UI for local LLMs (Ollama). Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { McpManager } = require('./mcp');
const webtools = require('./webtools');
const claude = require('./claude');
const zip = require('./zip');
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
// Imported extensions are unpacked here: data/extensions/<id>.
const EXT_DIR = path.join(path.dirname(DATA_FILE), 'extensions');
let settings = { memoryEnabled: true, memories: [], styles: [], mcpServers: [], toolToggles: {}, extensions: {}, web: { enabled: false, provider: '', searxngUrl: '', braveKey: '' } };
try { const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); settings = { ...settings, ...saved, web: { ...settings.web, ...(saved.web || {}) } }; } catch { /* first run */ }
if (!settings.toolToggles || typeof settings.toolToggles !== 'object') settings.toolToggles = {};
if (!settings.extensions || typeof settings.extensions !== 'object') settings.extensions = {};
const timers = new Map();
// A small ring buffer of the server's own log lines, shown in Settings > Troubleshooting.
const LOG_MAX = 300;
const logs = [];
function logPush(level, args) {
  logs.push({ t: Date.now(), level, msg: args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ').slice(0, 2000) });
  if (logs.length > LOG_MAX) logs.shift();
}
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => { logPush(level, args); orig(...args); };
}
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
// ---- secrets ---------------------------------------------------------------
// A secret (an MCP env value, a sensitive extension setting) never leaves the server:
// the browser only ever gets the keys and a mask like "••••1234".
const MASK = '••••';
// A masked value keeps the last four characters, so the user can recognise it.
const maskValue = (v) => { const s = String(v == null ? '' : v); return !s ? '' : (s.length > 4 ? MASK + s.slice(-4) : MASK); };
// The extension a server was installed from (its manifest says which settings are secret).
const extensionDef = (c) => (c && c.extension && settings.extensions[c.extension.id]) ? settings.extensions[c.extension.id] : null;
// The plain values that must not show up in a command, an argument or a URL.
function secretValues(c) {
  const out = [];
  for (const v of Object.values((c && c.env) || {})) if (v) out.push(String(v));
  const def = extensionDef(c);
  for (const [k, v] of Object.entries((c && c.userConfig) || {})) {
    if (!v) continue;
    const d = def && def.manifest && def.manifest.user_config && def.manifest.user_config[k];
    if (d && d.sensitive) out.push(String(v));
  }
  return out; // every secret counts, a short one too
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const redact = (text, secrets) => {
  let out = String(text == null ? '' : text);
  for (const s of secrets) {
    if (!s) continue;
    if (s.length >= 4) { out = out.split(s).join(maskValue(s)); continue; }
    // A secret of less than four characters: only a whole word is replaced, so the
    // text around it stays readable.
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(s)}(?![A-Za-z0-9_])`, 'g'), `$1${maskValue(s)}`);
  }
  return out;
};
// What the browser may see of a server: no secret, only masked values.
const viewCfg = (c) => {
  const secrets = secretValues(c);
  return {
    id: c.id, name: c.name, transport: c.transport, enabled: !!c.enabled,
    command: redact(c.command, secrets), args: (c.args || []).map((a) => redact(a, secrets)),
    url: redact(c.url || '', secrets),
    env: Object.fromEntries(Object.entries(c.env || {}).map(([k, v]) => [k, maskValue(v)])),
    envKeys: Object.keys(c.env || {}),
    extension: c.extension ? { id: c.extension.id, name: c.extension.name || '', source: c.extension.source || '' } : null,
  };
};
// ---- tool toggles ----------------------------------------------------------
// Format contract (steps 10 and 12 reuse it): toolToggles[provider][tool] === false means
// the tool is switched off. A missing key means the tool is on. "provider" is the id of the
// MCP server ("builtin" for the built-in web tools, later "skills" and "workspace").
const disabledTools = (provider) => {
  const t = settings.toolToggles[provider];
  if (!t || typeof t !== 'object') return new Set();
  return new Set(Object.entries(t).filter(([, v]) => v === false).map(([k]) => k));
};
const toolEnabled = (provider, tool) => !disabledTools(provider).has(tool);
// What the browser gets for a server: the masked config plus the live status and tools.
// The error and the output of the process are masked as well: a server that writes its
// own command line to stderr must not put a secret into the browser.
const view = (c) => {
  const info = mcp.info(c.id), off = disabledTools(c.id), secrets = secretValues(c);
  return { ...viewCfg(c), ...info,
    error: info.error ? redact(info.error, secrets) : info.error,
    stderr: redact(info.stderr, secrets),
    tools: (info.tools || []).map((t) => ({ ...t, enabled: !off.has(t.name) })) };
};
// The status of a server goes into the log — but never its stderr: that output may
// hold secrets and the log can be read by the browser.
const logStatus = (cfg, info) => {
  if (info.status === 'connected') console.log(`MCP ${cfg.name}: connected (${info.tools.length} tools)`);
  else console.warn(`MCP ${cfg.name}: ${info.status} — details in Settings > Tools`);
};
// The limits of a server configuration. Every server — one that is added by hand and one
// that comes from Claude Desktop — goes through this, so a name, a command, an argument or
// an env value of an outside file can never be longer than it should be.
const cleanCfg = (b, base = {}) => {
  const cfg = { ...base };
  if (b.name !== undefined) cfg.name = String(b.name).trim().slice(0, 40);
  if (b.transport !== undefined) cfg.transport = b.transport === 'http' ? 'http' : 'stdio';
  if (b.command !== undefined) cfg.command = String(b.command).trim().slice(0, 1000);
  if (b.args !== undefined) cfg.args = (Array.isArray(b.args) ? b.args : []).map((a) => String(a).slice(0, 1000)).slice(0, 50);
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
// Two servers are the same when they run the same thing.
const sameServer = (c, s) => (c.transport || 'stdio') === (s.transport || 'stdio')
  && (c.command || '') === (s.command || '')
  && JSON.stringify(c.args || []) === JSON.stringify(s.args || [])
  && (c.url || '') === (s.url || '');

const publicSettings = () => ({ ...settings, mcpServers: settings.mcpServers.map(viewCfg), extensions: undefined, web: { ...settings.web, braveKey: '', hasBraveKey: !!settings.web.braveKey } });
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
// Local calendar day (YYYY-MM-DD) for a timestamp.
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
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
        // Ollama cloud models come back with a remote host; they run outside this machine.
        cloud: !!x.remote_host || /:cloud$/i.test(x.name),
      })));
      return send(res, 200, { models });
    } catch (e) {
      console.warn(`Cannot reach Ollama at ${OLLAMA}: ${e.message || e}`);
      return send(res, 502, { error: `Cannot reach Ollama at ${OLLAMA}`, models: [] });
    }
  }

  // Token usage of every assistant message that recorded the final Ollama chunk counters.
  if (parts[0] === 'usage' && m === 'GET') {
    const models = new Map();
    const days = new Map();
    const totals = { messages: 0, promptTokens: 0, evalTokens: 0, evalMs: 0, totalMs: 0 };
    const add = (map, key, s) => {
      let e = map.get(key);
      if (!e) { e = { promptTokens: 0, evalTokens: 0, evalMs: 0, totalMs: 0, messages: 0 }; map.set(key, e); }
      e.promptTokens += s.prompt_eval_count || 0;
      e.evalTokens += s.eval_count || 0;
      e.evalMs += (s.eval_duration || 0) / 1e6;
      e.totalMs += (s.total_duration || 0) / 1e6;
      e.messages += 1;
    };
    for (const c of Object.values(chats)) {
      for (const msg of c.messages || []) {
        if (!msg || !msg.stats) continue;
        const model = msg.model || c.model || 'unknown';
        const day = dayKey(msg.t || c.updated || c.created || Date.now());
        add(models, model, msg.stats);
        add(days, day, msg.stats);
        totals.messages += 1;
        totals.promptTokens += msg.stats.prompt_eval_count || 0;
        totals.evalTokens += msg.stats.eval_count || 0;
        totals.evalMs += (msg.stats.eval_duration || 0) / 1e6;
        totals.totalMs += (msg.stats.total_duration || 0) / 1e6;
      }
    }
    const rate = (e) => (e.evalMs ? +(e.evalTokens / (e.evalMs / 1000)).toFixed(1) : 0);
    const byModel = [...models].map(([model, e]) => ({ model, ...e, tokensPerSecond: rate(e) }))
      .sort((a, b) => b.evalTokens - a.evalTokens);
    const byDay = [...days].map(([day, e]) => ({ day, ...e, tokensPerSecond: rate(e) })).sort((a, b) => a.day.localeCompare(b.day));
    return send(res, 200, { totals: { ...totals, tokensPerSecond: rate(totals) }, byModel, byDay });
  }

  // The server's own log lines (no chat content).
  if (parts[0] === 'logs' && m === 'GET') {
    return send(res, 200, { lines: logs });
  }

  // Diagnostic report for bug reports: versions, paths, Ollama status — never chat content.
  if (parts[0] === 'diagnostics' && m === 'GET') {
    let ollama = { url: OLLAMA, reachable: false, models: [] };
    try {
      const r = await fetch(`${OLLAMA}/api/tags`);
      const j = await r.json();
      ollama = { url: OLLAMA, reachable: true, models: (j.models || []).map((x) => x.name) };
    } catch { /* Ollama is down — the report says so */ }
    let messages = 0;
    for (const c of Object.values(chats)) messages += (c.messages || []).length;
    return send(res, 200, {
      app: 'Lumen', version: '1.0.0', node: process.version, platform: `${process.platform} ${process.arch}`,
      uptimeSec: Math.round(process.uptime()), dataDir: path.dirname(DATA_FILE),
      ollama, counts: { chats: Object.keys(chats).length, projects: Object.keys(projects).length, messages },
    });
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
    const builtinView = () => {
      const b = builtinServer();
      if (!b) return null;
      const off = disabledTools(b.id);
      return { ...b, tools: (b.tools || []).map((t) => ({ ...t, enabled: !off.has(t.name) })) };
    };
    // Switch tools of a provider on or off (the list of the ones that are off).
    const setTools = (provider, body) => {
      const list = Array.isArray(body.disabled) ? body.disabled.filter((x) => typeof x === 'string').slice(0, 200) : [];
      const t = {};
      for (const name of list) t[name] = false;
      settings.toolToggles[provider] = t;
      saveSettings();
    };
    const id = parts[1];
    if (!id && m === 'GET') {
      const list = settings.mcpServers.map(view);
      const b = builtinView();
      return send(res, 200, b ? [b, ...list] : list);
    }
    if (!id && m === 'POST') {
      if (settings.mcpServers.length >= 20) return send(res, 400, { error: 'Too many servers' });
      let cfg;
      try { cfg = { id: crypto.randomUUID(), transport: 'stdio', enabled: true, env: {}, ...cleanCfg(await readBody(req)) }; } catch (e) { return send(res, 400, { error: e.message }); }
      settings.mcpServers.push(cfg); saveSettings();
      if (cfg.enabled) logStatus(cfg, await mcp.connect(cfg));
      return send(res, 200, view(cfg));
    }
    if (id === 'call' && m === 'POST') {
      const b = await readBody(req);
      if (b.server === 'builtin') {
        const bs = builtinServer();
        if (!bs || !bs.tools.some((t) => t.name === b.tool)) return send(res, 200, { isError: true, text: 'That web tool is not available' });
        if (!toolEnabled('builtin', String(b.tool))) return send(res, 200, { isError: true, text: 'That tool is switched off in Lumen' });
        return send(res, 200, await webtools.call(String(b.tool), b.arguments, settings.web));
      }
      if (!settings.mcpServers.some((c) => c.id === b.server && c.enabled)) return send(res, 404, { error: 'Unknown or disabled server' });
      // A tool that is switched off never runs, not even when something asks for it directly.
      if (!toolEnabled(b.server, String(b.tool))) return send(res, 200, { isError: true, text: 'That tool is switched off in Lumen' });
      try { return send(res, 200, await mcp.call(b.server, String(b.tool), b.arguments)); }
      catch (e) { return send(res, 200, { isError: true, text: 'Tool call failed: ' + String(e.message || e).slice(0, 500) }); }
    }
    // "Reload all": every enabled server is started again.
    if (id === 'reload' && m === 'POST') {
      for (const cfg of settings.mcpServers) if (cfg.enabled) logStatus(cfg, await mcp.connect(cfg));
      return send(res, 200, settings.mcpServers.map(view));
    }
    // The tool switches of the built-in (web) tools.
    if (id === 'builtin' && parts[2] === 'tools' && m === 'PUT') {
      setTools('builtin', await readBody(req));
      return send(res, 200, builtinView() || { id: 'builtin' });
    }
    // The built-in web tools have no process, so they have no log.
    if (id === 'builtin' && parts[2] === 'logs' && m === 'GET') return send(res, 200, { lines: [] });
    const idx = settings.mcpServers.findIndex((c) => c.id === id);
    if (idx < 0) return send(res, 404, { error: 'not found' });
    const cur = settings.mcpServers[idx];
    // The stderr of a server, line by line (the log viewer). The lines are masked: the
    // output of a process may hold a secret (it often writes its own command line).
    if (parts[2] === 'logs' && m === 'GET') {
      const secrets = secretValues(cur);
      const lines = (mcp.logs(id).lines || []).map((l) => ({ t: l.t, text: redact(l.text, secrets) }));
      return send(res, 200, { lines });
    }
    // Replace one env value. The browser never gets the old value back, so it can only
    // send a new one.
    if (parts[2] === 'env' && m === 'PUT') {
      const b = await readBody(req);
      const key = String(b.key || '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return send(res, 400, { error: 'That is not a valid environment variable name' });
      const env = { ...(cur.env || {}) };
      if (b.clear === true) delete env[key];
      else env[key] = String(b.value == null ? '' : b.value).slice(0, 2000);
      cur.env = env;
      settings.mcpServers[idx] = cur; saveSettings();
      if (cur.enabled) { await mcp.disconnect(cur.id); logStatus(cur, await mcp.connect(cur)); }
      return send(res, 200, view(cur));
    }
    // Which tools of this server are switched off.
    if (parts[2] === 'tools' && m === 'PUT') {
      setTools(id, await readBody(req));
      return send(res, 200, view(cur));
    }
    if (parts[2] === 'reconnect' && m === 'POST') { logStatus(cur, await mcp.connect(cur)); return send(res, 200, view(cur)); }
    if (m === 'PUT') {
      let next;
      try { next = cleanCfg(await readBody(req), cur); } catch (e) { return send(res, 400, { error: e.message }); }
      settings.mcpServers[idx] = next; saveSettings();
      if (next.enabled) logStatus(next, await mcp.connect(next)); else await mcp.disconnect(next.id);
      return send(res, 200, view(next));
    }
    if (m === 'DELETE') {
      await mcp.disconnect(id);
      settings.mcpServers.splice(idx, 1);
      delete settings.toolToggles[id]; // the switches of a removed server go with it
      saveSettings();
      return send(res, 200, { ok: true });
    }
  }

  // ---- Claude Desktop (read-only) -------------------------------------------
  // Nothing here writes to Claude's folders: the config is only read, and an extension
  // that Claude has installed is used by reference.
  if (parts[0] === 'claude') {
    const sub = parts[1] || '';
    // What Claude Desktop has. The env values are masked — they never leave the server.
    // A value that also stands in an argument or in the URL is masked there as well.
    if (sub === 'config' && m === 'GET') {
      const found = claude.readConfig();
      const servers = found.servers.map((s) => {
        const secrets = Object.values(s.env || {}).filter(Boolean).map(String);
        return {
          key: s.key, name: s.name, transport: s.transport,
          command: redact(s.command, secrets), args: (s.args || []).map((a) => redact(a, secrets)),
          url: redact(s.url, secrets),
          env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, maskValue(v)])),
          envKeys: Object.keys(s.env || {}),
          duplicate: settings.mcpServers.some((c) => sameServer(c, s)),
        };
      });
      return send(res, 200, { path: found.path, exists: found.exists, servers });
    }
    // Add ONE server. Never automatic: the body has to carry the confirmation of the user.
    if (sub === 'import' && m === 'POST') {
      const b = await readBody(req);
      if (b.confirm !== true) return send(res, 400, { error: 'Importing a server needs an explicit confirmation' });
      const found = claude.readConfig();
      const s = found.servers.find((x) => x.key === b.key);
      if (!s) return send(res, 404, { error: 'That server is not in the Claude config any more' });
      if (settings.mcpServers.length >= 20) return send(res, 400, { error: 'Too many servers' });
      if (settings.mcpServers.some((c) => sameServer(c, s))) return send(res, 409, { error: 'That server is already in Lumen' });
      // The server of an outside file goes through the same limits as one that is added
      // by hand: a name of at most 40 characters, at most 50 arguments, a http(s) URL.
      let cfg;
      try {
        cfg = cleanCfg({ name: s.name, transport: s.transport, command: s.command, args: s.args, env: s.env, url: s.url || '' },
          { id: crypto.randomUUID(), enabled: true, source: 'claude' });
      } catch (e) { return send(res, 400, { error: 'This server cannot be imported: ' + String(e.message || e) }); }
      settings.mcpServers.push(cfg); saveSettings();
      if (cfg.enabled) logStatus(cfg, await mcp.connect(cfg));
      return send(res, 200, view(cfg));
    }
    // The extensions Claude Desktop has installed (read-only, imported by reference).
    if (parts[1] === 'extensions' && !parts[2] && m === 'GET') {
      const list = claude.listExtensions();
      return send(res, 200, {
        dir: list.dir,
        installed: list.installed.map((e) => ({
          id: e.id, name: e.name, version: e.version, path: e.path,
          userConfig: claude.publicUserConfigSchema(e.manifest),
          installed: settings.mcpServers.some((c) => c.extension && c.extension.id === e.id),
        })),
      });
    }
    // Upload a .mcpb / .dxt bundle. It is unpacked into data/extensions/<id>.
    if (parts[1] === 'extensions' && !parts[2] && m === 'POST') {
      const b = await readBody(req);
      let buf;
      try { buf = Buffer.from(String(b.file || ''), 'base64'); } catch { buf = Buffer.alloc(0); }
      if (!buf.length) return send(res, 400, { error: 'The bundle is empty' });
      const id = crypto.randomUUID(), dir = path.join(EXT_DIR, id);
      try { zip.extract(buf, dir); }
      catch (e) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean */ } return send(res, 400, { error: 'The bundle was refused: ' + String(e.message || e) }); }
      const manifest = claude.readManifest(dir);
      if (!manifest) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
        return send(res, 400, { error: 'The bundle has no manifest.json of version 0.3' });
      }
      const rec = { id, name: String(manifest.name || id).slice(0, 80), version: String(manifest.version || ''), dir, source: 'upload', manifest };
      settings.extensions[id] = rec; saveSettings();
      return send(res, 200, { id, name: rec.name, version: rec.version, dir, userConfig: claude.publicUserConfigSchema(manifest), installed: false });
    }
    // The command of an extension, before it runs. The user has to see it and to agree
    // with it — the answer holds the command with the secret values masked.
    if (parts[1] === 'extensions' && parts[2] === 'preview' && m === 'POST') {
      const b = await readBody(req);
      let rec = null;
      if (b.source === 'claude') {
        const e = claude.listExtensions().installed.find((x) => x.id === b.id);
        if (!e) return send(res, 404, { error: 'That extension is not installed in Claude Desktop' });
        rec = { id: e.id, name: e.name, version: e.version, dir: e.path, source: 'claude', manifest: e.manifest };
      } else {
        rec = settings.extensions[b.id] || null;
        if (!rec) return send(res, 404, { error: 'Unknown extension' });
      }
      const schema = claude.userConfigSchema(rec.manifest);
      let values;
      try { values = claude.cleanUserConfig(schema, b.userConfig || {}); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      const cmd = claude.buildCommand(rec.manifest, values, rec.dir);
      if (!cmd.command) return send(res, 400, { error: 'The extension has no command to run' });
      // The values of the sensitive fields and the env values stay hidden: only their
      // place in the command is shown.
      const secrets = [];
      for (const [k, v] of Object.entries(values)) {
        const d = schema[k];
        if (d && d.sensitive && v) for (const x of (Array.isArray(v) ? v : [v])) secrets.push(String(x));
      }
      for (const v of Object.values(cmd.env || {})) if (v) secrets.push(String(v));
      return send(res, 200, {
        name: rec.name || rec.id,
        command: redact(cmd.command, secrets),
        args: (cmd.args || []).map((a) => redact(a, secrets)),
        env: Object.fromEntries(Object.entries(cmd.env || {}).map(([k, v]) => [k, maskValue(v)])),
      });
    }
    // Install an extension: the user filled in the form, Lumen starts the server.
    if (parts[1] === 'extensions' && parts[2] === 'install' && m === 'POST') {
      const b = await readBody(req);
      if (b.confirm !== true) return send(res, 400, { error: 'Installing an extension needs an explicit confirmation' });
      let rec = null;
      if (b.source === 'claude') {
        const e = claude.listExtensions().installed.find((x) => x.id === b.id);
        if (!e) return send(res, 404, { error: 'That extension is not installed in Claude Desktop' });
        // By reference: the files stay where Claude put them.
        rec = { id: e.id, name: e.name, version: e.version, dir: e.path, source: 'claude', manifest: e.manifest };
      } else {
        rec = settings.extensions[b.id] || null;
        if (!rec) return send(res, 404, { error: 'Unknown extension' });
      }
      if (settings.mcpServers.length >= 20) return send(res, 400, { error: 'Too many servers' });
      if (settings.mcpServers.some((c) => c.extension && c.extension.id === rec.id)) return send(res, 409, { error: 'That extension is already in Lumen' });
      const schema = claude.userConfigSchema(rec.manifest);
      let values;
      try { values = claude.cleanUserConfig(schema, b.userConfig || {}); }
      catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      const cmd = claude.buildCommand(rec.manifest, values, rec.dir);
      if (!cmd.command) return send(res, 400, { error: 'The extension has no command to run' });
      const cfg = { id: crypto.randomUUID(), name: rec.name || rec.id, transport: 'stdio', enabled: true,
        command: cmd.command, args: cmd.args, env: cmd.env,
        extension: { id: rec.id, name: rec.name, source: rec.source }, userConfig: values };
      settings.extensions[rec.id] = rec;
      settings.mcpServers.push(cfg); saveSettings();
      logStatus(cfg, await mcp.connect(cfg));
      return send(res, 200, view(cfg));
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
  for (const cfg of settings.mcpServers) if (cfg.enabled) mcp.connect(cfg).then((i) => {
    if (i.status === 'connected') console.log(`MCP ${cfg.name}: connected (${i.tools.length} tools)`);
    else console.warn(`MCP ${cfg.name}: ${i.status} — details in Settings > Tools`);
  });
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => mcp.closeAll().finally(() => process.exit(0)));
