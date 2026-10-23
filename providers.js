// OpenAI-compatible providers (the MiniMax API, OpenRouter, LM Studio, a llama.cpp
// server …). The browser keeps talking the NDJSON of Ollama: this module translates the
// request to /chat/completions and the streamed answer back — the text, the reasoning
// (reasoning_content) as `thinking`, the tool calls (streamed deltas with JSON-string
// arguments) and the token counters.
//
// A model of a provider has the id "<provider id>:<model>", and every provider id starts
// with "pv-", so it never looks like a model of Ollama.
const crypto = require('crypto');

const PRESETS = [
  { key: 'minimax', name: 'MiniMax API', baseUrl: 'https://api.minimax.io/v1', models: ['MiniMax-M3.1-Flash-Preview'], caps: ['tools'], note: 'Needs an API key from MiniMax. Prompts leave this computer.' },
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['minimax/minimax-m3.1-flash:free'], caps: ['tools'], note: 'Needs an OpenRouter API key. Prompts leave this computer.' },
  { key: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', models: [], caps: ['tools'], note: 'Runs on this computer. Start the server in LM Studio first.' },
  { key: 'llamacpp', name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1', models: [], caps: [], note: 'Runs on this computer (llama-server).' },
];
const CAPS = ['tools', 'vision', 'thinking'];

// A provider on this computer keeps the prompts here; any other host is a cloud.
function isLocal(baseUrl) {
  let h;
  try { h = new URL(baseUrl).hostname.toLowerCase(); } catch { return false; }
  return h === 'localhost' || h === '[::1]' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider';

function cleanProvider(b, base = {}, taken = []) {
  const p = { ...base };
  if (b.name !== undefined) p.name = String(b.name).trim().slice(0, 40);
  if (!p.name) throw new Error('A provider needs a name');
  if (b.baseUrl !== undefined) {
    const u = String(b.baseUrl).trim().replace(/\/+$/, '').slice(0, 300);
    if (!/^https?:\/\/[^/\s]+/i.test(u)) throw new Error('The base URL must start with http:// or https://');
    p.baseUrl = u;
  }
  if (!p.baseUrl) throw new Error('A provider needs a base URL');
  if (b.models !== undefined) {
    const list = Array.isArray(b.models) ? b.models : String(b.models).split(/[\n,]/);
    p.models = [...new Set(list.map((m) => String(m).trim()).filter(Boolean).map((m) => m.slice(0, 120)))].slice(0, 100);
  }
  if (!Array.isArray(p.models)) p.models = [];
  if (b.caps !== undefined) p.caps = (Array.isArray(b.caps) ? b.caps : []).filter((c) => CAPS.includes(c));
  if (!Array.isArray(p.caps)) p.caps = [];
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) p.apiKey = b.apiKey.trim().slice(0, 500);
  if (b.clearKey === true) p.apiKey = '';
  if (!p.id) {
    let id = 'pv-' + slug(p.name);
    while (taken.includes(id)) id += '-' + crypto.randomBytes(2).toString('hex');
    p.id = id;
  }
  return p;
}
// What the browser sees: never the key.
const viewProvider = (p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, caps: p.caps, hasKey: !!p.apiKey, local: isLocal(p.baseUrl) });

function splitModel(id, providers) {
  const i = String(id || '').indexOf(':');
  if (i < 0) return null;
  const p = providers.find((x) => x.id === id.slice(0, i));
  return p ? { provider: p, model: id.slice(i + 1) } : null;
}
function listModels(providers) {
  return providers.flatMap((p) => p.models.map((m) => ({ id: `${p.id}:${m}`, label: `${p.name} › ${m}`, provider: p.name, providerId: p.id,
    cloud: !isLocal(p.baseUrl), caps: ['completion', ...p.caps] })));
}

