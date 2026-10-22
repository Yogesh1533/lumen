// MCP client manager: connects to Model Context Protocol servers (stdio or Streamable HTTP)
// and exposes their tools. Servers are programs/endpoints the user chose to add.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CONNECT_TIMEOUT = 20000;
const CALL_TIMEOUT = 60000;
const MAX_RESULT_CHARS = 12000;
const STDERR_LINES = 200; // how many stderr lines are kept per server (the log viewer)

// Split a command line into argv without invoking a shell (no expansion, no injection).
function shellSplit(str) {
  const out = []; let cur = '', quote = null, has = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < str.length) cur += str[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else if (ch === '\\' && i + 1 < str.length) { cur += str[++i]; has = true; }
    else { cur += ch; has = true; }
  }
  if (quote) throw new Error('Unclosed quote in command');
  if (cur || has) out.push(cur);
  return out;
}

const withTimeout = (p, ms, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
]);

// The last lines a server wrote to stderr. It may hold secrets, so it is only shown in
// the Tools dialog — it never goes into the server log the browser can read.
function stderrTail(lines) {
  // The lines are kept without their newline, so they are joined again here.
  return (lines || []).join('\n').trim().split('\n').slice(-3).join(' ').slice(0, 300);
}

// One stderr line with a timestamp, kept in a small ring buffer per server.
function pushStderr(entry, text) {
  const line = String(text).replace(/\r$/, '');
  if (!line.trim()) return;
  entry.stderr.push(line);
  if (entry.stderr.length > 20) entry.stderr.shift();
  entry.stderrLines.push({ t: Date.now(), text: line });
  if (entry.stderrLines.length > STDERR_LINES) entry.stderrLines.shift();
}

class McpManager {
  constructor() { this.conns = new Map(); }

  info(id) {
    const c = this.conns.get(id);
    if (!c) return { status: 'disconnected', error: null, tools: [], stderr: '' };
    return { status: c.status, error: c.error, tools: c.tools, stderr: stderrTail(c.stderr) };
  }

  // The stderr ring buffer of a server (the log viewer).
  logs(id) {
    const c = this.conns.get(id);
    return { lines: c ? c.stderrLines : [] };
  }

  async connect(cfg) {
    await this.disconnect(cfg.id);
    const entry = { status: 'connecting', error: null, tools: [], client: null, stderr: [], stderrLines: [] };
    this.conns.set(cfg.id, entry);
    try {
      let transport;
      if (cfg.transport === 'http') transport = new StreamableHTTPClientTransport(new URL(cfg.url));
      else {
        // A config with its own args keeps them as they are (a path with a space stays one
        // argument); an older config has only a command line, which is split.
        const [command, ...args] = Array.isArray(cfg.args) ? [cfg.command, ...cfg.args] : shellSplit(cfg.command || '');
        if (!command) throw new Error('Empty command');
        transport = new StdioClientTransport({ command, args, env: { ...(cfg.env || {}) }, stderr: 'pipe' });
        if (transport.stderr) {
          let pending = '';
          transport.stderr.on('data', (d) => {
            pending += String(d);
            const parts = pending.split('\n');
            pending = parts.pop();
            for (const line of parts) pushStderr(entry, line);
            if (pending.length > 2000) { pushStderr(entry, pending); pending = ''; }
          });
        }
      }
      const client = new Client({ name: 'lumen', version: '1.0.0' });
      entry.client = client;
      client.onclose = () => { if (this.conns.get(cfg.id) === entry && entry.status === 'connected') { entry.status = 'error'; entry.error = 'Server exited'; } };
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT, 'Connecting');
      const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT, 'Listing tools');
      entry.tools = tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
      entry.status = 'connected';
    } catch (e) {
      entry.status = 'error';
      entry.error = String(e.message || e).slice(0, 300); // the stderr tail stays out of the log
      try { await entry.client.close(); } catch { /* already gone */ }
    }
    return this.info(cfg.id);
  }

  async disconnect(id) {
    const c = this.conns.get(id);
    this.conns.delete(id);
    if (c && c.client) { try { await c.client.close(); } catch { /* ignore */ } }
  }

  async closeAll() { await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id))); }

  async call(id, tool, args) {
    const c = this.conns.get(id);
    if (!c || c.status !== 'connected') throw new Error('Server is not connected');
    if (!c.tools.some((t) => t.name === tool)) throw new Error(`Unknown tool: ${tool}`);
    const r = await c.client.callTool({ name: tool, arguments: args && typeof args === 'object' ? args : {} }, undefined, { timeout: CALL_TIMEOUT });
    const parts = (r.content || []).map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'resource' && p.resource && typeof p.resource.text === 'string') return p.resource.text;
      return `[${p.type} content omitted]`;
    });
    let text = parts.join('\n') || (r.structuredContent ? JSON.stringify(r.structuredContent) : '(no output)');
    if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + `\n…[truncated ${text.length - MAX_RESULT_CHARS} characters]`;
    return { isError: !!r.isError, text };
  }
}

module.exports = { McpManager, shellSplit };
