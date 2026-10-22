// Step 9 — import from Claude Desktop: the review dialog, the extension bundles,
// the per-tool switches, the MCP logs and the reload.
const { launch, sleep } = require('./lib/cdplib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { zip } = require('./lib/zipwrite');
const zipReader = require('../zip.js');
const claudeMod = require('../claude.js');

const TMP = process.env.LUMEN_TEST_TMP || path.join(os.tmpdir(), 'lumen-tests');
const REPO = path.join(__dirname, '..');
const BASE = 'http://localhost:3101';
const DATA_FILE = process.env.LUMEN_DATA || path.join(TMP, 'data', 'chats.json');
const CLAUDE_CFG = process.env.LUMEN_CLAUDE_CONFIG || path.join(TMP, 'claude', 'claude_desktop_config.json');
const CLAUDE_EXT = process.env.LUMEN_CLAUDE_EXTENSIONS || path.join(TMP, 'claude', 'extensions');
const DATA_DIR = path.dirname(DATA_FILE);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const EXT_DIR = path.join(DATA_DIR, 'extensions');

const CLAUDE_SECRET = 'sk-CLAUDE-SECRET-1234';   // in the fixture config of Claude Desktop
const EXT_SECRET = 'FIXTURE-TOKEN-abc123';       // a sensitive setting of the fixture extension
const SHORT_SECRET = 'Q7z';                      // a secret of three characters
const HOME = os.homedir();
const MCP_TEST_SERVER = path.join(REPO, 'tests', 'mcp-test-server.js');

// ---- the fixtures ----------------------------------------------------------
// A tiny MCP server that goes into the extension bundle. It uses the SDK of this repo.
// It writes its arguments to stderr — like many servers do when they fail — so the test
// can check that a secret in an argument never reaches the browser.
function tinyServerSource() {
  return `const req = require('module').createRequire(${JSON.stringify(path.join(REPO, 'package.json'))});
const { McpServer } = req('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = req('@modelcontextprotocol/sdk/server/stdio.js');
const z = req('zod');
const server = new McpServer({ name: 'lumen-fixture-extension', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo a value back.', inputSchema: { value: z.string() } },
  async ({ value }) => {
    // Every call leaves a line in the log — that is how the test proves that the
    // log viewer really fetches the log again when it is refreshed.
    process.stderr.write('lumen-test fixture tool called: echo\\n');
    return { content: [{ type: 'text', text: 'echo: ' + value }] };
  });
server.registerTool('ping', { description: 'Answer with pong.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'pong' }] }));
process.stderr.write('fixture extension ready: ' + process.argv.slice(2).join(' ') + '\\n');
server.connect(new StdioServerTransport());
`;
}
const FIXTURE_MANIFEST = {
  manifest_version: '0.3',
  name: 'Fixture Extension',
  version: '0.1.0',
  server: {
    type: 'node',
    entry_point: 'server.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server.js', '--home', '${HOME}', '--dir', '${user_config.dir}', '--tag', '${user_config.tag}', '--token', '${user_config.token}'],
    },
  },
  user_config: {
    dir: { type: 'directory', title: 'Directory', required: true, multiple: true },
    tag: { type: 'string', title: 'Tag', default: 'lumen' },
    token: { type: 'string', title: 'Token', sensitive: true },
  },
};

function writeFixtures() {
  fs.mkdirSync(path.dirname(CLAUDE_CFG), { recursive: true });
  // The config of Claude Desktop — a fixture, never the real file.
  fs.writeFileSync(CLAUDE_CFG, JSON.stringify({
    mcpServers: {
      'Claude Files': { command: 'node', args: [MCP_TEST_SERVER], env: { CLAUDE_TOKEN: CLAUDE_SECRET } },
      'Claude Browser': { command: 'node', args: [MCP_TEST_SERVER, '--ui'] },
      'Claude Remote': { url: 'http://127.0.0.1:9/mcp' },
      // A secret that is also in an argument: the argument must be masked as well.
      'Claude Args': { command: 'node', args: [MCP_TEST_SERVER, '--token', CLAUDE_SECRET], env: { CLAUDE_TOKEN: CLAUDE_SECRET } },
      // A secret of three characters: a short secret must be masked too.
      'Claude Short': { command: 'node', args: [MCP_TEST_SERVER, '--key', SHORT_SECRET], env: { SHORT_KEY: SHORT_SECRET } },
      // A URL that is not http(s): the import must refuse it.
      'Claude File URL': { url: 'file:///etc/passwd' },
      // A name that is far too long.
      'Claude Long Name Long Name Long Name Long Name': { command: 'node', args: [MCP_TEST_SERVER, '--long'] },
    },
  }, null, 2));
  // An extension that Claude Desktop has installed (read-only, imported by reference).
  const dir = path.join(CLAUDE_EXT, 'claude-fixture-extension');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: '0.3', name: 'Claude Fixture Extension', version: '2.0.0',
    server: { type: 'node', entry_point: 'server.js', mcp_config: { command: 'node', args: ['${__dirname}/server.js'] } },
    user_config: { dir: { type: 'directory', title: 'Directory', required: true, multiple: true } },
  }));
  fs.writeFileSync(path.join(dir, 'server.js'), tinyServerSource());
  return dir;
}
const CLAUDE_EXT_DIR = writeFixtures();

