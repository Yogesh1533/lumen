// Minimal Streamable-HTTP MCP server (stateless) for testing Lumen's remote transport.
const req = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const http = require('http');
const { McpServer } = req('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = req('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = req('zod');

http.createServer(async (rq, rs) => {
  if (rq.url !== '/mcp') { rs.writeHead(404); return rs.end(); }
  let body = ''; for await (const c of rq) body += c;
  const server = new McpServer({ name: 'http-test', version: '1.0.0' });
  server.registerTool('shout', { description: 'Uppercase some text.', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() + '!' }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  rs.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(rq, rs, body ? JSON.parse(body) : undefined);
}).listen(3199, '127.0.0.1', () => console.log('http mcp on 3199'));