// ---- the request ------------------------------------------------------------------------
// The kind of an image from its first bytes (the browser sends the base64 alone).
function imageMime(b64) {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('R0lG')) return 'image/gif';
  if (b64.startsWith('UklG')) return 'image/webp';
  return 'image/png';
}
// Messages in the shape of Ollama -> the shape of OpenAI. A tool result of Ollama has
// only the name of the tool; OpenAI wants the id of the call it answers, so every call
// of an assistant message gets an id and the results that follow take them in order.
function toOpenAI(messages) {
  const out = [];
  let open = [];   // the ids of the calls that still wait for their result
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c, j) => ({ id: `call_${i}_${j}`, type: 'function',
        function: { name: (c.function || {}).name || '', arguments: JSON.stringify((c.function || {}).arguments || {}) } }));
      open = calls.map((c) => ({ id: c.id, name: c.function.name }));
      out.push({ role: 'assistant', content: m.content || null, tool_calls: calls });
      return;
    }
    if (m.role === 'tool') {
      let k = open.findIndex((c) => c.name === m.tool_name);
      if (k < 0) k = 0;
      const hit = open.splice(k, 1)[0];
      out.push({ role: 'tool', tool_call_id: hit ? hit.id : `call_${i}`, content: String(m.content || '') });
      return;
    }
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      out.push({ role: 'user', content: [{ type: 'text', text: String(m.content || '') },
        ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:${imageMime(b)};base64,${b}` } }))] });
      return;
    }
    out.push({ role: m.role, content: String(m.content || '') });
  });
  return out;
}
function requestBody(model, messages, { tools, options = {}, stream }) {
  const b = { model, messages: toOpenAI(messages), stream: !!stream };
  if (stream) b.stream_options = { include_usage: true };
  if (Array.isArray(tools) && tools.length) b.tools = tools;
  if (typeof options.temperature === 'number') b.temperature = options.temperature;
  if (typeof options.top_p === 'number') b.top_p = options.top_p;
  if (typeof options.num_predict === 'number' && options.num_predict > 0) b.max_tokens = options.num_predict;
  return b;
}
const headers = (p) => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) });
// An error text of a provider must not carry the key back (some echo the header).
const scrub = (text, p) => (p.apiKey ? String(text).split(p.apiKey).join('••••') : String(text));
const parseArgs = (s) => { if (s && typeof s === 'object') return s; try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

// ---- the streamed answer ----------------------------------------------------------------
// Streams /chat/completions and writes NDJSON lines in the shape of Ollama to `res`.
async function streamChat(p, model, messages, opts, res, signal) {
  const t0 = Date.now();
  const r = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', signal, headers: headers(p), body: JSON.stringify(requestBody(model, messages, { ...opts, stream: true })) });
  if (!r.ok) {
    const text = scrub(await r.text(), p).slice(0, 500);
    res.writeHead(r.status >= 400 && r.status < 600 ? r.status : 502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `${p.name}: ${text || r.statusText}` }));
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const line = (o) => res.write(JSON.stringify(o) + '\n');
  const calls = [];   // index -> { id, name, args }
  let usage = null, first = 0, reason = 'stop';
  const onEvent = (j) => {
    if (j.error) { line({ error: scrub(j.error.message || JSON.stringify(j.error), p).slice(0, 500) }); return; }
    if (j.usage) usage = j.usage;
    const ch = (j.choices || [])[0];
    if (!ch) return;
    if (ch.finish_reason) reason = ch.finish_reason;
    const d = ch.delta || ch.message || {};
    const think = d.reasoning_content || d.reasoning;
    if (think) { if (!first) first = Date.now(); line({ model, message: { role: 'assistant', content: '', thinking: String(think) }, done: false }); }
    if (d.content) { if (!first) first = Date.now(); line({ model, message: { role: 'assistant', content: String(d.content) }, done: false }); }
    for (const tc of d.tool_calls || []) {
      const k = typeof tc.index === 'number' ? tc.index : calls.length;
      const c = calls[k] || (calls[k] = { id: '', name: '', args: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function && tc.function.name) c.name += tc.function.name;
      if (tc.function && tc.function.arguments) c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
  };
  const dec = new TextDecoder();
  let buf = '';
  const ctype = r.headers.get('content-type') || '';
  if (!/event-stream/.test(ctype)) {
    // A server that answers a stream request with one JSON body.
    const text = await r.text();
    try { onEvent(JSON.parse(text)); } catch { line({ error: `${p.name}: not a valid answer` }); }
  } else {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
        if (!l.startsWith('data:')) continue;
        const data = l.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onEvent(JSON.parse(data)); } catch { /* a broken event is skipped */ }
      }
    }
  }
  const done = calls.filter((c) => c && c.name);
  if (done.length) line({ model, message: { role: 'assistant', content: '', tool_calls: done.map((c) => ({ function: { name: c.name, arguments: parseArgs(c.args) } })) }, done: false });
  const end = Date.now();
  line({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: reason,
    prompt_eval_count: usage ? usage.prompt_tokens || 0 : 0, eval_count: usage ? usage.completion_tokens || 0 : 0,
    eval_duration: (end - (first || t0)) * 1e6, total_duration: (end - t0) * 1e6 });
  res.end();
}

// One answer without streaming (titles, scheduled tasks), in the shape of Ollama.
async function chatOnce(p, model, messages, opts = {}) {
  const r = await fetch(p.baseUrl + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify(requestBody(model, messages, { ...opts, stream: false })), signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${p.name}: ${scrub(text, p).slice(0, 300) || r.statusText}`);
  const j = JSON.parse(text);
  const m = ((j.choices || [])[0] || {}).message || {};
  return { message: { role: 'assistant', content: m.content || '', thinking: m.reasoning_content || m.reasoning || undefined,
    tool_calls: (m.tool_calls || []).map((c) => ({ function: { name: (c.function || {}).name, arguments: parseArgs((c.function || {}).arguments) } })) } };
}

// The models a provider offers (GET /models).
async function fetchModels(p) {
  const r = await fetch(p.baseUrl + '/models', { headers: headers(p), signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${p.name}: ${scrub(text, p).slice(0, 300) || r.statusText}`);
  const j = JSON.parse(text);
  return (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).slice(0, 500);
}

module.exports = { PRESETS, CAPS, isLocal, cleanProvider, viewProvider, splitModel, listModels, toOpenAI, streamChat, chatOnce, fetchModels };
