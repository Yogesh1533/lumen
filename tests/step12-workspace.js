// Step 12 — the workspace: trusted folders, containment, approvals bound to what the
// user saw, the Changes pane (revert restores the bytes), the shell (approval, scrubbed
// environment, output cap, timeout, stop), "needs your input", the scheduled tasks, and
// a real-model task that creates a file and reads it back.
const { launch, sleep } = require('./lib/cdplib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ws = require('../workspace.js');

const TMP = process.env.LUMEN_TEST_TMP || path.join(os.tmpdir(), 'lumen-tests');
const BASE = process.env.LUMEN_URL || 'http://localhost:3101';
const DATA_FILE = process.env.LUMEN_DATA || path.join(TMP, 'data', 'chats.json');
const DATA_DIR = path.dirname(DATA_FILE);
const MODEL = process.env.LUMEN_TEST_MODEL || '';

async function call(method, url, body, headers = {}) {
  const r = await fetch(BASE + '/api' + url, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const tool = (session, t, args, approval) => call('POST', '/mcp/call', { server: 'workspace', tool: t, arguments: args, session, ...(approval ? { approval } : {}) });
const preview = (session, t, args) => call('POST', '/workspace/preview', { session, tool: t, arguments: args });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

(async () => {
  // The page is told when it is in the background, and Notification is a fake that
  // records what it is asked to show.
  const pre = `
    window.__notes = [];
    window.Notification = function (t, o) { window.__notes.push({ t, body: o && o.body }); this.close = () => {}; };
    window.Notification.permission = 'granted';
    window.Notification.requestPermission = async () => 'granted';
    window.confirm = () => true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden });
  `;
  const h = await launch(BASE, 9352, { preScript: pre });
  const { ev, waitFor, ok } = h;

  // A trusted folder of the test, a folder outside it and a secret file outside it.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ws-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-out-')));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  fs.writeFileSync(path.join(root, 'hello.txt'), 'line one\nline two\nline three\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const answer = 41;\nconsole.log(answer);\n');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-file'));
  fs.symlinkSync(outside, path.join(root, 'link-dir'));
  fs.symlinkSync(path.join(root, 'hello.txt'), path.join(root, 'link-inside'));
  const home = os.homedir();

  // ---- 1. the folders that are refused (module) ---------------------------------
  {
    const refuse = (p, opts = {}) => { try { ws.validateFolder(p, { mounts: [], ...opts }); return null; } catch (e) { return e.message; } };
    ok('the root is refused', !!refuse('/'), refuse('/'));
    ok('the home folder itself is refused', !!refuse(home), refuse(home));
    ok('~ is refused', !!refuse('~'));
    for (const p of ['~/Library', '~/.ssh', '~/.config']) {
      const full = p.replace('~', home);
      if (fs.existsSync(full)) ok(`${p} is refused`, !!refuse(full), refuse(full));
      else console.log(`SKIP ${p} does not exist on this machine`);
    }
    if (fs.existsSync(path.join(home, 'Library', 'Preferences'))) ok('a folder inside ~/Library is refused', !!refuse(path.join(home, 'Library', 'Preferences')));
    for (const p of ['/etc', '/usr', '/bin', '/System', '/Library'].filter((x) => fs.existsSync(x))) ok(`${p} is refused`, !!refuse(p), refuse(p));
    if (fs.existsSync('/usr/local/bin')) ok('a folder inside /usr is refused', !!refuse('/usr/local/bin'));
    ok('the folder of all homes is refused', !!refuse(path.dirname(home)));
    // Another user's folder: on macOS /Users/Shared is not the home of this user.
    const other = ['/Users/Shared', '/home'].map((x) => x).find((x) => fs.existsSync(x) && !home.startsWith(x + '/') && x !== path.dirname(home)) || (fs.existsSync('/Users/Shared') ? '/Users/Shared' : null);
    if (other && other !== path.dirname(home)) ok('a folder of another user is refused', !!refuse(other), refuse(other));
    else console.log('SKIP no folder of another user on this machine');
    ok('a relative path is refused', /absolute/.test(refuse('projects/site') || ''), refuse('projects/site'));
    ok('a folder that does not exist is refused', /does not exist/.test(refuse(path.join(root, 'nope')) || ''));
    ok('a file is refused', /file/.test(refuse(path.join(root, 'hello.txt')) || ''));
    ok('a network path is refused', /Network/.test(refuse('//server/share') || ''));
    ok('a folder on a network mount is refused', /Network/.test(refuse(root, { mounts: [path.dirname(root)] }) || ''), refuse(root, { mounts: [path.dirname(root)] }));
    ok('the data folder of Lumen is refused', /data of Lumen/.test(refuse(DATA_DIR, { dataDir: DATA_DIR }) || ''), refuse(DATA_DIR, { dataDir: DATA_DIR }));
    ok('a folder that holds the data folder is refused', !!refuse(path.dirname(DATA_DIR), { dataDir: DATA_DIR }));
    // A home of the test, so the dot folders are checked on every machine.
    const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-home-')));
    for (const d of ['.ssh', '.config', '.aws', 'Library', 'code']) fs.mkdirSync(path.join(fakeHome, d));
    for (const d of ['.ssh', '.config', '.aws', 'Library']) ok(`~/${d} of a home is refused`, !!refuse(path.join(fakeHome, d), { home: fakeHome }), refuse(path.join(fakeHome, d), { home: fakeHome }));
    ok('a folder inside a home is accepted', ws.validateFolder(path.join(fakeHome, 'code'), { mounts: [], home: fakeHome }) === path.join(fakeHome, 'code'));
    ok('that home itself is refused', !!refuse(fakeHome, { home: fakeHome }));
    fs.rmSync(fakeHome, { recursive: true, force: true });
    ok('a folder inside the home (or temp) is accepted', ws.validateFolder(root, { mounts: [] }) === root);
    ok('a symlink to a folder resolves to the real folder', ws.validateFolder(path.join(root, 'link-dir'), { mounts: [] }) === outside);
  }

  // ---- 2. the scrubbed environment (module) -------------------------------------------
  {
    const env = ws.scrubEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'x', MY_SECRET: 'x', ANTHROPIC_BASE_URL: 'x',
      AWS_ACCESS_KEY_ID: 'x', DB_PASSWORD: 'x', SSH_AUTH_SOCK: '/tmp/agent', LUMEN_DATA: 'x', NPM_CONFIG_X: 'x', LANG: 'en' });
    ok('the environment keeps PATH, HOME and LANG', env.PATH === '/bin' && env.HOME === '/h' && env.LANG === 'en');
    const left = ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'MY_SECRET', 'ANTHROPIC_BASE_URL', 'AWS_ACCESS_KEY_ID', 'DB_PASSWORD', 'SSH_AUTH_SOCK', 'LUMEN_DATA'].filter((k) => k in env);
    ok('keys, tokens, secrets, passwords, ANTHROPIC_*, the SSH agent and LUMEN_* are dropped', !left.length, left.join(','));
  }

  // ---- 3. the API: trusting a folder -----------------------------------------------------
  {
    const bad = await call('POST', '/workspace/folders', { path: '/etc' });
    ok('the API refuses a protected folder', bad.status === 400 && /protected/.test(bad.json.error), bad.text);
    const cross = await call('POST', '/workspace/folders', { path: root }, { origin: 'http://evil.example' });
    ok('a cross-site request cannot trust a folder', cross.status === 403);
    const r = await call('POST', '/workspace/folders', { path: root });
    ok('the API trusts the test folder', r.status === 200 && r.json.folders.includes(root), r.text);
    const r2 = await call('POST', '/workspace/folders', { path: path.join(root, 'link-dir') });
    ok('a symlink is trusted as its real folder, never by its name', r2.status === 200 && r2.json.folders.includes(outside) && !r2.json.folders.includes(path.join(root, 'link-dir')));
    await call('POST', '/workspace/folders/remove', { path: outside });
    const servers = (await call('GET', '/mcp')).json;
    const wsSrv = servers.find((s) => s.id === 'workspace');
    ok('the workspace tools are listed', !!wsSrv && ['fs_list', 'fs_tree', 'fs_read', 'fs_search', 'fs_write', 'fs_edit', 'shell'].every((t) => wsSrv.tools.some((x) => x.name === t)), wsSrv && wsSrv.tools.map((t) => t.name).join());
  }

  // A chat with the folder, in the "ask" mode.
  const chat = (await call('POST', '/chats', { title: 'WS test', model: MODEL, messages: [] })).json;
  const S = chat.id;
  {
    const none = await tool(S, 'fs_list', {});
    ok('a chat without a folder has no access', none.json.isError && /no workspace folder/.test(none.json.text), none.json.text);
    const bad = await call('PUT', '/workspace/session/' + S, { folder: outside, mode: 'ask' });
    ok('a chat cannot use a folder that is not trusted', bad.status === 400);
    const r = await call('PUT', '/workspace/session/' + S, { folder: root, mode: 'ask' });
    ok('the chat gets the folder', r.status === 200 && r.json.folder === root && r.json.mode === 'ask', r.text);
  }

  // ---- 4. reads and containment --------------------------------------------------------
  {
    const l = await tool(S, 'fs_list', { path: '.' });
    ok('fs_list lists the folder', !l.json.isError && /hello\.txt/.test(l.json.text) && /\[dir\]\s+src/.test(l.json.text), l.json.text.slice(0, 120));
    const t = await tool(S, 'fs_tree', {});
    ok('fs_tree shows the tree', /src\/\n\s+app\.js/.test(t.json.text), t.json.text);
    const rd = await tool(S, 'fs_read', { path: 'hello.txt', offset: 2, limit: 1 });
    ok('fs_read reads lines with offset and limit', rd.json.text === 'line two', JSON.stringify(rd.json.text));
    const sr = await tool(S, 'fs_search', { query: 'answer' });
    ok('fs_search finds the matches with file and line', /src\/app\.js:1:/.test(sr.json.text) && /src\/app\.js:2:/.test(sr.json.text), sr.json.text);
    const dots = await tool(S, 'fs_read', { path: '../' + path.basename(outside) + '/secret.txt' });
    ok('"../" out of the folder is blocked', dots.json.isError && /outside/.test(dots.json.text) && !/OUTSIDE-SECRET/.test(dots.json.text), dots.json.text);
    const absOut = await tool(S, 'fs_read', { path: path.join(outside, 'secret.txt') });
    ok('an absolute path elsewhere is blocked', absOut.json.isError && !/OUTSIDE-SECRET/.test(absOut.json.text), absOut.json.text);
    const etc = await tool(S, 'fs_read', { path: '/etc/hosts' });
    ok('/etc/hosts is blocked', etc.json.isError && /outside/.test(etc.json.text));
    const lf = await tool(S, 'fs_read', { path: 'link-file' });
    ok('a symlink to a file outside is blocked', lf.json.isError && /symbolic link/.test(lf.json.text) && !/OUTSIDE-SECRET/.test(lf.json.text), lf.json.text);
    const ld = await tool(S, 'fs_read', { path: 'link-dir/secret.txt' });
    ok('a symlinked folder that leads outside is blocked', ld.json.isError && !/OUTSIDE-SECRET/.test(ld.json.text), ld.json.text);
    const ll = await tool(S, 'fs_list', { path: 'link-dir' });
    ok('fs_list through a symlinked folder is blocked', ll.json.isError, ll.json.text);
    const li = await tool(S, 'fs_read', { path: 'link-inside' });
    ok('a symlink that stays inside works', !li.json.isError && /line one/.test(li.json.text));
    const absIn = await tool(S, 'fs_read', { path: path.join(root, 'hello.txt') });
    ok('an absolute path inside the folder works', !absIn.json.isError && /line one/.test(absIn.json.text));
    const nul = await tool(S, 'fs_read', { path: 'hello.txt\u0000.png' });
    ok('a path with a NUL byte is refused', nul.json.isError);
    const srOut = await tool(S, 'fs_search', { query: 'OUTSIDE', path: 'link-dir' });
    ok('fs_search cannot search through a symlink out', srOut.json.isError || !/OUTSIDE-SECRET/.test(srOut.json.text), srOut.json.text);
    const srAll = await tool(S, 'fs_search', { query: 'OUTSIDE-SECRET' });
    ok('fs_search of the folder does not follow symlinks out', /No matches/.test(srAll.json.text), srAll.json.text);
  }

  // ---- 5. writes need an approval bound to what the user saw ---------------------------
  {
    const nope = await tool(S, 'fs_write', { path: 'new.txt', content: 'x' });
    ok('fs_write without approval is refused in the ask mode', nope.json.isError && /approval/.test(nope.json.text));
    ok('… and nothing was written', !fs.existsSync(path.join(root, 'new.txt')));
    const editArgs = { path: 'src/app.js', old_string: 'const answer = 41;', new_string: 'const answer = 42;' };
    const pv = await preview(S, 'fs_edit', editArgs);
    ok('the preview of an edit is a diff', pv.json.kind === 'diff' && pv.json.needed && /-const answer = 41;/.test(pv.json.text) && /\+const answer = 42;/.test(pv.json.text), pv.text);
    ok('the preview changed nothing', /41/.test(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8')));
    const wrongArgs = await tool(S, 'fs_edit', { ...editArgs, new_string: 'const answer = 666;' }, pv.json.token);
    ok('a token does not approve other arguments', wrongArgs.json.isError && /approval/.test(wrongArgs.json.text));
    // The token is gone now (it is used once, even when it did not match).
    const pv2 = await preview(S, 'fs_edit', editArgs);
    const other = (await call('POST', '/chats', { title: 'other', messages: [] })).json;
    await call('PUT', '/workspace/session/' + other.id, { folder: root, mode: 'ask' });
    const wrongSess = await tool(other.id, 'fs_edit', editArgs, pv2.json.token);
    ok('a token does not approve a call of another chat', wrongSess.json.isError);
    const pv3 = await preview(S, 'fs_edit', editArgs);
    const done = await tool(S, 'fs_edit', editArgs, pv3.json.token);
    ok('the approved edit is applied', !done.json.isError && fs.readFileSync(path.join(root, 'src/app.js'), 'utf8').startsWith('const answer = 42;'), done.json.text);
    ok('the result of the edit shows the diff', /\+const answer = 42;/.test(done.json.text));
    const again = await tool(S, 'fs_edit', { path: 'src/app.js', old_string: 'const answer = 42;', new_string: 'const answer = 43;' }, pv3.json.token);
    ok('a token is used once', again.json.isError && /approval/.test(again.json.text));
    // The file changes between the preview and the approval.
    const wArgs = { path: 'hello.txt', content: 'replaced\n' };
    const pvw = await preview(S, 'fs_write', wArgs);
    fs.appendFileSync(path.join(root, 'hello.txt'), 'line four\n');
    const stale = await tool(S, 'fs_write', wArgs, pvw.json.token);
    ok('a file that changed after the approval is not written', stale.json.isError && /changed/.test(stale.json.text) && /line four/.test(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')), stale.json.text);
    const amb = await preview(S, 'fs_edit', { path: 'hello.txt', old_string: 'line', new_string: 'LINE' });
    ok('an edit whose old_string is not unique is refused', !!amb.json.error && /occurs/.test(amb.json.error), amb.text);
    const outW = await preview(S, 'fs_write', { path: 'link-dir/evil.txt', content: 'x' });
    ok('a write through a symlinked folder out is refused', !!outW.json.error && !fs.existsSync(path.join(outside, 'evil.txt')), outW.text);
    const outW2 = await preview(S, 'fs_write', { path: '../evil.txt', content: 'x' });
    ok('a write to "../" is refused', !!outW2.json.error && !fs.existsSync(path.join(path.dirname(root), 'evil.txt')));
    const lfw = await preview(S, 'fs_write', { path: 'link-file', content: 'x' });
    ok('a write to a symlink that points outside is refused', !!lfw.json.error && fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'OUTSIDE-SECRET', lfw.text);
    const nw = { path: 'deep/new/file.txt', content: 'NEWFILE\n' };
    const pvn = await preview(S, 'fs_write', nw);
    ok('the preview of a new file is a diff from /dev/null', /\/dev\/null/.test(pvn.json.text) && /\+NEWFILE/.test(pvn.json.text));
    const mk = await tool(S, 'fs_write', nw, pvn.json.token);
    ok('a new file is written in new folders', !mk.json.isError && fs.readFileSync(path.join(root, 'deep/new/file.txt'), 'utf8') === 'NEWFILE\n', mk.json.text);
    const big = await preview(S, 'fs_write', { path: 'big.txt', content: 'x'.repeat(ws.LIMITS.writeBytes + 1) });
    ok('a write over the size limit is refused', !!big.json.error);
  }

  // ---- 6. the auto-edit mode -----------------------------------------------------------
  {
    await call('PUT', '/workspace/session/' + S, { folder: root, mode: 'auto-edit' });
    const w = await tool(S, 'fs_write', { path: 'auto.txt', content: 'AUTO\n' });
    ok('auto-edit: a write runs without approval', !w.json.isError && fs.readFileSync(path.join(root, 'auto.txt'), 'utf8') === 'AUTO\n', w.json.text);
    const sh = await tool(S, 'shell', { command: 'echo hi > shell-ran.txt' });
    ok('auto-edit: a command still needs approval', sh.json.isError && /approval/.test(sh.json.text) && !fs.existsSync(path.join(root, 'shell-ran.txt')));
    const pv = await preview(S, 'shell', { command: 'echo hi' });
    ok('auto-edit: the preview of a command says it is needed', pv.json.needed === true && pv.json.kind === 'command' && /\$ echo hi/.test(pv.json.text));
    await call('PUT', '/workspace/session/' + S, { folder: root, mode: 'ask' });
    const bogus = await call('PUT', '/workspace/session/' + S, { folder: root, mode: 'bypass' });
    ok('there is no bypass mode', bogus.json.mode === 'ask');
  }

  // ---- 7. the shell --------------------------------------------------------------------
  const runShell = async (args) => { const p = await preview(S, 'shell', args); return tool(S, 'shell', args, p.json.token); };
  {
    const r = await runShell({ command: 'echo "$PWD"; echo out; echo err 1>&2' });
    ok('an approved command runs in the folder', !r.json.isError && r.json.text.split('\n')[0] === root && /out/.test(r.json.text) && /err/.test(r.json.text), r.json.text);
    const env = await runShell({ command: 'env' });
    ok('the command does not see LUMEN_* or the fake key of the server', !/LUMEN_DATA|WS_TEST_API_KEY|sk-should-not-leak/.test(env.json.text) && /PATH=/.test(env.json.text), env.json.text.split('\n').filter((l) => /KEY|LUMEN/.test(l)).join(' | '));
    const sub = await runShell({ command: 'pwd', cwd: 'src' });
    ok('a command can run in a folder inside', sub.json.text.split('\n')[0] === path.join(root, 'src'));
    const subOut = await preview(S, 'shell', { command: 'pwd', cwd: '../' });
    ok('a command cannot run in a folder outside', !!subOut.json.error);
    const fail = await runShell({ command: 'exit 3' });
    ok('a failed command says its exit code', fail.json.isError && /\[exit 3\]/.test(fail.json.text));
    const big = await runShell({ command: 'yes 0123456789 | head -c 400000' });
    ok('the output is cut at 100 KB', Buffer.byteLength(big.json.text) < 100 * 1024 + 200 && /output cut at 100 KB/.test(big.json.text), Buffer.byteLength(big.json.text));
    const pidFile = path.join(root, 'child.pid');
    const t0 = Date.now();
    const slow = await runShell({ command: `sleep 77 & echo $! > ${JSON.stringify(pidFile)}; wait`, timeout_seconds: 2 });
    const took = Date.now() - t0;
    ok('a command that runs too long is stopped at its timeout', slow.json.isError && /longer than 2 s/.test(slow.json.text) && took < 8000, `${took} ms`);
    await sleep(500);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    ok('the whole process group is stopped (the child too)', childPid > 0 && !alive(childPid), childPid);
    const cap = await preview(S, 'shell', { command: 'true', timeout_seconds: 9999 });
    ok('the timeout is capped at 120 s', /timeout 120 s/.test(cap.json.text), cap.json.text);
    // The user stops a command.
    const args = { command: 'sleep 50' };
    const p = await preview(S, 'shell', args);
    const pending = tool(S, 'shell', args, p.json.token);
    await sleep(700);
    const runs = (await call('GET', '/workspace/runs/' + S)).json;
    const running = runs.find((x) => x.status === 'running' && x.command === 'sleep 50');
    ok('the run is listed while it runs', !!running);
    const k = await call('POST', '/workspace/runs/' + running.id + '/kill');
    const res = await pending;
    ok('the user can stop a command', k.json.killed === true && /stopped by the user/.test(res.json.text), res.json.text);
    ok('the run says it was killed', (await call('GET', '/workspace/runs/' + S)).json.find((x) => x.id === running.id).status === 'killed');
    // The output shows up while the command runs (the Terminal pane polls it).
    const sa = { command: 'echo FIRST-PART; sleep 2; echo SECOND-PART' };
    const sp = await preview(S, 'shell', sa);
    const sPending = tool(S, 'shell', sa, sp.json.token);
    await sleep(900);
    const mid = (await call('GET', '/workspace/runs/' + S)).json.find((x) => x.command === sa.command);
    ok('the output of a running command can be read while it runs', mid && mid.status === 'running' && /FIRST-PART/.test(mid.output) && !/SECOND-PART/.test(mid.output), mid && JSON.stringify(mid.output));
    await sPending;
    // The Stop button of the chat stops every command of the chat.
    const st = { command: 'sleep 40' };
    const stp = await preview(S, 'shell', st);
    const stPending = tool(S, 'shell', st, stp.json.token);
    await sleep(600);
    const ks = await call('POST', '/workspace/session/' + S + '/kill');
    const stRes = await stPending;
    ok('stopping the chat stops its commands', ks.json.killed === 1 && /stopped by the user/.test(stRes.json.text), JSON.stringify(ks.json));
    const noTok = await tool(S, 'shell', { command: 'touch x' }, 'not-a-token');
    ok('a forged token is refused', noTok.json.isError && !fs.existsSync(path.join(root, 'x')));
  }

  // ---- 8. the changes and the revert -----------------------------------------------
  {
    const list = (await call('GET', '/workspace/changes/' + S)).json;
    const byRel = Object.fromEntries(list.map((f) => [f.rel, f]));
    ok('the changes list the files this chat wrote', ['src/app.js', 'deep/new/file.txt', 'auto.txt'].every((r) => byRel[r]), list.map((f) => f.rel).join());
    ok('a change has a unified diff', /-const answer = 41;/.test(byRel['src/app.js'].diff) && /\+const answer = 42;/.test(byRel['src/app.js'].diff));
    ok('a new file is marked as new', byRel['auto.txt'].existed === false);
    // Edit app.js once more: the original is still the first one.
    const a2 = { path: 'src/app.js', old_string: '42', new_string: '43' };
    const pv = await preview(S, 'fs_edit', a2);
    await tool(S, 'fs_edit', a2, pv.json.token);
    const rv = await call('POST', '/workspace/changes/' + S + '/revert', { path: byRel['src/app.js'].path });
    ok('revert restores the original bytes', rv.status === 200 && fs.readFileSync(path.join(root, 'src/app.js'), 'utf8') === 'const answer = 41;\nconsole.log(answer);\n', fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'));
    const all = await call('POST', '/workspace/changes/' + S + '/revert', {});
    ok('revert all removes the new files', all.status === 200 && !fs.existsSync(path.join(root, 'auto.txt')) && !fs.existsSync(path.join(root, 'deep/new/file.txt')), all.text);
    ok('nothing is left to revert', (await call('GET', '/workspace/changes/' + S)).json.length === 0);
    // A binary file comes back byte for byte.
    const bin = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 0]);
    fs.writeFileSync(path.join(root, 'blob.txt'), 'text before\n');
    const w = { path: 'blob.txt', content: 'text after\n' };
    const pb = await preview(S, 'fs_write', w);
    await tool(S, 'fs_write', w, pb.json.token);
    await call('POST', '/workspace/changes/' + S + '/revert', {});
    ok('a reverted file is the same bytes', fs.readFileSync(path.join(root, 'blob.txt'), 'utf8') === 'text before\n');
    fs.writeFileSync(path.join(root, 'bin.dat'), bin);
    const rb = await tool(S, 'fs_read', { path: 'bin.dat' });
    ok('a binary file is not read as text', rb.json.isError && /binary/.test(rb.json.text));
  }

  // ---- 9. a folder that is no longer trusted ------------------------------------------
  {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ws2-')));
    await call('POST', '/workspace/folders', { path: other });
    const c2 = (await call('POST', '/chats', { title: 'gone', messages: [] })).json;
    await call('PUT', '/workspace/session/' + c2.id, { folder: other, mode: 'ask' });
    ok('the chat of the second folder has access', !(await tool(c2.id, 'fs_list', {})).json.isError);
    await call('POST', '/workspace/folders/remove', { path: other });
    const after = await tool(c2.id, 'fs_list', {});
    ok('a folder that is no longer trusted gives no access', after.json.isError, after.json.text);
  }

  // ---- 9b. the folder of a project ---------------------------------------------------
  {
    const proj = (await call('POST', '/projects', { name: 'WS project' })).json;
    const bad = await call('PUT', '/workspace/projects/' + proj.id, { folder: outside });
    ok('a project cannot get a folder that is not trusted', bad.status === 400);
    await call('PUT', '/workspace/projects/' + proj.id, { folder: root });
    const pc = (await call('POST', '/chats', { title: 'in project', project: proj.id, messages: [] })).json;
    const cfg = (await call('GET', '/workspace/session/' + pc.id)).json;
    ok('a chat of the project starts in the folder of the project, in the ask mode', cfg.folder === root && cfg.mode === 'ask' && cfg.fromProject === true, JSON.stringify(cfg));
    const lst = await tool(pc.id, 'fs_list', {});
    ok('… and can read it', !lst.json.isError);
    const w = await tool(pc.id, 'fs_write', { path: 'p.txt', content: 'x' });
    ok('… and still needs approval for a write', w.json.isError && !fs.existsSync(path.join(root, 'p.txt')));
  }

  // ---- 10. scheduled tasks --------------------------------------------------------------
  {
    const bad = await call('POST', '/workspace/schedules', { name: 'x', prompt: 'y', model: MODEL, kind: 'interval', every: 0 });
    ok('a task needs a sensible interval', bad.status === 400);
    const t = await call('POST', '/workspace/schedules', { name: 'Ping task', prompt: 'Reply with exactly the word SCHEDOK and nothing else.', model: MODEL || 'gemma4:latest', kind: 'interval', every: 1,
      folder: root, allowTools: ['workspace/fs_read', 'workspace/fs_write', 'workspace/shell', 'workspace/fs_edit'] });
    ok('a task is made', t.status === 200 && !!t.json.id, t.text);
    ok('a task never gets the tools that change files or run commands', JSON.stringify(t.json.allowTools) === '["workspace/fs_read"]', JSON.stringify(t.json.allowTools));
    // The headless path refuses a write even when asked directly.
    const W = new ws.Workspace({ dataDir: path.join(TMP, 'ws-unit'), getConfig: () => ({ folder: root, mode: 'auto-edit' }) });
    const hw = await W.call('fs_write', { path: 'headless.txt', content: 'x' }, { session: 'unit', headless: true });
    ok('a scheduled task cannot write, even in auto-edit', hw.isError && !fs.existsSync(path.join(root, 'headless.txt')), hw.text);
    const hs = await W.call('shell', { command: 'touch headless2' }, { session: 'unit', headless: true });
    ok('a scheduled task cannot run a command', hs.isError && !fs.existsSync(path.join(root, 'headless2')));
    // The timer fires the task within a minute and a few seconds.
    const before = Date.now();
    let fired = null;
    for (let i = 0; i < 100 && !fired; i++) {
      await sleep(1000);
      const info = (await call('GET', '/workspace')).json;
      const me = info.schedules.find((x) => x.id === t.json.id);
      if (me && me.lastRun) fired = me;
    }
    ok('the schedule fires by itself', !!fired, fired ? `${Math.round((Date.now() - before) / 1000)} s` : 'never');
    if (fired) {
      const c = (await call('GET', '/chats/' + fired.lastChat)).json;
      ok('the answer lands in a new chat', c && c.title === 'Scheduled: Ping task' && c.messages[0].role === 'user', c && c.title);
      ok('the model answered the task', /SCHEDOK/i.test((c.messages.at(-1) || {}).content || ''), JSON.stringify((c.messages.at(-1) || {}).content));
    }
    await call('DELETE', '/workspace/schedules/' + t.json.id);
    ok('a task can be deleted', !(await call('GET', '/workspace')).json.schedules.some((x) => x.id === t.json.id));
  }

  // ---- 11. the browser: the bar, the approval cards, the panes, the badge ---------------
  const hok = ok;
  // The folders were trusted after the page loaded: the page reads them again.
  await ev(`wsAfterChange().then(() => 1)`);
  await ev(`document.querySelector('#thinkToggle').checked && document.querySelector('#thinkToggle').click(); 1`);
  await waitFor(`!document.querySelector('#wsBar').hidden`, 10000);
  hok('the workspace bar shows when a folder is trusted', await ev(`!document.querySelector('#wsBar').hidden`));
  hok('the bar warns that this is not a sandbox', /Not a sandbox/.test(await ev(`document.querySelector('#wsBar').innerText`)));
  // The dialog lists the folder and refuses a protected one.
  await ev(`document.querySelector('#wsBtn').click(); 1`);
  await waitFor(`document.querySelector('#wsDlg').open`);
  hok('the dialog lists the trusted folder', (await ev(`document.querySelector('#wsFolders').innerText`)).includes(root));
  await ev(`document.querySelector('#wsPath').value = '/etc'; document.querySelector('#wsAddFolder').click(); 1`);
  await waitFor(`/protected/.test(document.querySelector('#wsFolderMsg').textContent)`, 5000);
  hok('the dialog says why a folder is refused', /protected/.test(await ev(`document.querySelector('#wsFolderMsg').textContent`)));
  await ev(`document.querySelector('#wsClose').click(); 1`);

  // A new chat: no folder, so the model gets no workspace tools.
  await ev(`newChat(); 1`);
  await sleep(500);
  hok('a chat without a folder sends no workspace tools', await ev(`!(buildTools() || { defs: [] }).defs.some((d) => d.function.name.startsWith('workspace__'))`));
  await ev(`(() => { const s = document.querySelector('#wsFolder'); s.value = ${JSON.stringify(root)}; s.dispatchEvent(new Event('change')); })(); 1`);
  await sleep(500);
  hok('a chat with a folder sends the workspace tools', await ev(`(buildTools() || { defs: [] }).defs.some((d) => d.function.name === 'workspace__fs_write')`));

  // A tool call of the model is made by hand here (the real model comes after): the
  // approval card shows the diff and has no "Always allow".
  const fakeCall = (name, args) => `(async () => {
    const set = buildTools();
    const reply = { role: 'assistant', content: '', model: state.chat.model, t: Date.now(), toolCalls: [registerCall({ function: { name: ${JSON.stringify(name)}, arguments: ${JSON.stringify(args)} } }, set.map)] };
    state.chat.messages.push({ role: 'user', content: 'test' }, reply); renderAll();
    window.__done = false; runToolCalls(state.chat, reply).then(() => { window.__done = true; });
    return 1; })()`;
  await ev(fakeCall('workspace__fs_edit', { path: 'hello.txt', old_string: 'line one', new_string: 'LINE ONE' }));
  await waitFor(`!!document.querySelector('.toolcall.awaiting')`, 10000);
  const card = await ev(`document.querySelector('.toolcall.awaiting').innerText`);
  hok('the approval card of an edit shows the diff', /-line one/.test(card) && /\+LINE ONE/.test(card), card.slice(0, 200));
  hok('an edit has no "Always allow"', await ev(`!document.querySelector('.toolcall.awaiting [data-tc=always]')`));
  hok('the chat was saved before its first workspace call', await ev(`!!state.chat.id`));
  const chatId = await ev(`state.chat.id`);
  await sleep(400);
  hok('the sidebar marks the chat that waits for approval', await ev(`(() => { const i = state.chats.findIndex((c) => c.id === ${JSON.stringify(chatId)}); const el = document.querySelectorAll('#chatList .chat')[i]; return !!(el && el.querySelector('.wait')); })()`));
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=once]').click(); 1`);
  await waitFor(`window.__done`, 10000);
  hok('the approved edit is applied', fs.readFileSync(path.join(root, 'hello.txt'), 'utf8').startsWith('LINE ONE'));
  hok('the badge goes away after the approval', await ev(`!document.querySelector('#chatList .wait')`));
  await waitFor(`document.querySelector('#wsChangesN').textContent === '1'`, 5000);
  hok('the Changes button counts the file', (await ev(`document.querySelector('#wsChangesN').textContent`)) === '1');

  // The notification while the tab is in the background (a command this time).
  await ev(`window.__hidden = true; 1`);
  await ev(fakeCall('workspace__shell', { command: 'echo TERMINAL-OUT-77' }));
  await waitFor(`!!document.querySelector('.toolcall.awaiting')`, 10000);
  const shellCard = await ev(`document.querySelector('.toolcall.awaiting').innerText`);
  hok('the approval card of a command shows the exact command', /\$ echo TERMINAL-OUT-77/.test(shellCard), shellCard.slice(0, 160));
  hok('a command has no "Always allow"', await ev(`!document.querySelector('.toolcall.awaiting [data-tc=always]')`));
  hok('a notification is shown while the tab is in the background', await ev(`window.__notes.some((n) => /needs your input/.test(n.t) && /shell/.test(n.body))`), await ev(`JSON.stringify(window.__notes)`));
  await ev(`window.__hidden = false; 1`);
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=once]').click(); 1`);
  await waitFor(`window.__done`, 10000);
  hok('the approved command ran', /TERMINAL-OUT-77/.test(await ev(`state.chat.messages.at(-1).toolCalls[0].result || ''`)));
  await ev(`document.querySelector('#wsTermBtn').click(); 1`);
  await waitFor(`/TERMINAL-OUT-77/.test(document.querySelector('#wsRunList').innerText)`, 5000);
  hok('the Terminal pane shows the output of the command', /TERMINAL-OUT-77/.test(await ev(`document.querySelector('#wsRunList').innerText`)));
  // A denied command does not run.
  await ev(fakeCall('workspace__shell', { command: 'touch denied-ran.txt' }));
  await waitFor(`!!document.querySelector('.toolcall.awaiting')`, 10000);
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=deny]').click(); 1`);
  await waitFor(`window.__done`, 10000);
  hok('a denied command does not run', !fs.existsSync(path.join(root, 'denied-ran.txt')) && (await ev(`state.chat.messages.at(-1).toolCalls[0].status`)) === 'denied');
  // A read runs without asking.
  await ev(fakeCall('workspace__fs_read', { path: 'hello.txt' }));
  await waitFor(`window.__done`, 10000);
  hok('a read runs without asking', /LINE ONE/.test(await ev(`state.chat.messages.at(-1).toolCalls[0].result || ''`)) && (await ev(`state.chat.messages.at(-1).toolCalls[0].status`)) === 'done');
  // Auto-edit: the edit runs and the card still shows the diff.
  await ev(`(() => { const s = document.querySelector('#wsMode'); s.value = 'auto-edit'; s.dispatchEvent(new Event('change')); })(); 1`);
  await sleep(500);
  await ev(fakeCall('workspace__fs_edit', { path: 'hello.txt', old_string: 'LINE ONE', new_string: 'line one' }));
  await waitFor(`window.__done`, 10000);
  hok('auto-edit: the edit runs without asking', fs.readFileSync(path.join(root, 'hello.txt'), 'utf8').startsWith('line one') && (await ev(`state.chat.messages.at(-1).toolCalls[0].status`)) === 'done');
  hok('auto-edit: the card shows the diff of the edit', /\+line one/.test(await ev(`[...document.querySelectorAll('#messages .toolcall')].at(-1).innerText`)));
  await ev(`(() => { const s = document.querySelector('#wsMode'); s.value = 'ask'; s.dispatchEvent(new Event('change')); })(); 1`);
  // The Changes pane and its revert.
  await ev(`document.querySelector('#wsChangesBtn').click(); 1`);
  await waitFor(`document.querySelectorAll('#wsChangeList .wsfile').length >= 1`, 5000);
  hok('the Changes pane lists the file', /hello\.txt/.test(await ev(`document.querySelector('#wsChangeList').innerText`)));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'CHANGED ON DISK\n');
  await ev(`wsRefreshChanges(); 1`);
  await waitFor(`/CHANGED ON DISK/.test(document.querySelector('#wsChangeList').innerText)`, 5000);
  hok('the diff of the pane is against the original', /\+CHANGED ON DISK/.test(await ev(`document.querySelector('#wsChangeList').innerText`)));
  await ev(`document.querySelector('#wsRevertAll').click(); 1`);
  await waitFor(`document.querySelector('#wsChangesN').textContent === '0'`, 5000);
  hok('Revert all in the pane restores the file', fs.readFileSync(path.join(root, 'hello.txt'), 'utf8') === 'line one\nline two\nline three\nline four\n', JSON.stringify(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')));
  // The folder of the chat comes back after the chat is opened again.
  await ev(`newChat(); 1`); await sleep(400);
  hok('a new chat starts without a folder', (await ev(`document.querySelector('#wsFolder').value`)) === '');
  await ev(`openChat(${JSON.stringify(chatId)}); 1`);
  await waitFor(`document.querySelector('#wsFolder').value === ${JSON.stringify(root)}`, 5000);
  hok('the chat keeps its folder', (await ev(`document.querySelector('#wsFolder').value`)) === root);

  // ---- 12. a real model creates a file and reads it back ------------------------------
  {
    await ev(`newChat(); 1`); await sleep(400);
    await ev(`(() => { const s = document.querySelector('#wsFolder'); s.value = ${JSON.stringify(root)}; s.dispatchEvent(new Event('change')); })(); 1`);
    await sleep(500);
    const target = path.join(root, 'model-note.txt');
    const reply = await h.ask('Use the workspace fs_write tool to create the file model-note.txt with exactly this content: WS-MODEL-4711. Then use the fs_read tool to read model-note.txt back and tell me what it contains.', 240000);
    const calls = await ev(`JSON.stringify(state.chat.messages.flatMap((m) => (m.toolCalls || []).map((c) => [c.tool, c.status])))`);
    hok('the model wrote the file (after the approval)', fs.existsSync(target) && /WS-MODEL-4711/.test(fs.readFileSync(target, 'utf8')), calls);
    hok('the model read the file back', /\["fs_read","done"\]/.test(calls), calls);
    hok('the answer has the content', /WS-MODEL-4711/.test(reply), JSON.stringify(reply).slice(0, 200));
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  h.close();
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
