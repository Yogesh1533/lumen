// A fake OpenAI-compatible server for the step-14 tests. It checks what Lumen sends and
// streams what a real provider streams:
//   echo-model    reasoning_content, then the text, then the usage
//   tool-model    first a tool call in streamed pieces (the arguments are a JSON string
//                 cut in parts); once the tool result comes back (with the id of the
//                 call), the answer "TOOL-LOOP-DONE"
//   vision-model  "IMAGE-OK <mime>" when the user message carries an image_url data URI
//   plain-model   one JSON body, not a stream
// GET /v1/models lists them; GET /requests returns what came in; a wrong key gets a 401
// whose body echoes the Authorization header (Lumen must not pass that back).
//   node tests/fake-openai.js <port> <key>
const http = require('http');
const port = Number(process.argv[2] || 3199);
const KEY = process.argv[3] || 'sk-fake-key';
const requests = [];

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let i = 0;
  const next = () => {
    if (i >= events.length) { res.write('data: [DONE]\n\n'); return res.end(); }
    res.write('data: ' + JSON.stringify(events[i++]) + '\n\n');
    setTimeout(next, 15);
  };
  next();
};
const chunk = (delta, extra = {}) => ({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const usage = (p, c) => ({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/requests') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(requests)); }
    const auth = req.headers.authorization || '';
    if (req.url === '/v1/models') {
      if (auth !== 'Bearer ' + KEY) { res.writeHead(401); return res.end(JSON.stringify({ error: { message: 'bad key: ' + auth } })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: ['echo-model', 'tool-model', 'vision-model', 'plain-model'].map((id) => ({ id, object: 'model' })) }));
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let j = {};
    try { j = JSON.parse(body); } catch { /* bad */ }
    requests.push({ auth, body: j });
    if (auth !== 'Bearer ' + KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid key, you sent: ' + auth } })); }
    const msgs = j.messages || [];
    if (j.model === 'echo-model') {
      return sse(res, [chunk({ role: 'assistant', reasoning_content: 'Thinking about ' }), chunk({ reasoning_content: 'the echo.' }),
        chunk({ content: 'Hello from ' }), chunk({ content: 'the fake provider.' }), { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, usage(11, 7)]);
    }
    if (j.model === 'tool-model') {
      const result = msgs.find((m) => m.role === 'tool');
      if (!result) {
        const tool = (j.tools || []).find((t) => /fetch_page$/.test(t.function.name)) || (j.tools || [])[0];
        if (!tool) return sse(res, [chunk({ content: 'NO-TOOLS-SENT' })]);
        const args = JSON.stringify({ url: 'https://example.com/' });
        return sse(res, [
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: tool.function.name, arguments: '' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 9) } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] }),
          { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, usage(20, 5)]);
      }
      // The answer to the tool result: the call it answers must be the call of the
      // assistant message before it, with its arguments as a JSON string.
      const asst = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
      const okShape = asst && typeof asst.tool_calls[0].function.arguments === 'string' && asst.tool_calls[0].id === result.tool_call_id;
      return sse(res, [chunk({ role: 'assistant', content: okShape ? 'TOOL-LOOP-DONE' : 'TOOL-SHAPE-WRONG' }), usage(30, 3)]);
    }
    if (j.model === 'vision-model') {
      const u = msgs.find((m) => m.role === 'user' && Array.isArray(m.content));
      const img = u && u.content.find((p) => p.type === 'image_url');
      const mime = img && (img.image_url.url.match(/^data:([^;]+);base64,/) || [])[1];
      return sse(res, [chunk({ role: 'assistant', content: mime ? 'IMAGE-OK ' + mime : 'NO-IMAGE' }), usage(5, 2)]);
    }
    if (j.model === 'plain-model') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'PLAIN-ANSWER' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no such model ' + j.model } }));
  });
}).listen(port, '127.0.0.1', () => console.log('fake openai on ' + port));
