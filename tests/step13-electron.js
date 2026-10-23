// Step 13 — the desktop app (Electron): the window loads the app from the in-process
// server, the page has no Node.js and only the bridge, the window stays on the local
// origin, one instance hands its link to the first, Quick Entry, files opened with the
// app, lumen:// links, the menu, notifications, close to tray, the login item.
//
// Electron is driven over CDP (--remote-debugging-port). The app runs in its test mode:
// it does not open the browser, change the login items, take global shortcuts or
// register the lumen:// protocol. A window opens on the screen while the test runs.
// Not covered (manual): the global shortcuts, the real tray icon and its menu, real
// notifications, the real login item, dictation.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { sleep } = require('./lib/cdplib');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron');
const TMP = fs.mkdtempSync(path.join(process.env.LUMEN_TEST_TMP || os.tmpdir(), 'lumen-desk-'));

let failures = 0;
const ok = (label, cond, extra = '') => { if (!cond) failures++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== '' ? '  -> ' + extra : '')); };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const portOpen = (port) => new Promise((r) => { const s = net.connect({ port, host: '127.0.0.1' }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

const procs = [];
// A test that stops early (a promise that never settles empties the event loop) must
// not pass: the last line of a finished run is ALL PASSED or N FAILED.
let finished = false;
process.on('exit', (code) => { if (!finished) { console.log('FAIL the test stopped before its end'); process.exitCode = 1; } });
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));

function startApp({ port, dbg, profile, data, args = [] }) {
  const env = { ...process.env, LUMEN_DESKTOP_TEST: '1', PORT: String(port), LUMEN_DESKTOP_PROFILE: profile, LUMEN_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, [path.join(ROOT, 'desktop', 'main.js'), ...(dbg ? [`--remote-debugging-port=${dbg}`] : []), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  p.exited = new Promise((r) => p.on('exit', (code) => r(code)));
  procs.push(p);
  return p;
}
// A small CDP client for one target.
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
  const cmd = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (!r.result) return 'ERR ' + JSON.stringify(r.error);
    if (r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
    return r.result.result.value;
  };
  const waitFor = async (expr, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { if ((await ev(expr)) === true) return true; await sleep(200); } return false; };
  return { ws, cmd, ev, waitFor, close: () => ws.close() };
}
async function targets(dbg) { try { return await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch { return []; } }
async function findTarget(dbg, pred, ms = 30000) {
  for (let i = 0; i < ms / 250; i++) { const t = (await targets(dbg)).find(pred); if (t) return t; await sleep(250); }
  return null;
}

(async () => {
  const port = await freePort(), dbg = await freePort();
  const ORIGIN = `http://127.0.0.1:${port}`;
  const profile = path.join(TMP, 'profile'), data = path.join(TMP, 'data', 'chats.json');
  const app = startApp({ port, dbg, profile, data });
  const t = await findTarget(dbg, (x) => x.type === 'page' && x.url.startsWith(ORIGIN));
  ok('the window loads the app from the local server', !!t, t ? t.url : app.log.slice(-400));
  if (!t) { console.log('\n1 FAILED'); process.exit(1); }
  const page = await connect(t.webSocketDebuggerUrl);
  const { ev, waitFor } = page;
  await waitFor(`typeof state === 'object' && !!state.ready`, 20000);
  await ev(`state.ready.then(() => 1)`);
  ok('the app boots in the window', (await ev(`document.title`)) !== '' && (await ev(`!!document.querySelector('#composer')`)) === true);
  ok('the server runs in the app with its own data folder', fs.existsSync(path.dirname(data)) && (await (await fetch(ORIGIN + '/api/config')).json()).name === 'Lumen');
  {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) ok('the server does not answer on the network address', !(await new Promise((r) => { const s = net.connect({ port, host: lan.address }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })), lan.address);
    else console.log('SKIP no network address to check');
  }

  // ---- the page has no Node.js and only the bridge -------------------------------
  ok('the page has no require', (await ev(`typeof require`)) === 'undefined');
  ok('the page has no process', (await ev(`typeof process`)) === 'undefined');
  ok('the bridge is there', (await ev(`typeof window.lumenDesktop === 'object'`)) === true);
  const keys = await ev(`Object.keys(window.lumenDesktop).sort().join()`);
  ok('the bridge has only its named calls', keys === 'info,notify,on,platform,prefs,test', keys);
  ok('the bridge is frozen', (await ev(`(() => { try { window.lumenDesktop.evil = 1; } catch (e) {} return !('evil' in window.lumenDesktop) && Object.isFrozen(window.lumenDesktop); })()`)) === true);
  ok('the page cannot reach ipcRenderer', (await ev(`typeof window.ipcRenderer === 'undefined' && typeof window.electron === 'undefined' && typeof window.require === 'undefined'`)) === true);
  ok('the bridge only listens to its own channels', (await ev(`(() => { let hit = false; window.lumenDesktop.on('../../evil', () => { hit = true; }); window.lumenDesktop.on('desktop:menu', () => { hit = true; }); return window.lumenDesktop.on('nope', 1) === undefined && !hit; })()`)) === true);
  const st0 = await ev(`window.lumenDesktop.test('state')`);
  ok('context isolation and the sandbox are on, Node.js integration is off', st0.webPreferences && st0.webPreferences.contextIsolation === true && st0.webPreferences.sandbox === true && st0.webPreferences.nodeIntegration === false, JSON.stringify(st0.webPreferences));
  // An iframe of the app (like the split pane) gets no bridge.
  await ev(`new Promise((r) => { const f = document.createElement('iframe'); f.id = 'probeFrame'; f.src = '/?embed=1'; f.onload = () => r(1); document.body.appendChild(f); })`);
  ok('an iframe gets no bridge', (await ev(`document.querySelector('#probeFrame').contentWindow.lumenDesktop === undefined`)) === true);
  await ev(`document.querySelector('#probeFrame').remove(); 1`);
  // The API answers the window (the guard accepts its origin).
  const made = await ev(`fetch('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Desk chat', messages: [] }) }).then((r) => r.json())`);
  ok('the guard accepts the requests of the window', made && /^[0-9a-f-]{36}$/.test(made.id), JSON.stringify(made));

  // ---- the window stays on the local origin --------------------------------------
  ok('window.open of a web page is refused', (await ev(`window.open('https://example.com/opened') === null`)) === true);
  await ev(`location.href = 'https://example.com/navigated'; 1`);
  await sleep(1200);
  ok('the window does not navigate to another site', (await ev(`location.origin`)) === ORIGIN);
  await ev(`location.href = 'file:///etc/hosts'; 1`);
  await sleep(800);
  ok('the window does not navigate to a file', (await ev(`location.origin`)) === ORIGIN);
  const quickUrl = 'file://' + path.join(ROOT, 'desktop', 'quick.html');
  await ev(`location.href = ${JSON.stringify(quickUrl)}; 1`);
  await sleep(800);
  ok('the main window does not navigate to the Quick Entry page', (await ev(`location.origin`)) === ORIGIN);
  const st1 = await ev(`window.lumenDesktop.test('state')`);
  ok('the web links are handed to the browser (recorded in the test mode)', st1.external.includes('https://example.com/opened') && st1.external.includes('https://example.com/navigated'), JSON.stringify(st1.external));
  ok('a file link is not handed out', !st1.external.some((u) => u.startsWith('file:')));

  // ---- the menu and the tray -------------------------------------------------------
  const file = (st1.menu.find((m) => m.label === 'File') || {}).items || [];
  const view = (st1.menu.find((m) => m.label === 'View') || {}).items || [];
  ok('the menu has the commands of the app', ['New Chat', 'Quick Entry', 'Open File…', 'Settings…'].every((x) => file.includes(x)) && ['Find in Conversation', 'Side Chat', 'Split View', 'Dictate'].every((x) => view.includes(x)), JSON.stringify(st1.menu));
  ok('the tray is there', st1.tray === true);

  // ---- Quick Entry ---------------------------------------------------------------------
  await ev(`window.lumenDesktop.test('openQuick')`);
  const qt = await findTarget(dbg, (x) => x.type === 'page' && x.url.endsWith('/desktop/quick.html'), 10000);
  ok('Quick Entry opens its window', !!qt && (await ev(`window.lumenDesktop.test('state')`)).quickVisible === true);
  const q = await connect(qt.webSocketDebuggerUrl);
  ok('the Quick Entry page has no require and only its bridge', (await q.ev(`typeof require === 'undefined' && Object.keys(window.quickEntry).sort().join() === 'close,onReset,submit'`)) === true);
  await q.ev(`document.getElementById('q').value = 'QUICK-ENTRY-77 reply with one word'; document.getElementById('f').requestSubmit(); 1`);
  const sent = await waitFor(`state.chat.messages.length > 0 && state.chat.messages[0].content === 'QUICK-ENTRY-77 reply with one word'`, 15000);
  ok('Quick Entry sends the text to a new chat', sent, await ev(`JSON.stringify(state.chat.messages.map((m) => m.content).slice(0, 2))`));
  ok('Quick Entry hides after sending', (await ev(`window.lumenDesktop.test('state')`)).quickVisible === false);
  q.close();
  await ev(`document.querySelector('#stopBtn').click(); 1`);
  await waitFor(`!state.streaming && !state.toolsBusy`, 30000);

  // ---- files opened with the app -------------------------------------------------------
  const note = path.join(TMP, 'opened-note.txt');
  fs.writeFileSync(note, 'OPENED-FILE-55 is in this note');
  await ev(`newChat(); 1`);
  await ev(`window.lumenDesktop.test('openFiles', ${JSON.stringify([note, path.join(TMP, 'nope.txt'), TMP])})`);
  const got = await waitFor(`state.pending.some((a) => a.name === 'opened-note.txt' && /OPENED-FILE-55/.test(a.text || ''))`, 10000);
  ok('a file opened with the app is attached', got, await ev(`JSON.stringify(state.pending.map((a) => a.name))`));
  ok('a folder or a missing file is not attached', (await ev(`state.pending.length`)) === 1);
  await ev(`state.pending = []; renderChips(); 1`);

  // ---- lumen:// links -------------------------------------------------------------------
  await ev(`window.lumenDesktop.test('deepLink', ${JSON.stringify('lumen://chat/' + made.id)})`);
  ok('lumen://chat/<id> opens the chat', await waitFor(`state.chat.id === ${JSON.stringify(made.id)}`, 8000));
  await ev(`window.lumenDesktop.test('deepLink', 'lumen://chat/../../etc')`);
  await sleep(500);
  ok('a bad link does nothing', (await ev(`state.chat.id`)) === made.id);
  await ev(`window.lumenDesktop.test('deepLink', ${JSON.stringify('lumen://new?text=' + encodeURIComponent('DEEP-LINK-TEXT'))})`);
  await waitFor(`document.querySelector('#input').value === 'DEEP-LINK-TEXT'`, 8000);
  ok('lumen://new puts the text into the message box', (await ev(`document.querySelector('#input').value`)) === 'DEEP-LINK-TEXT');
  ok('… and does not send it', (await ev(`state.chat.messages.length`)) === 0 && (await ev(`!state.chat.id`)) === true);
  await ev(`document.querySelector('#input').value = ''; 1`);

  // ---- one instance ---------------------------------------------------------------------
  const before = (await ev(`window.lumenDesktop.test('state')`)).secondInstances;
  const t0 = Date.now();
  const second = startApp({ port, profile, data, args: ['lumen://new?text=' + encodeURIComponent('FROM-SECOND-START')] });
  const code = await Promise.race([second.exited, sleep(20000).then(() => 'timeout')]);
  ok('a second start quits right away', code !== 'timeout' && Date.now() - t0 < 20000, `${code} after ${Date.now() - t0} ms`);
  await waitFor(`document.querySelector('#input').value === 'FROM-SECOND-START'`, 8000);
  const after = (await ev(`window.lumenDesktop.test('state')`)).secondInstances;
  ok('… and hands its link to the first one', after === before + 1 && (await ev(`document.querySelector('#input').value`)) === 'FROM-SECOND-START', `${before} -> ${after}`);
  await ev(`document.querySelector('#input').value = ''; 1`);

  // ---- notifications ----------------------------------------------------------------------
  await ev(`document.hasFocus = () => false; 1`);
  await ev(`hooks.onReply({ role: 'assistant', content: 'done' }, { title: 'Desk chat' }); 1`);
  await sleep(1700);
  await ev(`hooks.onAwait({ id: 'x', serverName: 'Workspace', tool: 'shell' }, state.chat, true); hooks.onAwait({ id: 'x', serverName: 'Workspace', tool: 'shell' }, state.chat, false); 1`);
  await sleep(300);
  const notes = (await ev(`window.lumenDesktop.test('state')`)).notifications;
  ok('a finished reply is notified while the window is not in front', notes.some((n) => /reply finished/.test(n.title) && n.body === 'Desk chat'), JSON.stringify(notes));
  ok('a tool call waiting for approval is notified', notes.some((n) => /needs your input/.test(n.title) && /shell/.test(n.body)), JSON.stringify(notes));
  const n0 = notes.length;
  await ev(`window.lumenDesktop.notify('a', 'b'); window.lumenDesktop.notify('c', 'd'); window.lumenDesktop.notify('e', 'f'); 1`);
  await sleep(300);
  ok('notifications are rate-limited', (await ev(`window.lumenDesktop.test('state')`)).notifications.length - n0 <= 1);
  await ev(`delete document.hasFocus; 1`);

  // ---- preferences: launch at login, close to tray ----------------------------------------
  const p1 = await ev(`window.lumenDesktop.prefs({ openAtLogin: true, background: true, evil: 1 })`);
  ok('the preferences are saved', p1.openAtLogin === true && p1.background === true && !('evil' in p1), JSON.stringify(p1));
  ok('the login item is set (recorded, not the real one, in the test mode)', (await ev(`window.lumenDesktop.test('state')`)).loginItem === true);
  ok('the preferences are written to the profile', JSON.parse(fs.readFileSync(path.join(profile, 'desktop.json'), 'utf8')).background === true);
  await ev(`document.querySelector('#settingsBtn').click(); 1`);
  await waitFor(`document.querySelector('#deskBg') && document.querySelector('#deskBg').checked === true`, 5000);
  ok('the Settings dialog shows the desktop preferences', (await ev(`!!document.querySelector('#deskPrefs') && document.querySelector('#deskLogin').checked`)) === true);
  ok('the Settings dialog names the shortcuts', /Quick Entry: Alt\+CommandOrControl\+L/.test(await ev(`document.querySelector('#deskKeys').textContent`)));
  await ev(`document.querySelector('#setClose').click(); 1`);
  await ev(`window.lumenDesktop.test('closeWindow')`);
  await sleep(800);
  const st2 = await ev(`window.lumenDesktop.test('state')`);
  ok('with "keep running" on, closing the window hides it', st2.winVisible === false && app.exitCode === null);
  ok('… and the server keeps running', (await (await fetch(ORIGIN + '/api/config')).json()).name === 'Lumen');
  await ev(`window.lumenDesktop.test('showWindow')`);
  await sleep(500);
  ok('the window comes back', (await ev(`window.lumenDesktop.test('state')`)).winVisible === true);
  await ev(`window.lumenDesktop.prefs({ openAtLogin: false, background: false })`);
  ok('the login item is unset again', (await ev(`window.lumenDesktop.test('state')`)).loginItem === false);
  // With "keep running" off, closing the window quits the app (and its server).
  // Not awaited: the window goes away with the answer.
  ev(`window.lumenDesktop.test('closeWindow')`);
  const ex = await Promise.race([app.exited, sleep(15000).then(() => 'timeout')]);
  ok('with "keep running" off, closing the window quits the app', ex !== 'timeout', String(ex));
  await sleep(500);
  ok('… and its server stops', !(await portOpen(port)));
  page.close();

  // ---- a Lumen that already runs is used as it is ---------------------------------------
  {
    const base = new URL(process.env.LUMEN_URL || 'http://localhost:3101');
    const p2 = Number(base.port), dbg2 = await freePort();
    if (await portOpen(p2)) {
      const data2 = path.join(TMP, 'data2', 'chats.json');
      const app2 = startApp({ port: p2, dbg: dbg2, profile: path.join(TMP, 'profile2'), data: data2 });
      const t2 = await findTarget(dbg2, (x) => x.type === 'page' && x.url.startsWith(`http://127.0.0.1:${p2}`));
      ok('the app uses a Lumen server that already runs', !!t2);
      ok('… and does not start a second server on its data', !fs.existsSync(path.dirname(data2)));
      if (t2) { const c2 = await connect(t2.webSocketDebuggerUrl); await c2.waitFor(`typeof state === 'object'`, 15000); await c2.ev(`window.lumenDesktop.test('quit')`); c2.close(); }
      await Promise.race([app2.exited, sleep(10000)]);
      ok('… and leaves that server running when it quits', await portOpen(p2));
    } else console.log('SKIP no test server on ' + p2);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  finished = true;
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { finished = true; console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
