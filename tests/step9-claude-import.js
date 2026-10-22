// Step 9 — import from Claude Desktop: the review dialog, the extension bundles,
// the per-tool switches, the MCP logs and the reload.
const { launch, sleep } = require('./lib/cdplib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { zip } = require('./lib/zipwrite');

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
const HOME = os.homedir();

// ---- the fixtures ----------------------------------------------------------
// A tiny MCP server that goes into the extension bundle. It uses the SDK of this repo.
function tinyServerSource() {
  return `const req = require('module').createRequire(${JSON.stringify(path.join(REPO, 'package.json'))});
const { McpServer } = req('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = req('@modelcontextprotocol/sdk/server/stdio.js');
const z = req('zod');
const server = new McpServer({ name: 'lumen-fixture-extension', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo a value back.', inputSchema: { value: z.string() } },
  async ({ value }) => ({ content: [{ type: 'text', text: 'echo: ' + value }] }));
server.registerTool('ping', { description: 'Answer with pong.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'pong' }] }));
process.stderr.write('fixture extension ready\\n');
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
      'Claude Files': { command: 'node', args: [path.join(REPO, 'tests', 'mcp-test-server.js')], env: { CLAUDE_TOKEN: CLAUDE_SECRET } },
      'Claude Browser': { command: 'node', args: [path.join(REPO, 'tests', 'mcp-test-server.js'), '--ui'] },
      'Claude Remote': { url: 'http://127.0.0.1:9/mcp' },
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
const settingsOnDisk = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

(async () => {
  const h = await launch(BASE, 9347);
  const { ev, ok, waitFor, shot } = h;
  // The trust question is answered "yes", but every question is recorded.
  await ev(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; 1`);

  // ---- 1. what Claude Desktop has (read-only) ------------------------------
  const cfg = await call('GET', '/api/claude/config');
  ok('the Claude config is found', cfg.status === 200 && cfg.json.exists === true, cfg.text.slice(0, 120));
  ok('the path of the config is reported', cfg.json.path === CLAUDE_CFG, cfg.json.path);
  ok('both servers of the config are listed', (cfg.json.servers || []).length === 3, JSON.stringify((cfg.json.servers || []).map((s) => s.key)));
  const files = (cfg.json.servers || []).find((s) => s.key === 'Claude Files');
  ok('the command and the arguments are shown', !!files && files.command === 'node' && files.args[0].endsWith('mcp-test-server.js'), JSON.stringify(files && files.args));
  ok('the env key is shown', !!files && files.envKeys.includes('CLAUDE_TOKEN'), JSON.stringify(files && files.envKeys));
  ok('the env value is masked', !!files && /•+/.test(files.env.CLAUDE_TOKEN) && !files.env.CLAUDE_TOKEN.includes('SECRET'), JSON.stringify(files && files.env));
  ok('the plain secret never appears in the answer', !cfg.text.includes(CLAUDE_SECRET), 'the secret leaked');
  const cfgBefore = fs.readFileSync(CLAUDE_CFG, 'utf8');

  // ---- 2. never added on its own -------------------------------------------
  let mcp = await call('GET', '/api/mcp');
  ok('nothing is added by reading the config', !(mcp.json || []).some((s) => s.name === 'Claude Files'), JSON.stringify((mcp.json || []).map((s) => s.name)));
  const noConfirm = await call('POST', '/api/claude/import', { key: 'Claude Files' });
  ok('importing without a confirmation is refused', noConfirm.status === 400 && /confirm/i.test(noConfirm.json.error), noConfirm.text);
  mcp = await call('GET', '/api/mcp');
  ok('a refused import adds nothing', !(mcp.json || []).some((s) => s.name === 'Claude Files'));

  // ---- 3. the import -------------------------------------------------------
  const imp = await call('POST', '/api/claude/import', { key: 'Claude Files', confirm: true });
  ok('the server is imported after the confirmation', imp.status === 200 && imp.json.name === 'Claude Files', imp.text.slice(0, 200));
  ok('the imported server is connected', imp.json.status === 'connected', JSON.stringify(imp.json.error || imp.json.status));
  ok('the imported server brings its tools', (imp.json.tools || []).length === 3, String((imp.json.tools || []).length));
  ok('the env value of the imported server is masked', !imp.text.includes(CLAUDE_SECRET) && /•+/.test(imp.json.env.CLAUDE_TOKEN), imp.json.env && imp.json.env.CLAUDE_TOKEN);
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
  await sleep(400); // the settings are written a moment later
  const onDisk = settingsOnDisk();
  ok('the secret is stored on the server', JSON.stringify(onDisk.mcpServers).includes(CLAUDE_SECRET), 'the secret was not stored');
  ok('the settings that the browser gets hold no secret', !JSON.stringify((await call('GET', '/api/settings')).json).includes(CLAUDE_SECRET));

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
  const onDisk2 = settingsOnDisk();
  ok('the switches are stored in the settings of Lumen', JSON.stringify(onDisk2.toolToggles || {}) === JSON.stringify({ [importedId]: { add: false } }), JSON.stringify(onDisk2.toolToggles));
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
  await sleep(400); // the settings are written a moment later
  const extOnDisk = settingsOnDisk();
  ok('the sensitive value is stored on the server', JSON.stringify(extOnDisk.mcpServers).includes(EXT_SECRET));
  ok('the secret is not in the list of the servers', !(await call('GET', '/api/mcp')).text.includes(EXT_SECRET));

  // ---- 7. a bundle that tries to escape -------------------------------------
  const evil = zip([{ name: '../evil.txt', data: 'gotcha' }, { name: 'manifest.json', data: JSON.stringify(FIXTURE_MANIFEST) }]);
  const evilRes = await call('POST', '/api/claude/extensions', { file: evil.toString('base64'), filename: 'evil.mcpb' });
  ok('a bundle with a path that escapes is refused', evilRes.status === 400 && /unsafe|escape|outside|refus/i.test(evilRes.json.error), evilRes.text.slice(0, 200));
  ok('nothing was written outside the extensions folder', !fs.existsSync(path.join(DATA_DIR, 'evil.txt')) && !fs.existsSync(path.join(EXT_DIR, 'evil.txt')));
  const abs = zip([{ name: '/tmp/lumen-abs.txt', data: 'gotcha' }]);
  const absRes = await call('POST', '/api/claude/extensions', { file: abs.toString('base64'), filename: 'abs.mcpb' });
  ok('a bundle with an absolute path is refused', absRes.status === 400, absRes.text.slice(0, 200));

  // ---- 8. the size limits ---------------------------------------------------
  const big = zip([{ name: 'big.bin', data: Buffer.alloc(21 * 1024 * 1024, 7), store: true }]);
  const bigRes = await call('POST', '/api/claude/extensions', { file: big.toString('base64'), filename: 'big.mcpb' });
  ok('a file that is too big is refused', bigRes.status === 400 && /limit|big/i.test(bigRes.json.error), bigRes.text.slice(0, 200));
  const bomb = zip([{ name: 'bomb.bin', data: Buffer.alloc(5 * 1024 * 1024, 0) }]);
  const bombRes = await call('POST', '/api/claude/extensions', { file: bomb.toString('base64'), filename: 'bomb.mcpb' });
  ok('a bundle that expands too much is refused', bombRes.status === 400 && /expand|bomb|limit/i.test(bombRes.json.error), bombRes.text.slice(0, 200));

  // ---- 9. the extensions of Claude Desktop (by reference) --------------------
  const exts = await call('GET', '/api/claude/extensions');
  ok('the extensions of Claude Desktop are listed', (exts.json.installed || []).some((e) => e.id === 'claude-fixture-extension'), exts.text.slice(0, 200));
  const claudeExt = (exts.json.installed || []).find((e) => e.id === 'claude-fixture-extension');
  ok('the files of Claude are not copied', claudeExt && claudeExt.path === CLAUDE_EXT_DIR, claudeExt && claudeExt.path);
  const refInstall = await call('POST', '/api/claude/extensions/install', {
    id: 'claude-fixture-extension', source: 'claude', confirm: true, userConfig: { dir: ['/tmp/lumen-claude'] },
  });
  ok('an extension of Claude is imported by reference', refInstall.status === 200 && refInstall.json.args[0] === path.join(CLAUDE_EXT_DIR, 'server.js'), JSON.stringify(refInstall.json.args || refInstall.text.slice(0, 200)));
  ok('nothing was written into the folder of Claude', !fs.existsSync(path.join(CLAUDE_EXT_DIR, 'node_modules')));

  // ---- 10. the logs and the reload -------------------------------------------
  const logs = await call('GET', `/api/mcp/${importedId}/logs`);
  ok('the log of a server is available', logs.status === 200 && Array.isArray(logs.json.lines), logs.text.slice(0, 120));
  ok('the log holds the output of the server', logs.json.lines.some((l) => /lumen-test MCP server ready/.test(l.text)), JSON.stringify(logs.json.lines));
  const reload = await call('POST', '/api/mcp/reload');
  ok('every server is started again', reload.status === 200 && reload.json.every((s) => s.status === 'connected'), JSON.stringify((reload.json || []).map((s) => [s.name, s.status])));
  const logs2 = await call('GET', `/api/mcp/${importedId}/logs`);
  ok('the log survives the reload', logs2.json.lines.length >= 1, String(logs2.json.lines.length));

  // ---- 11. the user interface ------------------------------------------------
  await ev(`loadMcp().then(() => { renderMcp(); return 1; })`);
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(500);
  ok('the tools dialog has an import button', await ev(`!!document.querySelector('#claudeImportBtn')`));
  ok('the tools dialog has a reload button', await ev(`!!document.querySelector('#mcpReloadAll')`));
  ok('there is a switch for every tool', (await ev(`document.querySelectorAll('#toolToggles .tog').length`)) >= 3, String(await ev(`document.querySelectorAll('#toolToggles .tog').length`)));
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
  await ev(`document.querySelector('#toolsClose').click(); 1`);

  // The log viewer.
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#mcpList .mcp[data-id="${importedId}"] [data-a=log]').click(); 1`); await sleep(600);
  ok('the log viewer opens', await ev(`!!document.querySelector('#mcpLogsDlg') && document.querySelector('#mcpLogsDlg').open`));
  ok('the log viewer shows the output of the server', /lumen-test MCP server ready/.test(await ev(`document.querySelector('#logBox2').textContent`)), (await ev(`document.querySelector('#logBox2').textContent`)).slice(0, 120));
  await shot('step9-logs');
  await ev(`document.querySelector('#logClose2').click(); document.querySelector('#toolsClose').click(); 1`);

  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
