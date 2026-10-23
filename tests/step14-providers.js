// Step 14 — providers, cloud model labelling, secrets: a fake OpenAI-compatible server
// end to end (text, reasoning, tool-call deltas, images, the tool loop through the
// page), the secret store (settings.json holds no secret; the Keychain with a
// throwaway service name), the one-time consent per destination, "Local only"
// projects and the default model.
const { launch, sleep } = require('./lib/cdplib');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const secrets = require('../secrets.js');
const providers = require('../providers.js');

const ROOT = path.join(__dirname, '..');
const TMP = process.env.LUMEN_TEST_TMP || path.join(os.tmpdir(), 'lumen-tests');
const BASE = process.env.LUMEN_URL || 'http://localhost:3101';
const DATA_FILE = process.env.LUMEN_DATA || path.join(TMP, 'data', 'chats.json');
const DATA_DIR = path.dirname(DATA_FILE);
const KEY = 'sk-fake-' + crypto.randomBytes(6).toString('hex');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function call(method, url, body, base = BASE) {
  const r = await fetch(base + '/api' + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ndjson or text */ }
  return { status: r.status, json, text };
}
const ndjson = (text) => text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
async function startServer(port, env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), LUMEN_SECRETS: 'file', ...env }, stdio: 'ignore' });
  procs.push(p);
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${port}/api/config`)).ok) return p; } catch { /* not yet */ } await sleep(200); }
  throw new Error('server did not start on ' + port);
}

(async () => {
  const h = await launch(BASE, 9354, { preScript: 'window.confirm = () => true;' });
  const { ev, waitFor, ok } = h;

  // ---- 1. the translation (module) -----------------------------------------------
  {
    const out = providers.toOpenAI([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'look', images: ['iVBORw0KGgoAAAA', '/9j/4AAQ'] },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'a__x', arguments: { q: 1 } } }, { function: { name: 'a__y', arguments: {} } }] },
      { role: 'tool', tool_name: 'a__y', content: 'Y' },
      { role: 'tool', tool_name: 'a__x', content: 'X' },
    ]);
    const asst = out[2];
    ok('a tool call gets an id and its arguments as a JSON string', asst.tool_calls[0].id && asst.tool_calls[0].function.arguments === '{"q":1}' && asst.tool_calls[0].type === 'function');
    ok('a tool result answers the call of its tool', out[3].tool_call_id === asst.tool_calls[1].id && out[4].tool_call_id === asst.tool_calls[0].id, JSON.stringify(out.slice(3)));
    ok('an image becomes an image_url data URI with its type', out[1].content[1].image_url.url.startsWith('data:image/png;base64,') && out[1].content[2].image_url.url.startsWith('data:image/jpeg;base64,'));
    ok('localhost and 127.x are local, any other host is a cloud', providers.isLocal('http://localhost:1234/v1') && providers.isLocal('http://127.0.0.5/v1') && !providers.isLocal('https://openrouter.ai/api/v1') && !providers.isLocal('http://192.168.1.5:1234/v1'));
    let threw = '';
    try { providers.cleanProvider({ name: 'x', baseUrl: 'file:///etc' }); } catch (e) { threw = e.message; }
    ok('a provider needs an http(s) URL', /http/.test(threw));
    ok('a provider id never looks like an Ollama model', providers.cleanProvider({ name: 'Open Router', baseUrl: 'https://x.y' }).id === 'pv-open-router');
  }

  // ---- 2. the secret store (module) -------------------------------------------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-vault-'));
    const v = secrets.fileVault(dir);
    v.set('a', 'FILE-SECRET-1'); v.set('b', 'två ✓ "q"');
    ok('the file store keeps and returns a secret', v.get('a') === 'FILE-SECRET-1' && v.get('b') === 'två ✓ "q"');
    ok('the key file is readable only by the user', (fs.statSync(path.join(dir, '.key')).mode & 0o777) === 0o600, (fs.statSync(path.join(dir, '.key')).mode & 0o777).toString(8));
    ok('the store file is not plain text', !fs.readFileSync(path.join(dir, 'secrets.enc')).toString('latin1').includes('FILE-SECRET-1'));
    v.del('a');
    ok('a secret can be removed', v.get('a') === null && v.get('b') !== null);
    // The settings without their secrets, and back.
    const settings = { web: { braveKey: 'BRAVE-ABC' }, providers: [{ id: 'pv-x', name: 'x', baseUrl: 'https://x', apiKey: 'PROV-KEY-1' }],
      mcpServers: [{ id: 'm1', env: { API_TOKEN: 'MCP-TOK-1', LEVEL: 'debug' }, extension: { id: 'e1' }, userConfig: { key: 'EXT-SENS-1', dir: '/tmp' } }],
      extensions: { e1: { manifest: { user_config: { key: { sensitive: true }, dir: {} } } } } };
    const cache = new Map();
    const disk = secrets.sanitize(settings, v, cache);
    const text = JSON.stringify(disk);
    ok('the settings on the disk hold no secret', !/BRAVE-ABC|PROV-KEY-1|MCP-TOK-1|EXT-SENS-1/.test(text), text.slice(0, 200));
    ok('… they hold references instead', disk.web.braveKey.$secret === 'web/brave' && disk.providers[0].apiKey.$secret === 'provider/pv-x/key' && disk.mcpServers[0].env.API_TOKEN.$secret);
    ok('… a setting that is not sensitive stays as it is', disk.mcpServers[0].userConfig.dir === '/tmp');
    ok('the settings in memory keep their values', settings.providers[0].apiKey === 'PROV-KEY-1');
    const back = JSON.parse(text);
    const missing = secrets.resolve(back, v, new Map());
    ok('the settings read from the disk get their secrets back', !missing.length && back.web.braveKey === 'BRAVE-ABC' && back.providers[0].apiKey === 'PROV-KEY-1' && back.mcpServers[0].env.API_TOKEN === 'MCP-TOK-1' && back.mcpServers[0].userConfig.key === 'EXT-SENS-1');
    settings.mcpServers = [];
    secrets.sanitize(settings, v, cache);
    ok('the secrets of a removed server leave the store', v.get('mcp/m1/env/API_TOKEN') === null && v.get('provider/pv-x/key') === 'PROV-KEY-1');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (process.platform === 'darwin') {
    // The Keychain, with a throwaway service name that is removed again.
    const svc = 'lumen-test-' + crypto.randomBytes(4).toString('hex');
    const k = secrets.keychain(svc);
    const val = 'KEYCHAIN-' + crypto.randomBytes(4).toString('hex') + ' "quoted" \\ ✓';
    try {
      k.set('provider/pv-test/key', val);
      ok('the Keychain keeps and returns a secret', k.get('provider/pv-test/key') === val);
      k.set('provider/pv-test/key', 'second');
      ok('the Keychain updates a secret', k.get('provider/pv-test/key') === 'second');
    } finally { k.del('provider/pv-test/key'); }
    ok('the Keychain item is gone after the test', spawnSync('/usr/bin/security', ['find-generic-password', '-s', svc]).status !== 0);
  } else console.log('SKIP the Keychain (not macOS)');

  // ---- 3. the fake provider through the API --------------------------------------------
  const fakePort = await freePort();
  const fake = spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(fakePort), KEY], { stdio: 'ignore' });
  procs.push(fake);
  await sleep(500);
  const FAKE = `http://127.0.0.1:${fakePort}/v1`;
  const prov = await call('POST', '/providers', { name: 'Fake', baseUrl: FAKE, apiKey: KEY, models: 'echo-model\ntool-model\nvision-model\nplain-model', caps: ['tools', 'vision', 'thinking'] });
  ok('a provider is added', prov.status === 200 && prov.json.id === 'pv-fake' && prov.json.hasKey === true && prov.json.local === true, prov.text);
  ok('the key is not in the answer', !prov.text.includes(KEY));
  const allText = (await call('GET', '/providers')).text + (await call('GET', '/settings')).text + (await call('GET', '/mcp')).text;
  ok('the key is never sent back to the browser', !allText.includes(KEY));
  const fetched = await call('POST', '/providers/pv-fake/models');
  ok('the models of a provider can be fetched (with the key)', fetched.status === 200 && fetched.json.models.includes('tool-model'), fetched.text);
  const models = (await call('GET', '/models')).json.models;
  const fm = models.find((m) => m.id === 'pv-fake:echo-model');
  ok('the models of the provider are listed', !!fm && fm.label === 'Fake › echo-model' && fm.cloud === false && fm.caps.includes('tools'), JSON.stringify(fm));
  // Text and reasoning.
  const echo = await call('POST', '/chat', { model: 'pv-fake:echo-model', messages: [{ role: 'user', content: 'hi' }], system: 'be nice', options: { temperature: 0.2 } });
  const lines = ndjson(echo.text);
  ok('the answer streams as NDJSON in the shape of Ollama', echo.status === 200 && lines.map((l) => l.message && l.message.content || '').join('') === 'Hello from the fake provider.', echo.text.slice(0, 200));
  ok('reasoning_content becomes thinking', lines.map((l) => l.message && l.message.thinking || '').join('') === 'Thinking about the echo.');
  const last = lines.at(-1);
  ok('the last line carries the token counters', last.done === true && last.prompt_eval_count === 11 && last.eval_count === 7 && last.eval_duration > 0, JSON.stringify(last));
  const reqs = await (await fetch(`http://127.0.0.1:${fakePort}/requests`)).json();
  const r0 = reqs.at(-1);
  ok('the request has the key, the model, the system prompt and the options', r0.auth === 'Bearer ' + KEY && r0.body.model === 'echo-model' && r0.body.messages[0].role === 'system' && r0.body.temperature === 0.2 && r0.body.stream === true);
  // Tool-call deltas.
  const tools = [{ type: 'function', function: { name: 'web__fetch_page', description: 'x', parameters: { type: 'object', properties: { url: { type: 'string' } } } } }];
  const tc = ndjson((await call('POST', '/chat', { model: 'pv-fake:tool-model', messages: [{ role: 'user', content: 'go' }], tools })).text);
  const callLine = tc.find((l) => l.message && l.message.tool_calls);
  ok('streamed tool-call deltas become one tool call with parsed arguments', !!callLine && callLine.message.tool_calls.length === 1 && callLine.message.tool_calls[0].function.name === 'web__fetch_page' && callLine.message.tool_calls[0].function.arguments.url === 'https://example.com/', JSON.stringify(callLine));
  // Images.
  const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'red.png')).toString('base64');
  const vis = ndjson((await call('POST', '/chat', { model: 'pv-fake:vision-model', messages: [{ role: 'user', content: 'what colour', images: [png] }] })).text);
  ok('an image reaches the provider as a data URI', vis.map((l) => l.message && l.message.content || '').join('') === 'IMAGE-OK image/png');
  const plain = ndjson((await call('POST', '/chat', { model: 'pv-fake:plain-model', messages: [{ role: 'user', content: 'x' }] })).text);
  ok('a provider that answers a stream with one JSON body works too', plain.map((l) => l.message && l.message.content || '').join('') === 'PLAIN-ANSWER');
  const title = await call('POST', '/title', { model: 'pv-fake:plain-model', user: 'hi', assistant: 'hello' });
  ok('titles work with a provider model', title.json && title.json.title === 'PLAIN-ANSWER', title.text);
  // A wrong key: the error does not carry the key back.
  await call('PUT', '/providers/pv-fake', { apiKey: 'sk-wrong-' + KEY });
  const bad = await call('POST', '/chat', { model: 'pv-fake:echo-model', messages: [{ role: 'user', content: 'hi' }] });
  ok('a refused key is reported', bad.status === 401 && /Fake/.test(bad.json.error), bad.text);
  ok('… without the key in the error', !bad.text.includes(KEY), bad.text);
  await call('PUT', '/providers/pv-fake', { apiKey: KEY });

  // ---- 4. no secret in settings.json; a restart keeps them; old plain secrets move -------
  {
    await call('PUT', '/settings', { web: { braveKey: 'BRAVE-SECRET-' + KEY } });
    const mcpTok = 'MCP-ENV-SECRET-' + crypto.randomBytes(4).toString('hex');
    const mcp = await call('POST', '/mcp', { name: 'Env test', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, 'mcp-test-server.js')], env: { SOME_TOKEN: mcpTok } });
    await sleep(700);
    const disk = fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8');
    ok('settings.json holds no provider key, no Brave key, no MCP env value', !disk.includes(KEY) && !disk.includes(mcpTok) && /"\$secret":"provider\/pv-fake\/key"/.test(disk) && /"\$secret":"web\/brave"/.test(disk), disk.slice(0, 160));
    const enc = fs.readFileSync(path.join(DATA_DIR, 'secrets.enc')).toString('latin1');
    ok('the store file does not hold them in plain text', !enc.includes(KEY) && !enc.includes(mcpTok));
    ok('the browser learns that there is a Brave key, not the key', (await call('GET', '/settings')).json.web.hasBraveKey === true && !(await call('GET', '/settings')).text.includes('BRAVE-SECRET'));
    ok('the browser is told where the secrets are, with the warning of the file store', /Encrypted file/.test((await call('GET', '/providers')).json.secretStore.label) && !!(await call('GET', '/providers')).json.secretStore.warning);
    // A second server on the same data reads the key from the store and uses it.
    const p2 = await freePort();
    const s2 = await startServer(p2, { LUMEN_DATA: DATA_FILE });
    const before = (await (await fetch(`http://127.0.0.1:${fakePort}/requests`)).json()).length;
    const r2 = await call('POST', '/chat', { model: 'pv-fake:echo-model', messages: [{ role: 'user', content: 'again' }] }, `http://localhost:${p2}`);
    const after = await (await fetch(`http://127.0.0.1:${fakePort}/requests`)).json();
    ok('after a restart the key comes back from the store', r2.status === 200 && after.length === before + 1 && after.at(-1).auth === 'Bearer ' + KEY);
    s2.kill(); await sleep(300);
    if (mcp.json && mcp.json.id) await call('DELETE', '/mcp/' + mcp.json.id);
    // An older settings.json with a plain secret: the next start moves it into the store.
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-old-'));
    fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify({ web: { enabled: false, provider: 'brave', braveKey: 'PLAIN-OLD-BRAVE' }, mcpServers: [] }));
    const p3 = await freePort();
    const s3 = await startServer(p3, { LUMEN_DATA: path.join(oldDir, 'chats.json') });
    await sleep(600);
    const moved = fs.readFileSync(path.join(oldDir, 'settings.json'), 'utf8');
    ok('a plain secret of an older settings.json moves into the store', !moved.includes('PLAIN-OLD-BRAVE') && /"\$secret":"web\/brave"/.test(moved) && (await call('GET', '/settings', undefined, `http://localhost:${p3}`)).json.web.hasBraveKey === true, moved.slice(0, 160));
    s3.kill();
    fs.rmSync(oldDir, { recursive: true, force: true });
  }

  // ---- 5. consent, local only --------------------------------------------------------------
  {
    const remote = await call('POST', '/providers', { name: 'Remote', baseUrl: 'http://remote.invalid/v1', apiKey: 'sk-remote', models: ['big-model'] });
    ok('a provider on another host is a cloud', remote.json.local === false && (await call('GET', '/models')).json.models.find((m) => m.id === 'pv-remote:big-model').cloud === true);
    const no = await call('POST', '/chat', { model: 'pv-remote:big-model', messages: [{ role: 'user', content: 'x' }] });
    ok('a prompt to a cloud provider needs consent first', no.status === 403 && no.json.needsConsent === 'pv-remote', no.text);
    const oc = await call('POST', '/chat', { model: 'minimax-m3.1-flash:cloud', messages: [{ role: 'user', content: 'x' }] });
    ok('a prompt to an Ollama cloud model needs consent first', oc.status === 403 && oc.json.needsConsent === 'ollama-cloud', oc.text);
    ok('a title is not made by a cloud model without consent', (await call('POST', '/title', { model: 'minimax-m3.1-flash:cloud', user: 'a', assistant: 'b' })).json.title === '');
    const bogus = await call('POST', '/consent', { dest: 'pv-nope' });
    ok('consent is only given to a known destination', bogus.status === 400);
    await call('POST', '/consent', { dest: 'pv-remote' });
    const yes = await call('POST', '/chat', { model: 'pv-remote:big-model', messages: [{ role: 'user', content: 'x' }] });
    ok('with consent the prompt goes (this host does not exist, so it fails after the gate)', yes.status !== 403, `${yes.status} ${yes.text.slice(0, 80)}`);
    const proj = (await call('POST', '/projects', { name: 'Local project' })).json;
    await call('PUT', '/projects/' + proj.id, { localOnly: true });
    const lo = await call('POST', '/chat', { model: 'pv-remote:big-model', project: proj.id, messages: [{ role: 'user', content: 'x' }] });
    ok('a local-only project blocks a cloud model, even with consent', lo.status === 403 && lo.json.localOnly === true, lo.text);
    const pc = (await call('POST', '/chats', { title: 'in local project', project: proj.id, messages: [] })).json;
    const lo2 = await call('POST', '/chat', { model: 'pv-remote:big-model', chat: pc.id, messages: [{ role: 'user', content: 'x' }] });
    ok('… also when only the chat is named', lo2.status === 403 && lo2.json.localOnly === true);
    const loc = await call('POST', '/chat', { model: 'pv-fake:echo-model', project: proj.id, messages: [{ role: 'user', content: 'x' }] });
    ok('a local-only project can use a local model', loc.status === 200);
    const task = await call('POST', '/workspace/schedules', { name: 'Cloud task', prompt: 'x', model: 'minimax-m3.1-flash:cloud', kind: 'interval', every: 60 });
    const ran = await call('POST', `/workspace/schedules/${task.json.id}/run`);
    const tchat = (await call('GET', '/chats/' + ran.json.chat)).json;
    ok('a scheduled task cannot use a cloud model without consent', /Allow it once/.test(tchat.messages.at(-1).content), tchat.messages.at(-1).content);
    await call('DELETE', '/workspace/schedules/' + task.json.id);
    await call('DELETE', '/consent', { dest: 'pv-remote' });
    ok('consent can be revoked', !('pv-remote' in (await call('GET', '/consent')).json.consent));
    h.__proj = proj;
  }

  // ---- 6. the page: the dialog, the tool loop, the consent, local only, the default ------
  await call('PUT', '/settings', { web: { enabled: true } });
  await ev(`location.reload(); 1`);
  await sleep(2500);
  await waitFor(`typeof state === 'object' && state.models.length > 0`, 20000);
  await ev(`state.ready.then(() => 1)`);
  ok('the model list labels the provider models', (await ev(`[...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'pv-fake:tool-model' && o.textContent === 'Fake › tool-model')`)) === true);
  ok('the cloud models are marked ☁', (await ev(`[...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'pv-remote:big-model' && /☁/.test(o.textContent))`)) === true);
  // The providers dialog: add one through the form.
  await ev(`document.querySelector('#settingsBtn').click(); 1`);
  await ev(`document.querySelector('#provBtn').click(); 1`);
  await waitFor(`document.querySelector('#provDlg').open && document.querySelectorAll('#provList .mcp').length >= 2`, 8000);
  ok('the dialog lists the providers without their keys', (await ev(`document.querySelector('#provList').innerText`)).includes('Fake') && !(await ev(`document.body.innerHTML`)).includes(KEY));
  await ev(`(() => { const s = document.querySelector('#pvPreset'); s.value = 'lmstudio'; s.dispatchEvent(new Event('change')); })(); 1`);
  ok('a preset fills the form', (await ev(`document.querySelector('#pvUrl').value`)) === 'http://localhost:1234/v1');
  await ev(`document.querySelector('#pvName').value = 'Second fake'; document.querySelector('#pvUrl').value = ${JSON.stringify(FAKE)}; document.querySelector('#pvKey').value = ${JSON.stringify(KEY)}; document.querySelector('#pvModels').value = 'echo-model'; document.querySelector('#pvSave').click(); 1`);
  await waitFor(`[...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'pv-second-fake:echo-model')`, 8000);
  ok('a provider added in the dialog shows up in the model list', (await ev(`[...document.querySelectorAll('#modelSelect option')].some((o) => o.value === 'pv-second-fake:echo-model')`)) === true);
  ok('the key field is emptied after saving', (await ev(`document.querySelector('#pvKey').value`)) === '');
  ok('the dialog names the secret store and warns about the file store', /Encrypted file/.test(await ev(`document.querySelector('#secretStore').textContent`)) && (await ev(`!document.querySelector('#secretWarn').hidden`)) === true);
  await ev(`document.querySelector('#provClose').click(); document.querySelector('#setClose').click(); 1`);
  // The tool loop through the page: the call is approved like any other.
  await ev(`newChat(); (() => { const s = document.querySelector('#modelSelect'); s.value = 'pv-fake:tool-model'; s.dispatchEvent(new Event('change')); })(); 1`);
  await ev(`send('Use the tool, please.'); 1`);
  const asked = await waitFor(`!!document.querySelector('.toolcall.awaiting')`, 20000);
  ok('the tool call of the provider asks for approval', asked, await ev(`JSON.stringify(state.chat.messages.map((m) => [m.role, (m.content || '').slice(0, 40), (m.toolCalls || []).map((c) => c.tool)]))`));
  if (asked) await ev(`document.querySelector('.toolcall.awaiting [data-tc=once]').click(); 1`);
  await waitFor(`!state.streaming && !state.toolsBusy && /TOOL-LOOP-DONE|TOOL-SHAPE-WRONG/.test((state.chat.messages.at(-1) || {}).content || '')`, 60000);
  ok('the tool loop goes round and the provider sees the result of its call', /TOOL-LOOP-DONE/.test(await ev(`state.chat.messages.at(-1).content`)), await ev(`state.chat.messages.at(-1).content`));
  ok('the tool ran with the arguments of the provider', /example\.com/.test(await ev(`JSON.stringify(state.chat.messages.find((m) => m.toolCalls).toolCalls[0].arguments)`)));
  // Reasoning in the page.
  await ev(`newChat(); (() => { const s = document.querySelector('#modelSelect'); s.value = 'pv-fake:echo-model'; s.dispatchEvent(new Event('change')); })(); 1`);
  await h.ask('Say hello.', 30000);
  ok('the page shows the answer and keeps the reasoning', (await ev(`state.chat.messages.at(-1).content`)) === 'Hello from the fake provider.' && (await ev(`state.chat.messages.at(-1).thinking`)) === 'Thinking about the echo.');
  ok('the token counters of the provider are stored', (await ev(`state.chat.messages.at(-1).stats && state.chat.messages.at(-1).stats.eval_count`)) === 7);
  // The consent dialog: Cancel sends nothing, Allow sends.
  await ev(`newChat(); (() => { const s = document.querySelector('#modelSelect'); s.value = 'pv-remote:big-model'; s.dispatchEvent(new Event('change')); })(); 1`);
  await ev(`send('to the cloud'); 1`);
  await waitFor(`document.querySelector('#consentDlg').open`, 8000);
  ok('the consent dialog names the destination', /Remote \(remote\.invalid\)/.test(await ev(`document.querySelector('#consentText').textContent`)), await ev(`document.querySelector('#consentText').textContent`));
  await ev(`document.querySelector('#consentNo').click(); 1`);
  await sleep(600);
  ok('Cancel sends nothing', (await ev(`state.chat.messages.filter((m) => m.role === 'assistant').length`)) === 0 && !('pv-remote' in (await call('GET', '/consent')).json.consent));
  await ev(`send('to the cloud again'); 1`);
  await waitFor(`document.querySelector('#consentDlg').open`, 8000);
  await ev(`document.querySelector('#consentYes').click(); 1`);
  await waitFor(`!state.streaming && state.chat.messages.some((m) => m.role === 'assistant')`, 20000);
  ok('Allow stores the consent and sends', 'pv-remote' in (await call('GET', '/consent')).json.consent && (await ev(`state.chat.messages.some((m) => m.role === 'assistant')`)) === true);
  ok('the consent is listed in the dialog and can be revoked', await (async () => {
    await ev(`document.querySelector('#provBtn').click(); 1`);
    await waitFor(`/Remote/.test(document.querySelector('#consentList').innerText)`, 5000);
    await ev(`[...document.querySelectorAll('#consentList .allow')].find((r) => /Remote/.test(r.innerText)).querySelector('button').click(); 1`);
    await sleep(600);
    const gone = !('pv-remote' in (await call('GET', '/consent')).json.consent);
    await ev(`document.querySelector('#provClose').click(); 1`);
    return gone;
  })());
  // Local only in the page.
  const proj = h.__proj;
  await ev(`loadProjects().then(() => selectProject(${JSON.stringify(proj.id)})).then(() => 1)`);
  await sleep(600);
  ok('in a local-only project the cloud models cannot be picked', (await ev(`[...document.querySelectorAll('#modelSelect option')].filter((o) => o.dataset.cloud).every((o) => o.disabled) && [...document.querySelectorAll('#modelSelect option')].some((o) => !o.dataset.cloud && !o.disabled)`)) === true);
  await ev(`selectProject(null).then(() => 1)`);
  await sleep(400);
  ok('outside the project they can again', (await ev(`[...document.querySelectorAll('#modelSelect option')].filter((o) => o.dataset.cloud).some((o) => !o.disabled)`)) === true);
  // The default model.
  await call('PUT', '/settings', { defaultModel: 'pv-fake:echo-model' });
  await ev(`api('/settings').then((s) => { state.settings = s; newChat(); return 1; })`);
  await sleep(300);
  ok('a new chat starts with the default model', (await ev(`document.querySelector('#modelSelect').value`)) === 'pv-fake:echo-model');
  await call('PUT', '/settings', { defaultModel: '', web: { enabled: false } });

  for (const id of ['pv-fake', 'pv-second-fake', 'pv-remote']) await call('DELETE', '/providers/' + id);
  ok('removing a provider removes its key from the store', await (async () => { await sleep(500); const v = secrets.fileVault(DATA_DIR); return v.get('provider/pv-fake/key') === null; })());
  h.close();
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
