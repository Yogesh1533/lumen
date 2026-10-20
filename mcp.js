// MCP client manager: connects to Model Context Protocol servers (stdio or Streamable HTTP)
// and exposes their tools. Servers are programs/endpoints the user chose to add.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CONNECT_TIMEOUT = 20000;
const CALL_TIMEOUT = 60000;
const MAX_RESULT_CHARS = 12000;

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

class McpManager {
  constructor() { this.conns = new Map(); }

  info(id) {
    const c = this.conns.get(id);
    return c ? { status: c.status, error: c.error, tools: c.tools } : { status: 'disconnected', error: null, tools: [] };
  }

  async connect(cfg) {
    await this.disconnect(cfg.id);
    const entry = { status: 'connecting', error: null, tools: [], client: null, stderr: [] };
    this.conns.set(cfg.id, entry);
    try {
      let transport;
      if (cfg.transport === 'http') transport = new StreamableHTTPClientTransport(new URL(cfg.url));
      else {
        const [command, ...args] = shellSplit(cfg.command);
        if (!command) throw new Error('Empty command');
        transport = new StdioClientTransport({ command, args, env: { ...(cfg.env || {}) }, stderr: 'pipe' });
        if (transport.stderr) transport.stderr.on('data', (d) => { entry.stderr.push(String(d)); if (entry.stderr.length > 20) entry.stderr.shift(); });
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
      const tail = entry.stderr.join('').trim().split('\n').slice(-3).join(' ').slice(0, 300);
      entry.error = String(e.message || e).slice(0, 300) + (tail ? ` — ${tail}` : '');
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