// The bundle the test uploads: a manifest and a tiny MCP server.
const fixtureBundle = (manifest = FIXTURE_MANIFEST, extra = []) => zip([
  { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
  { name: 'server.js', data: tinyServerSource() },
  ...extra,
]);
// The same bundle as a file on disk (the upload field of the dialog).
const BUNDLE_FILE = path.join(TMP, 'fixture-extension.mcpb');
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(BUNDLE_FILE, fixtureBundle());

// A second bundle, whose manifest declares a list with a default — and a list of
// secrets with a default. The default of the secret must never enter the page.
const FORM_MANIFEST = {
  manifest_version: '0.3',
  name: 'Form Fixture Extension',
  version: '0.1.0',
  server: {
    type: 'node',
    entry_point: 'server.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server.js'] },
  },
  user_config: {
    paths: { type: 'string', title: 'Paths', multiple: true, default: ['/tmp/one', '/tmp/two'] },
    codes: { type: 'string', title: 'Codes', multiple: true, sensitive: true, default: ['s3cret-list-value'] },
  },
};
const FORM_BUNDLE_FILE = path.join(TMP, 'form-extension.mcpb');
fs.writeFileSync(FORM_BUNDLE_FILE, fixtureBundle(FORM_MANIFEST));

// ---- helpers ---------------------------------------------------------------
// An API call from Node. The server answers on localhost, so it goes through the same
// guard() as the browser.
async function call(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
// The settings on disk. The server writes them a moment later, so the file is waited for
// until it holds what the test is looking for.
async function settingsOnDisk(match) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    try {
      last = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (!match || match(last)) return last;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await sleep(100);
  }
  throw new Error('the settings on disk never held what the test was looking for: ' + JSON.stringify(last).slice(0, 300));
}
// The files of a folder, with their size (to prove that nothing was written).
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, rel + n + '/');
      else out.push(rel + n + ':' + st.size);
    }
  };
  try { walk(dir, ''); } catch { /* no folder */ }
  return out.join('\n');
}
// Unpack a bundle with the shipped reader and report what happened.
function unpack(buf) {
  const dir = path.join(TMP, 'zip-unit-' + Math.random().toString(36).slice(2));
  try { zipReader.extract(buf, dir); return { refused: false, msg: '', dir }; }
  catch (e) { return { refused: true, msg: String(e.message || e), dir }; }
}
const filesIn = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
// Data that repeats a block: it compresses about 110:1, so the ratio limit stays quiet
// and only the size limits can fire.
function softData(bytes) {
  const block = require('crypto').randomBytes(30000);
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += block.length) block.copy(out, i, 0, Math.min(block.length, bytes - i));
  return out;
}

