// Checks for the CDP harness itself (tests/lib/cdplib.js):
//   - cleaning a debug port must never kill a process that is not one of our browsers
//   - a leftover harness browser on the port must be stopped
//   - Ctrl+C and a closed terminal (SIGHUP) must stop the browser as well
//   - the Chrome profile of a finished run must not stay in the temp dir
//   - the checks must work with any free port, not with hard-coded ones
// The browser under test runs on its own port; the checks use free ports of their own.
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { freePort, listenerPids, T } = require('./cdplib');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A child that is still running (not exited and not killed). The pid alone would lie:
// a dead child stays visible as a zombie until it is reaped.
const stillRunning = (child) => child.exitCode === null && child.signalCode === null;
// Wait until the child is really gone (the 'exit' event arrives a tick after the kill).
const waitExit = (child, ms = 5000) => new Promise((res) => {
  if (!stillRunning(child)) return res(true);
  child.once('exit', () => res(true));
  setTimeout(() => res(!stillRunning(child)), ms);
});
const listening = (port) => listenerPids(port).length > 0;

async function waitPort(port, ms = 8000) {
  for (let i = 0; i < ms / 100; i++) { if (listening(port)) return true; await sleep(100); }
  return false;
}

// A free port from the OS — the harness must not depend on a fixed port.
function ephemeralPort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// A process that only listens on a port — it belongs to nobody but the test.
// The extra args are passed after "--" so node does not read them as its own options.
function spawnListener(port, extraArgs = []) {
  return spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`, '--', ...extraArgs], { stdio: 'ignore' });
}

// A child that runs the harness and opens a browser on the given port.
function spawnBrowserChild(port) {
  return spawn(process.execPath, [path.join(__dirname, 'cdp-child.js'), 'about:blank', String(port)],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LUMEN_TEST_MODEL: '' } });
}

async function runHarnessChecks(ok) {
  // 0. The ports the harness used to work with are taken: the checks must not need them.
  const legacy = [9390, 9391, 9392];
  const squatters = legacy.map((p) => spawnListener(p));
  await sleep(500);
  ok('the old fixed debug ports are occupied', legacy.every((p) => listening(p)), legacy.join(', '));

  // 1. A foreign process on the debug port must survive the cleanup.
  const foreignPort = await ephemeralPort();
  const foreign = spawnListener(foreignPort);
  ok('the foreign listener is up', await waitPort(foreignPort), `port ${foreignPort}`);
  await freePort(foreignPort);
  await sleep(500);
  ok('a foreign process on the debug port is not killed', stillRunning(foreign), `pid ${foreign.pid}`);
  ok('the foreign process keeps the port', listening(foreignPort), `port ${foreignPort}`);
  try { foreign.kill('SIGKILL'); } catch { /* gone */ }
  await sleep(200);

  // 2. A leftover harness browser (it carries our profile dir) must be stopped.
  const stalePort = await ephemeralPort();
  const stale = spawnListener(stalePort, [`--remote-debugging-port=${stalePort}`, `--user-data-dir=${T}/chrome-prof-${stalePort}-999999`]);
  ok('the leftover browser holds the port', await waitPort(stalePort), `port ${stalePort}`);
  await freePort(stalePort);
  ok('a leftover harness browser is stopped', await waitExit(stale), `pid ${stale.pid}`);
  ok('the debug port is free again', !listening(stalePort), `port ${stalePort}`);
  try { stale.kill('SIGKILL'); } catch { /* gone */ }

  // 3. Ctrl+C in the harness must stop the browser too (the 'exit' hook does not fire).
  const childPort = await ephemeralPort();
  const child = spawnBrowserChild(childPort);
  ok('the child browser is listening on its debug port', await waitPort(childPort, 15000), `port ${childPort}`);
  child.kill('SIGINT');
  await sleep(2000);
  ok('Ctrl+C stops the browser as well', !listening(childPort), `port ${childPort}`);
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  await freePort(childPort);

  // 4. A closed terminal (SIGHUP) must stop the browser as well.
  const hupPort = await ephemeralPort();
  const hupChild = spawnBrowserChild(hupPort);
  ok('the child browser is listening on its debug port (SIGHUP)', await waitPort(hupPort, 15000), `port ${hupPort}`);
  hupChild.kill('SIGHUP');
  await sleep(2000);
  ok('SIGHUP stops the browser as well', !listening(hupPort), `port ${hupPort}`);
  try { hupChild.kill('SIGKILL'); } catch { /* gone */ }
  await freePort(hupPort);

  // 5. The Chrome profile of a finished run must not stay in the temp dir.
  const profPort = await ephemeralPort();
  const profChild = spawnBrowserChild(profPort);
  await waitPort(profPort, 15000);
  const profile = path.join(T, `chrome-prof-${profPort}-${profChild.pid}`);
  ok('the browser leaves a profile behind', fs.existsSync(profile), profile);
  profChild.kill('SIGINT');
  await sleep(2000);
  await freePort(profPort);
  ok('the profile of a finished browser is removed', !fs.existsSync(profile), profile);
  try { profChild.kill('SIGKILL'); } catch { /* gone */ }

  for (const s of squatters) { try { s.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(200);
}

module.exports = { runHarnessChecks };
