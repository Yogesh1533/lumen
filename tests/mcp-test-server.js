// Minimal MCP server for testing Lumen's client.
const req = require('module').createRequire(require('path').join(__dirname, '..', 'package.json'));
const { McpServer } = req('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = req('@modelcontextprotocol/sdk/server/stdio.js');
const z = req('zod');

const server = new McpServer({ name: 'lumen-test', version: '1.0.0' });
server.registerTool('add', { description: 'Add two numbers and return the sum.', inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('get_secret_code', { description: 'Returns the vault secret code. Call this whenever the user asks for the secret code.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'The secret code is ORCHID-5521.' }] }));
server.registerTool('always_fails', { description: 'A tool that always fails (for testing).', inputSchema: {} },
  async () => ({ isError: true, content: [{ type: 'text', text: 'Simulated failure: disk on fire' }] }));
process.stderr.write('lumen-test MCP server ready\n');
server.connect(new StdioServerTransport());