(async () => {
  const h = await launch(BASE, 9347);
  const { ev, ok, waitFor, shot, setFiles } = h;
  // The trust question is answered "yes", but every question is recorded.
  await ev(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; 1`);

  // ---- 1. what Claude Desktop has (read-only) ------------------------------
  const cfg = await call('GET', '/api/claude/config');
  ok('the Claude config is found', cfg.status === 200 && cfg.json.exists === true, cfg.text.slice(0, 120));
  ok('the path of the config is reported', cfg.json.path === CLAUDE_CFG, cfg.json.path);
  const keys = (cfg.json.servers || []).map((s) => s.key).sort();
  ok('every server of the config is listed', keys.join('|') === ['Claude Args', 'Claude Browser', 'Claude File URL', 'Claude Files', 'Claude Long Name Long Name Long Name Long Name', 'Claude Remote', 'Claude Short'].join('|'), JSON.stringify(keys));
  const files = (cfg.json.servers || []).find((s) => s.key === 'Claude Files');
  ok('the command and the arguments are shown', !!files && files.command === 'node' && files.args[0].endsWith('mcp-test-server.js'), JSON.stringify(files && files.args));
  ok('the env key is shown', !!files && files.envKeys.includes('CLAUDE_TOKEN'), JSON.stringify(files && files.envKeys));
  ok('the env value is masked', !!files && /•+/.test(files.env.CLAUDE_TOKEN) && !files.env.CLAUDE_TOKEN.includes('SECRET'), JSON.stringify(files && files.env));
  ok('the plain secret never appears in the answer', !cfg.text.includes(CLAUDE_SECRET), 'the secret leaked');
  // A secret that stands in an argument of Claude's config is masked as well.
  const argsSrv = (cfg.json.servers || []).find((s) => s.key === 'Claude Args');
  ok('a secret in an argument is masked', !!argsSrv && !argsSrv.args.join(' ').includes(CLAUDE_SECRET), JSON.stringify(argsSrv && argsSrv.args));
  // A secret of three characters is masked too.
  const shortSrv = (cfg.json.servers || []).find((s) => s.key === 'Claude Short');
  ok('a secret of three characters is masked', !!shortSrv && !shortSrv.args.join(' ').includes(SHORT_SECRET), JSON.stringify(shortSrv && shortSrv.args));
  const cfgBefore = fs.readFileSync(CLAUDE_CFG, 'utf8');

  // ---- 2. never added on its own -------------------------------------------
  let mcp = await call('GET', '/api/mcp');
  ok('nothing is added by reading the config', !(mcp.json || []).some((s) => s.name === 'Claude Files'), JSON.stringify((mcp.json || []).map((s) => s.name)));
  const noConfirm = await call('POST', '/api/claude/import', { key: 'Claude Files' });
  ok('importing without a confirmation is refused', noConfirm.status === 400 && /confirm/i.test(noConfirm.json.error), noConfirm.text);
  mcp = await call('GET', '/api/mcp');
  ok('a refused import adds nothing', !(mcp.json || []).some((s) => s.name === 'Claude Files'));
  // A server of Claude's config that is not safe to run is refused as well.
  const badUrl = await call('POST', '/api/claude/import', { key: 'Claude File URL', confirm: true });
  ok('a server with a URL that is not http(s) is refused', badUrl.status === 400, badUrl.text.slice(0, 200));
  ok('the refused server was not added', !(await call('GET', '/api/mcp')).json.some((s) => (s.url || '').includes('file://')));
  const longName = await call('POST', '/api/claude/import', { key: 'Claude Long Name Long Name Long Name Long Name', confirm: true });
  ok('the name of an imported server is cut to 40 characters', longName.status === 200 && longName.json.name.length <= 40, longName.json && longName.json.name);

  // ---- 3. the import -------------------------------------------------------
  const imp = await call('POST', '/api/claude/import', { key: 'Claude Files', confirm: true });
  ok('the server is imported after the confirmation', imp.status === 200 && imp.json.name === 'Claude Files', imp.text.slice(0, 200));
  ok('the imported server is connected', imp.json.status === 'connected', JSON.stringify(imp.json.error || imp.json.status));
  ok('the imported server brings its tools', (imp.json.tools || []).length === 3, String((imp.json.tools || []).length));
  ok('the env value of the imported server is masked', !imp.text.includes(CLAUDE_SECRET) && /•+/.test(imp.json.env.CLAUDE_TOKEN), imp.json.env && imp.json.env.CLAUDE_TOKEN);
  ok('the env key of the imported server is kept', (imp.json.envKeys || []).includes('CLAUDE_TOKEN'), JSON.stringify(imp.json.envKeys));
  mcp = await call('GET', '/api/mcp');
  ok('the imported server is in the list', (mcp.json || []).some((s) => s.name === 'Claude Files'));
  ok('no answer contains the secret', !mcp.text.includes(CLAUDE_SECRET), 'the secret leaked');
  const dup = await call('POST', '/api/claude/import', { key: 'Claude Files', confirm: true });
  ok('the same server is not added twice', dup.status === 409, dup.text.slice(0, 120));
  const cfg2 = await call('GET', '/api/claude/config');
  ok('a server that is already in Lumen is marked as a duplicate', (cfg2.json.servers.find((s) => s.key === 'Claude Files') || {}).duplicate === true);
  ok('the config of Claude Desktop was not changed', fs.readFileSync(CLAUDE_CFG, 'utf8') === cfgBefore);
  const importedId = imp.json.id;

  // ---- 4. the secret never comes back ---------------------------------------
  for (const url of ['/api/mcp', '/api/settings', '/api/logs', '/api/diagnostics', '/api/claude/config']) {
    const r = await call('GET', url);
    ok(`the secret is not in ${url}`, !r.text.includes(CLAUDE_SECRET), r.text.slice(0, 120));
  }
  const onDisk = await settingsOnDisk((s) => (s.mcpServers || []).some((x) => (x.id === importedId) && Object.keys(x.env || {}).includes('CLAUDE_TOKEN')));
  ok('the env key of the imported server is stored', JSON.stringify(onDisk.mcpServers.map((s) => s.envKeys || Object.keys(s.env || {}))).includes('CLAUDE_TOKEN'));
  ok('the settings that the browser gets hold no secret', !JSON.stringify((await call('GET', '/api/settings')).json).includes(CLAUDE_SECRET));

  // The env editor of the dialog: the keys are shown, the values are not.
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(500);
  await ev(`document.querySelector('#mcpList .mcp[data-id="${importedId}"] [data-a=env]').click(); 1`); await sleep(400);
  ok('the env dialog opens', await ev(`!!document.querySelector('#envDlg') && document.querySelector('#envDlg').open`));
  const envText = await ev(`document.querySelector('#envFields').textContent`);
  ok('the env dialog shows the key', /CLAUDE_TOKEN/.test(envText), envText);
  ok('the env dialog never shows the value', !/SECRET/.test(envText), envText);
  ok('the env dialog has a field for the new value', await ev(`!!document.querySelector('#envFields .envrow input[type=password]')`));
  await ev(`(() => { document.querySelector('#envFields .envrow input').value = 'ui-token-7777'; return 1; })()`);
  await ev(`document.querySelector('#envSave').click(); 1`); await sleep(1200);
  const afterEnv = (await call('GET', '/api/mcp')).json.find((s) => s.id === importedId);
  ok('the value typed in the dialog is stored (masked)', /•+7777/.test((afterEnv.env || {}).CLAUDE_TOKEN || ''), JSON.stringify(afterEnv.env));
  await ev(`document.querySelector('#toolsClose').click(); 1`); await sleep(200);

  // ---- 5. the per-tool switches --------------------------------------------
  await ev(`loadMcp().then(() => 1)`);
  const tools0 = await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`);
  ok('the tools of the imported server are in the payload', /claude_files__add/.test(tools0), tools0);
  const sw = await call('PUT', `/api/mcp/${importedId}/tools`, { disabled: ['add'] });
  ok('the switch is accepted', sw.status === 200, sw.text.slice(0, 120));
  ok('the tool is marked as off', (sw.json.tools.find((t) => t.name === 'add') || {}).enabled === false, JSON.stringify(sw.json.tools.map((t) => [t.name, t.enabled])));
  ok('the other tools stay on', (sw.json.tools.find((t) => t.name === 'ping') || {}).enabled !== false);
  await ev(`loadMcp().then(() => { renderMcp(); return 1; })`);
  const tools1 = await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`);
  ok('a tool that is off is not sent to the model', !/claude_files__add/.test(tools1), tools1);
  ok('the other tools are still sent', /claude_files__get_secret_code/.test(tools1), tools1);
  const blocked = await call('POST', '/api/mcp/call', { server: importedId, tool: 'add', arguments: { a: 1, b: 2 } });
  ok('a tool that is off does not run', blocked.json && blocked.json.isError === true, blocked.text.slice(0, 120));
  await sleep(400); // the settings are written a moment later
  const onDisk2 = await settingsOnDisk((s) => JSON.stringify((s.toolToggles || {})[importedId] || null) === JSON.stringify({ add: false }));
  ok('the switches are stored in the settings of Lumen', JSON.stringify((onDisk2.toolToggles || {})[importedId] || null) === JSON.stringify({ add: false }), JSON.stringify(onDisk2.toolToggles));
  await call('PUT', `/api/mcp/${importedId}/tools`, { disabled: [] });
  await ev(`loadMcp().then(() => { renderMcp(); return 1; })`);
  const tools2 = await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`);
  ok('a tool that is switched on again is sent again', /claude_files__add/.test(tools2), tools2);

  // ---- 6. the extension bundles ---------------------------------------------
  const b64 = fixtureBundle().toString('base64');
  const up = await call('POST', '/api/claude/extensions', { file: b64, filename: 'fixture.mcpb' });
  ok('the bundle is unpacked', up.status === 200 && !!up.json.id, up.text.slice(0, 200));
  ok('the manifest is read', up.json.name === 'Fixture Extension' && up.json.version === '0.1.0', JSON.stringify(up.json.name));
  ok('the form is built from the user_config', Object.keys(up.json.userConfig || {}).join(',') === 'dir,tag,token', JSON.stringify(up.json.userConfig));
  ok('the sensitive field is marked', (up.json.userConfig.token || {}).sensitive === true, JSON.stringify(up.json.userConfig.token));
  ok('the bundle is unpacked into the extensions folder of Lumen', fs.existsSync(path.join(EXT_DIR, up.json.id, 'manifest.json')), up.json.dir);
  ok('the secret of the bundle is not in the answer', !up.text.includes(EXT_SECRET));

  const install = await call('POST', '/api/claude/extensions/install', {
    id: up.json.id, source: 'upload', confirm: true,
    userConfig: { dir: ['/tmp/lumen-one', '/tmp/lumen-two'], tag: 'from-test', token: EXT_SECRET },
  });
  ok('the extension is installed', install.status === 200 && install.json.name === 'Fixture Extension', install.text.slice(0, 200));
  const args = install.json.args || [];
  ok('${__dirname} is the folder of the extension', args[0] === path.join(EXT_DIR, up.json.id, 'server.js'), JSON.stringify(args));
  ok('${HOME} is the home folder', args[2] === HOME, JSON.stringify(args));
  ok('a list becomes several arguments', args[4] === '/tmp/lumen-one' && args[5] === '/tmp/lumen-two', JSON.stringify(args));
  ok('the value of the user_config is used', args[7] === 'from-test', JSON.stringify(args));
  const tokenArg = args[args.indexOf('--token') + 1] || '';
  ok('the sensitive value is masked in the answer', !install.text.includes(EXT_SECRET) && /•+/.test(tokenArg), JSON.stringify(args));
  ok('the extension starts and brings its tools', install.json.status === 'connected' && (install.json.tools || []).length === 2, JSON.stringify(install.json.error || (install.json.tools || []).length));
  await sleep(500); // the server writes its arguments to stderr
  const extOnDisk = await settingsOnDisk((s) => (s.mcpServers || []).some((x) => (x.extension || {}).id === up.json.id));
  ok('the settings of the extension are stored', JSON.stringify(extOnDisk.mcpServers.map((s) => s.extension || null)).includes(up.json.id));
  ok('the secret is not in the list of the servers', !(await call('GET', '/api/mcp')).text.includes(EXT_SECRET));
  // The output of the server may not show the secret either.
  const extLogs = await call('GET', `/api/mcp/${install.json.id}/logs`);
  ok('the log of a server does not show its secret', !extLogs.text.includes(EXT_SECRET), extLogs.text.slice(0, 200));
  ok('the secret in the log is masked', /•+/.test(extLogs.text), extLogs.text.slice(0, 200));
  const extView = (await call('GET', '/api/mcp')).json.find((s) => s.id === install.json.id);
  ok('the output in the list of the servers does not show the secret', !JSON.stringify(extView && extView.stderr).includes(EXT_SECRET), JSON.stringify(extView && extView.stderr));

  // ---- 7. a bundle that tries to escape -------------------------------------
  const evil = zip([{ name: '../evil.txt', data: 'gotcha' }, { name: 'manifest.json', data: JSON.stringify(FIXTURE_MANIFEST) }]);
  const evilRes = await call('POST', '/api/claude/extensions', { file: evil.toString('base64'), filename: 'evil.mcpb' });
  ok('a bundle with a path that escapes is refused', evilRes.status === 400 && /unsafe|escape|outside|refus/i.test(evilRes.json.error), evilRes.text.slice(0, 200));
  ok('nothing was written outside the extensions folder', !fs.existsSync(path.join(DATA_DIR, 'evil.txt')) && !fs.existsSync(path.join(EXT_DIR, 'evil.txt')));
  const abs = zip([{ name: '/tmp/lumen-abs.txt', data: 'gotcha' }]);
  const absRes = await call('POST', '/api/claude/extensions', { file: abs.toString('base64'), filename: 'abs.mcpb' });
  ok('a bundle with an absolute path is refused', absRes.status === 400, absRes.text.slice(0, 200));

  // ---- 8. the size limits ---------------------------------------------------
  // Every limit has a case of its own, and every case trips that limit only: the data
  // repeats a block, so it compresses about 110:1 and the ratio limit stays quiet.
  const LIM = zipReader.LIMITS;
  {
    // The ratio (the zip bomb): 8 MB of zeros compress to 8 KB, so the bundle expands
    // 1000:1. The bundle lies about the size in its directory — the ratio of the bytes
    // that come out is what counts.
    const lying = zip([{ name: 'bomb.bin', data: Buffer.alloc(8 * 1024 * 1024, 0), opts: { declaredSize: 10 } }]);
    const r = unpack(lying);
    ok('a bundle that expands too much is refused', r.refused, r.msg);
    ok('the refusal names the zip bomb and not a size limit',
      r.msg === '"bomb.bin" expands too much — refusing a zip bomb', r.msg);
    ok('nothing is written from a bundle that expands too much', filesIn(r.dir).length === 0, JSON.stringify(filesIn(r.dir)));
  }
  {
    // The limit per file: one file of 21 MB. It is under the limit in total and its
    // ratio is fine, so only the limit per file can fire.
    const big = zip([{ name: 'big.bin', data: softData(21 * 1024 * 1024), opts: { declaredSize: 10 } }]);
    const r = unpack(big);
    ok('a file over the limit per file is refused', r.refused, r.msg);
    ok('the refusal names the limit per file',
      r.msg === '"big.bin" is bigger than the file limit (20971520 bytes)', r.msg);
    ok('nothing is written from a file over the limit per file', filesIn(r.dir).length === 0, JSON.stringify(filesIn(r.dir)));
  }
  {
    // The limit in total: three files of 17 MB. Every file is under the limit per
    // file, so only the limit in total can fire.
    const three = [0, 1, 2].map((i) => ({ name: `f${i}.bin`, data: softData(17 * 1024 * 1024), opts: { declaredSize: 10 } }));
    const r = unpack(zip(three));
    ok('a bundle over the limit in total is refused', r.refused, r.msg);
    ok('the refusal names the limit in total',
      r.msg === 'The bundle is bigger than the size limit (52428800 bytes)', r.msg);
    ok('nothing is written from a bundle over the limit in total', filesIn(r.dir).length === 0, JSON.stringify(filesIn(r.dir)));
  }
  {
    // The limit of the upload: the file itself is too big, before it is even read.
    let refused = false, msg = '';
    try { zipReader.readZip(Buffer.alloc(LIM.maxBundleBytes + 1)); } catch (e) { refused = true; msg = String(e.message || e); }
    ok('a bundle over the limit of the upload is refused', refused, msg);
    ok('the refusal names the limit of the upload',
      msg === 'The bundle is bigger than the upload limit (20971520 bytes)', msg);
  }
  {
    // The number of files in the bundle.
    const many = [];
    for (let i = 0; i < LIM.maxEntries + 1; i++) many.push({ name: `f${i}.txt`, data: 'x' });
    const r = unpack(zip(many));
    ok('a bundle with too many files is refused', r.refused, r.msg);
    ok('the refusal names the number of files',
      r.msg === 'The bundle has 2001 files (the limit is 2000)', r.msg);
    ok('nothing is written from a bundle with too many files', filesIn(r.dir).length === 0, JSON.stringify(filesIn(r.dir)));
  }
  {
    // A bundle whose directory is fine but whose deflate stream is broken: the refusal
    // has to name the broken stream, not the size limit.
    const broken = zip([{ name: 'broken.bin', data: require('crypto').randomBytes(4000) }]);
    const nameLen = broken.readUInt16LE(26);
    const extraLen = broken.readUInt16LE(28);
    broken[30 + nameLen + extraLen] = 0xff;   // an invalid deflate block
    const r = unpack(broken);
    ok('a bundle with a broken deflate stream is refused', r.refused, r.msg);
    ok('the refusal names the broken stream and not the size limit',
      !/file limit|size limit/i.test(r.msg) && /invalid|incorrect|deflate|zlib|data/i.test(r.msg), r.msg);
    ok('nothing is written from a bundle with a broken deflate stream', filesIn(r.dir).length === 0, JSON.stringify(filesIn(r.dir)));
  }
  {
    // The name of an entry comes from the bundle: it must not put control characters
    // or a whole book into the error message.
    const nasty = zip([{ name: '../evil\u0007name.txt', data: 'x' }]);
    const r = unpack(nasty);
    ok('a bundle with a control character in the name is refused', r.refused, r.msg);
    ok('the refusal has no control characters', !/[\x00-\x1f\x7f]/.test(r.msg), JSON.stringify(r.msg));
    const long = zip([{ name: '../' + 'x'.repeat(300) + '\u0007', data: 'x' }]);
    const r2 = unpack(long);
    ok('the refusal shortens a long name', r2.refused && r2.msg.length < 200, JSON.stringify(r2.msg));
  }
  {
    const r = unpack(zip([{ name: 'link', data: '/etc/passwd', opts: { symlink: true } }]));
    ok('a bundle with a symlink is refused', r.refused && /symlink/i.test(r.msg), r.msg);
  }
  {
    const r = unpack(zip([{ name: 'enc.txt', data: 'hello', opts: { encrypt: true } }]));
    ok('an encrypted bundle is refused', r.refused && /encrypt/i.test(r.msg), r.msg);
  }
  {
    const r = unpack(zip([{ name: 'z64.txt', data: 'hello', opts: { zip64: true } }]));
    ok('a Zip64 bundle is refused', r.refused && /zip64/i.test(r.msg), r.msg);
  }
  {
    // The same bundle, but over the API: nothing may be written either.
    const lying = zip([{ name: 'manifest.json', data: JSON.stringify(FIXTURE_MANIFEST) }, { name: 'bomb.bin', data: Buffer.alloc(8 * 1024 * 1024, 0), opts: { declaredSize: 10 } }]);
    const res = await call('POST', '/api/claude/extensions', { file: lying.toString('base64'), filename: 'lying.mcpb' });
    ok('the server refuses a bundle that expands too much', res.status === 400, res.text.slice(0, 200));
    ok('the server names the zip bomb',
      res.json.error === 'The bundle was refused: "bomb.bin" expands too much — refusing a zip bomb', res.json.error);
    const anyBomb = fs.existsSync(EXT_DIR) && fs.readdirSync(EXT_DIR).some((d) => fs.existsSync(path.join(EXT_DIR, d, 'bomb.bin')));
    ok('nothing is written from a bundle that expands too much', !anyBomb);
  }
  {
    const big = zip([{ name: 'big.bin', data: Buffer.alloc(21 * 1024 * 1024, 7), store: true }]);
    const bigRes = await call('POST', '/api/claude/extensions', { file: big.toString('base64'), filename: 'big.mcpb' });
    ok('a bundle over the limit of the upload is refused by the server', bigRes.status === 400, bigRes.text.slice(0, 200));
    ok('the server names the limit of the upload',
      bigRes.json.error === 'The bundle was refused: The bundle is bigger than the upload limit (20971520 bytes)', bigRes.json.error);
    const bomb = zip([{ name: 'bomb.bin', data: Buffer.alloc(5 * 1024 * 1024, 0) }]);
    const bombRes = await call('POST', '/api/claude/extensions', { file: bomb.toString('base64'), filename: 'bomb.mcpb' });
    ok('a bundle that expands too much is refused by the server', bombRes.status === 400, bombRes.text.slice(0, 200));
    ok('the server names the zip bomb',
      bombRes.json.error === 'The bundle was refused: "bomb.bin" expands too much — refusing a zip bomb', bombRes.json.error);
  }

  // ---- 9. the extensions of Claude Desktop (by reference) --------------------
  const exts = await call('GET', '/api/claude/extensions');
  ok('the extensions of Claude Desktop are listed', (exts.json.installed || []).some((e) => e.id === 'claude-fixture-extension'), exts.text.slice(0, 200));
  const claudeExt = (exts.json.installed || []).find((e) => e.id === 'claude-fixture-extension');
  ok('the files of Claude are not copied', claudeExt && claudeExt.path === CLAUDE_EXT_DIR, claudeExt && claudeExt.path);
  const claudeTreeBefore = tree(CLAUDE_EXT_DIR);
  const refInstall = await call('POST', '/api/claude/extensions/install', {
    id: 'claude-fixture-extension', source: 'claude', confirm: true, userConfig: { dir: ['/tmp/lumen-claude'] },
  });
  ok('an extension of Claude is imported by reference', refInstall.status === 200 && refInstall.json.args[0] === path.join(CLAUDE_EXT_DIR, 'server.js'), JSON.stringify(refInstall.json.args || refInstall.text.slice(0, 200)));
  ok('nothing was written into the folder of Claude', tree(CLAUDE_EXT_DIR) === claudeTreeBefore, tree(CLAUDE_EXT_DIR));

  // ---- 10. the logs and the reload -------------------------------------------
  const logs = await call('GET', `/api/mcp/${importedId}/logs`);
  ok('the log of a server is available', logs.status === 200 && Array.isArray(logs.json.lines), logs.text.slice(0, 120));
  ok('the log holds the output of the server', logs.json.lines.some((l) => /lumen-test MCP server ready/.test(l.text)), JSON.stringify(logs.json.lines));
  const reload = await call('POST', '/api/mcp/reload');
  ok('every server is started again', reload.status === 200 && reload.json.every((s) => s.status === 'connected'), JSON.stringify((reload.json || []).map((s) => [s.name, s.status])));
  await sleep(700);
  const logs2 = await call('GET', `/api/mcp/${importedId}/logs`);
  ok('the log survives the reload', logs2.json.lines.some((l) => /lumen-test MCP server ready/.test(l.text)), JSON.stringify(logs2.json.lines));

  // ---- 11. the user interface ------------------------------------------------
  await ev(`loadMcp().then(() => { renderMcp(); return 1; })`);
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(500);
  ok('the tools dialog has an import button', await ev(`!!document.querySelector('#claudeImportBtn')`));
  ok('the tools dialog has a reload button', await ev(`!!document.querySelector('#mcpReloadAll')`));
  const wantToggles = (await call('GET', '/api/mcp')).json.reduce((t, s) => t + (s.tools || []).length, 0);
  const haveToggles = await ev(`document.querySelectorAll('#toolToggles .tog').length`);
  ok('there is a switch for every tool', haveToggles === wantToggles, `${haveToggles} switches for ${wantToggles} tools`);
  await ev(`document.querySelector('#claudeImportBtn').click(); 1`); await sleep(600);
  ok('the import dialog opens', await ev(`!!document.querySelector('#claudeDlg') && document.querySelector('#claudeDlg').open`));
  const list = await ev(`document.querySelector('#claudeList').textContent`);
  ok('the dialog shows the servers of Claude', /Claude Files/.test(list), list.slice(0, 160));
  ok('the dialog shows the env key', /CLAUDE_TOKEN/.test(list), list.slice(0, 160));
  ok('the dialog never shows the secret', !/SECRET/.test(list), list.slice(0, 160));
  await shot('step9-import');
  await ev(`document.querySelector('#claudeList .cimp[data-key="Claude Browser"] button').click(); 1`); await sleep(1200);
  const asked = await ev(`JSON.stringify(window.__confirms)`);
  ok('the trust question is asked before the server is added', /trust/i.test(asked) && /mcp-test-server/.test(asked), asked.slice(0, 200));
  ok('the server of the dialog is added to Lumen', (await call('GET', '/api/mcp')).json.some((s) => s.name === 'Claude Browser'));
  ok('the dialog says the server is already in Lumen', /Already in Lumen/.test(await ev(`document.querySelector('#claudeList').textContent`)));
  await ev(`document.querySelector('#claudeClose').click(); 1`); await sleep(300);

  // The switch in the dialog really takes a tool out of the payload.
  const before3 = JSON.parse(await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`));
  const firstToggle = await ev(`(() => { const boxes = [...document.querySelectorAll('#toolToggles .tog input')]; const b = boxes.find((x) => x.checked); if (!b) return ''; const name = b.closest('.tog').querySelector('.tn').textContent; b.click(); return name; })()`);
  ok('a tool can be switched off in the dialog', !!firstToggle, String(firstToggle));
  await sleep(700);
  const tools3 = JSON.parse(await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`));
  const gone = before3.filter((n) => !tools3.includes(n));
  ok('the tool that was switched off is gone from the payload',
    gone.length === 1 && gone[0].endsWith('__' + firstToggle),
    JSON.stringify([firstToggle, gone, tools3]));

  // Two switches in quick succession: the first one must not be lost.
  // The switches of one server start from a clean sheet: every tool of it is on.
  const raceGroup = await ev(`(() => { const g = [...document.querySelectorAll('#toolToggles .toggles')].find((x) => x.querySelectorAll('.tog input').length >= 2); return g ? g.dataset.id : ''; })()`);
  ok('the switches of a server are in a group of their own', !!raceGroup, String(raceGroup));
  await call('PUT', `/api/mcp/${raceGroup}/tools`, { disabled: [] });
  await ev(`loadMcp().then(() => { renderMcp(); return 1; })`); await sleep(500);
  const race = await ev(`(() => { const g = [...document.querySelectorAll('#toolToggles .toggles')].find((x) => x.dataset.id === ${JSON.stringify(raceGroup)}); if (!g) return ''; const boxes = [...g.querySelectorAll('.tog input')].filter((b) => b.checked); if (boxes.length < 2) return ''; boxes[0].click(); boxes[1].click(); return g.dataset.id; })()`);
  ok('two tools can be switched off at once', !!race, String(race));
  await sleep(1500);
  const raceSrv = (await call('GET', '/api/mcp')).json.find((s) => s.id === race);
  const offNow = (raceSrv && raceSrv.tools || []).filter((t) => t.enabled === false).length;
  ok('two tools that are switched off in quick succession stay off', offNow === 2, JSON.stringify((raceSrv && raceSrv.tools || []).map((t) => [t.name, t.enabled])));

  // The log viewer.
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#mcpList .mcp[data-id="${importedId}"] [data-a=log]').click(); 1`); await sleep(600);
  ok('the log viewer opens', await ev(`!!document.querySelector('#mcpLogsDlg') && document.querySelector('#mcpLogsDlg').open`));
  ok('the log viewer shows the output of the server', /lumen-test MCP server ready/.test(await ev(`document.querySelector('#logBox2').textContent`)), (await ev(`document.querySelector('#logBox2').textContent`)).slice(0, 120));
  await shot('step9-logs');

  // A refresh has to fetch the log again. The fixture extension writes a line for every
  // call, so the log grows while the dialog is open — that is what proves the refresh.
  const extId = install.json.id;
  await ev(`document.querySelector('#logClose2').click(); 1`); await sleep(200);
  await call('PUT', `/api/mcp/${extId}/tools`, { disabled: [] });
  await sleep(400);
  await ev(`document.querySelector('#mcpList .mcp[data-id="${extId}"] [data-a=log]').click(); 1`); await sleep(700);
  ok('the log of the extension is shown', /fixture extension ready/.test(await ev(`document.querySelector('#logBox2').textContent`)), (await ev(`document.querySelector('#logBox2').textContent`)).slice(0, 120));
  const linesBefore = await ev(`document.querySelector('#logBox2').textContent.split('\\n').filter((l) => l.trim()).length`);
  const echoCall = await call('POST', '/api/mcp/call', { server: extId, tool: 'echo', arguments: { value: 'refresh' } });
  ok('the tool of the extension runs', echoCall.status === 200 && !(echoCall.json && echoCall.json.isError), echoCall.text.slice(0, 120));
  await sleep(600);
  await ev(`document.querySelector('#logRefresh2').click(); 1`); await sleep(900);
  const linesAfter = await ev(`document.querySelector('#logBox2').textContent.split('\\n').filter((l) => l.trim()).length`);
  const logText = await ev(`document.querySelector('#logBox2').textContent`);
  ok('the log can be refreshed', linesAfter > linesBefore, `${linesBefore} lines before, ${linesAfter} lines after the refresh`);
  ok('the refreshed log shows the new output', /lumen-test fixture tool called: echo/.test(logText), logText.slice(-200));
  await ev(`document.querySelector('#logClose2').click(); document.querySelector('#toolsClose').click(); 1`);

  // ---- 12. the extension asks before it runs on the computer -----------------
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#claudeImportBtn').click(); 1`); await sleep(600);
  await setFiles('#extFile', [BUNDLE_FILE]);
  await sleep(1200);
  ok('the form of an uploaded bundle is shown', await ev(`!!document.querySelector('#extForm') && !document.querySelector('#extForm').hidden`));
  ok('the sensitive field of the form is masked', await ev(`!!document.querySelector('#extFields [data-k="token"]') && document.querySelector('#extFields [data-k="token"]').type === 'password'`));
  ok('the sensitive field of the form has no value in the page', await ev(`document.querySelector('#extFields [data-k="token"]').getAttribute('value') === null`));
  await ev(`(() => { const set = (k, v) => { const el = document.querySelector('#extFields [data-k="' + k + '"]'); if (el) el.value = v; }; set('dir', '/tmp/lumen-ui-one'); set('tag', 'ui'); set('token', 'ui-secret-value'); return 1; })()`);
  const confirmsBefore = JSON.parse(await ev(`JSON.stringify(window.__confirms)`)).length;
  await ev(`document.querySelector('#extInstall').click(); 1`); await sleep(1500);
  const allConfirms = JSON.parse(await ev(`JSON.stringify(window.__confirms)`));
  const lastConfirm = allConfirms[allConfirms.length - 1] || '';
  ok('the extension asks before it runs on the computer', allConfirms.length > confirmsBefore && /trust|run this|only continue/i.test(lastConfirm), lastConfirm.slice(0, 200));
  ok('the question shows the command that will run', /server\.js/.test(lastConfirm) && /--token/.test(lastConfirm), lastConfirm.slice(0, 300));
  ok('the extension is installed after the confirmation', (await call('GET', '/api/mcp')).json.some((s) => (s.extension || {}).source === 'upload' && (s.extension || {}).id !== up.json.id));
  await ev(`document.querySelector('#claudeClose').click(); 1`); await sleep(200);

  // A list that is not a secret shows the default of the manifest. A list of secrets
  // stays empty — its default is not shown in the form.
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#claudeImportBtn').click(); 1`); await sleep(600);
  await setFiles('#extFile', [FORM_BUNDLE_FILE]);
  await sleep(1500);
  ok('the form of the second bundle is shown', await ev(`!!document.querySelector('#extFields [data-k="paths"]')`));
  const pathsValue = await ev(`document.querySelector('#extFields [data-k="paths"]').value`);
  ok('a list that is not a secret shows the default of the manifest', pathsValue === '/tmp/one\n/tmp/two', JSON.stringify(pathsValue));
  const codesValue = await ev(`document.querySelector('#extFields [data-k="codes"]').value`);
  const codesAttr = await ev(`document.querySelector('#extFields [data-k="codes"]').getAttribute('value')`);
  ok('a list of secrets is empty in the form', codesValue === '' && codesAttr === null, JSON.stringify([codesValue, codesAttr]));
  ok('the default of a secret is not shown in the form', !/s3cret-list-value/.test(await ev(`document.querySelector('#extForm').textContent`)), (await ev(`document.querySelector('#extForm').textContent`)).slice(0, 200));
  await ev(`document.querySelector('#claudeClose').click(); 1`); await sleep(200);

  // ---- 13. the env values of a server can be replaced, never read ------------
  const envPut = await call('PUT', `/api/mcp/${importedId}/env`, { key: 'CLAUDE_TOKEN', value: 'new-token-9999' });
  ok('an env value can be replaced', envPut.status === 200, envPut.text.slice(0, 120));
  ok('the new value comes back masked', /•+9999/.test((envPut.json.env || {}).CLAUDE_TOKEN || ''), JSON.stringify(envPut.json.env));
  ok('the old value is never returned', !envPut.text.includes('ui-token-7777') && !envPut.text.includes(CLAUDE_SECRET), envPut.text.slice(0, 200));
  const envBad = await call('PUT', `/api/mcp/${importedId}/env`, { key: 'not a name', value: 'x' });
  ok('a name that is not a variable name is refused', envBad.status === 400, envBad.text.slice(0, 120));
  const envClear = await call('PUT', `/api/mcp/${importedId}/env`, { key: 'CLAUDE_TOKEN', clear: true });
  ok('an env value can be removed', envClear.status === 200 && !(envClear.json.envKeys || []).includes('CLAUDE_TOKEN'), envClear.text.slice(0, 120));

  // ---- 14. the built-in web tools can be switched off as well ----------------
  await call('PUT', '/api/settings', { web: { enabled: true, provider: 'brave', braveKey: 'test-key' } });
  const withWeb = await call('GET', '/api/mcp');
  const builtin = (withWeb.json || []).find((s) => s.id === 'builtin');
  ok('the built-in web tools are listed', !!builtin && (builtin.tools || []).length > 0, withWeb.text.slice(0, 200));
  const webTool = builtin && (builtin.tools || [])[0].name;
  const builtinSw = await call('PUT', '/api/mcp/builtin/tools', { disabled: [webTool] });
  ok('a built-in tool can be switched off', builtinSw.status === 200 && (builtinSw.json.tools || []).some((t) => t.name === webTool && t.enabled === false), builtinSw.text.slice(0, 200));
  const builtinCall = await call('POST', '/api/mcp/call', { server: 'builtin', tool: webTool, arguments: { query: 'x' } });
  ok('a built-in tool that is switched off does not run', builtinCall.json && builtinCall.json.isError === true, builtinCall.text.slice(0, 120));

  // ---- 15. the reader of the extension command --------------------------------
  {
    const bin = claudeMod.buildCommand({ manifest_version: '0.3', server: { type: 'binary', entry_point: '/tmp/lumen-binary' } }, {}, '/tmp');
    ok('a binary extension runs the file itself, without itself as an argument', bin.command === '/tmp/lumen-binary' && bin.args.length === 0, JSON.stringify(bin));
  }

  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
