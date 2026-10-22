// Checks for the CDP harness itself (tests/lib/cdplib.js):
//   - cleaning a debug port must never kill a process that is not one of our browsers
//   - a leftover harness browser on the port must be stopped
//   - Ctrl+C in the harness must stop the browser as well
// The browser under test runs on its own port; the checks use separate ports.
const { spawn } = require('child_process');
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

// A process that only listens on a port — it belongs to nobody but the test.
// The extra args are passed after "--" so node does not read them as its own options.
function spawnListener(port, extraArgs = []) {
  return spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`, '--', ...extraArgs], { stdio: 'ignore' });
}

async function runHarnessChecks(ok) {
  // 1. A foreign process on the debug port must survive the cleanup.
  const foreignPort = 9390;
  const foreign = spawnListener(foreignPort);
  ok('the foreign listener is up', await waitPort(foreignPort), `port ${foreignPort}`);
  await freePort(foreignPort);
  await sleep(500);
  ok('a foreign process on the debug port is not killed', stillRunning(foreign), `pid ${foreign.pid}`);
  ok('the foreign process keeps the port', listening(foreignPort), `port ${foreignPort}`);
  try { foreign.kill('SIGKILL'); } catch { /* gone */ }
  await sleep(200);

  // 2. A leftover harness browser (it carries our profile dir) must be stopped.
  const stalePort = 9391;
  const stale = spawnListener(stalePort, [`--remote-debugging-port=${stalePort}`, `--user-data-dir=${T}/chrome-prof-${stalePort}-999999`]);
  ok('the leftover browser holds the port', await waitPort(stalePort), `port ${stalePort}`);
  await freePort(stalePort);
  ok('a leftover harness browser is stopped', await waitExit(stale), `pid ${stale.pid}`);
  ok('the debug port is free again', !listening(stalePort), `port ${stalePort}`);
  try { stale.kill('SIGKILL'); } catch { /* gone */ }

  // 3. Ctrl+C in the harness must stop the browser too (the 'exit' hook does not fire).
  const childPort = 9392;
  const child = spawn(process.execPath, [path.join(__dirname, 'cdp-child.js'), 'about:blank', String(childPort)],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LUMEN_TEST_MODEL: '' } });
  ok('the child browser is listening on its debug port', await waitPort(childPort, 15000), `port ${childPort}`);
  child.kill('SIGINT');
  await sleep(2000);
  ok('Ctrl+C stops the browser as well', !listening(childPort), `port ${childPort}`);
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  await freePort(childPort);
}

module.exports = { runHarnessChecks };
