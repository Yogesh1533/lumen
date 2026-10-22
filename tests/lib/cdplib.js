// Tiny CDP harness: launch headless Chrome, evaluate JS, screenshot, upload files.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
// Scratch dir for Chrome profiles, screenshots and fake-server output (override with LUMEN_TEST_TMP).
const T = process.env.LUMEN_TEST_TMP || path.join(os.tmpdir(), 'lumen-tests');
fs.mkdirSync(T, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

// The PID(s) listening on a TCP port (the browser that owns the debug port, nothing else).
// Needs lsof; without it the list is empty and the run just uses the port as it finds it.
function listenerPids(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
  } catch { return []; }
}

// The command line of a process (no shell involved).
function cmdline(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Is this listener one of OUR browsers? Our browsers carry the harness profile dir
// "chrome-prof-<port>". A profile dir that belongs to a still running test run is not
// ours to kill — that would break a second, concurrent run of the suite.
function isHarnessBrowser(pid, port) {
  const cmd = cmdline(pid);
  if (!cmd) return false;
  if (!new RegExp(`chrome-prof-${port}(?!\\d)`).test(cmd)) return false;
  const own = cmd.match(new RegExp(`chrome-prof-${port}-(\\d+)(?!\\d)`));
  if (own && Number(own[1]) !== process.pid && pidAlive(Number(own[1]))) return false; // another live run
  return true;
}

// The Chrome profile dirs of this harness for a port: "chrome-prof-<port>" (old runs)
// and "chrome-prof-<port>-<pid>" (one per run). The dir of a live run is not ours to delete.
function profileDirs(port) {
  let names = [];
  try { names = fs.readdirSync(T); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = n.match(new RegExp(`^chrome-prof-${port}(?:-(\\d+))?$`));
    if (m) out.push({ name: n, pid: m[1] ? Number(m[1]) : null });
  }
  return out;
}
// Remove the profiles of the runs that are gone — a Chrome profile is tens of MB and
// must not pile up in the test temp dir.
function sweepProfiles(port) {
  for (const p of profileDirs(port)) {
    if (p.pid && p.pid !== process.pid && pidAlive(p.pid)) continue; // another live run owns it
    try { fs.rmSync(path.join(T, p.name), { recursive: true, force: true }); } catch { /* gone */ }
  }
}

// Free a debug port before the browser starts on it.
// Only browsers of this harness are stopped (SIGTERM first, SIGKILL after a grace
// period). A process that belongs to somebody else is never killed — if it still
// holds the port the caller gets a clear error instead.
async function freePort(port) {
  const ours = () => listenerPids(port).filter((pid) => isHarnessBrowser(pid, port));
  for (const pid of ours()) {
    console.log(`  stopping the leftover browser on port ${port} (pid ${pid})`);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 25 && ours().length; i++) await sleep(100);
  for (const pid of ours()) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (let i = 0; i < 25 && ours().length; i++) await sleep(100);
  for (let i = 0; i < 25 && listenerPids(port).length; i++) await sleep(100); // wait until the port is free
  sweepProfiles(port);
  return listenerPids(port);
}

async function launch(url, port, { extraArgs = [], width = 1400, height = 800, preScript = '' } = {}) {
  // A browser left over from an earlier run would keep the debug port and its old profile
  // (localStorage!), so the test would drive the stale page instead of the fresh one.
  const left = await freePort(port);
  if (left.length) throw new Error(`Port ${port} is used by another process (pid ${left.join(', ')}) — close it or free the port; the harness does not kill foreign processes.`);
  const profile = `${T}/chrome-prof-${port}-${process.pid}`;
  fs.rmSync(profile, { recursive: true, force: true }); // fresh profile every run
  const chrome = spawn((process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, ...extraArgs, 'about:blank'], { stdio: 'ignore' });
  const killChrome = () => { try { chrome.kill(); } catch { /* already gone */ } };
  const cleanProfile = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* gone */ } };
  chrome.on('exit', cleanProfile); // a finished browser must not leave its profile behind
  process.on('exit', killChrome); // a crashed test must not leave the browser behind
  process.on('SIGINT', () => { killChrome(); process.exit(130); }); // 'exit' does not fire on Ctrl+C
  process.on('SIGTERM', () => { killChrome(); process.exit(143); });
  process.on('SIGHUP', () => { killChrome(); process.exit(129); }); // closing the terminal does the same
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.find((t) => t.type === 'page')) break; } catch {} await sleep(250); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  const ctxs = [];
  ws.onmessage = (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Runtime.executionContextCreated') ctxs.push(j.params.context);
    if (j.method === 'Runtime.executionContextDestroyed') { const k = ctxs.findIndex((c) => c.id === j.params.executionContextId); if (k >= 0) ctxs.splice(k, 1); }
    if (j.method === 'Runtime.executionContextsCleared') ctxs.length = 0;
  };
  const cmd = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr, contextId) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (!r.result) return 'ERR ' + JSON.stringify(r.error);
    if (r.result.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
    return r.result.result.value;
  };
  const h = {
    cmd, ev, sleep, ctxs,
    shot: async (name) => fs.writeFileSync(`${T}/${name}.png`, Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')),
    waitFor: async (expr, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await ev(expr)) return true; await sleep(250); } return false; },
    setFiles: async (selector, files) => {
      const doc = (await cmd('DOM.getDocument')).result.root.nodeId;
      const node = (await cmd('DOM.querySelector', { nodeId: doc, selector })).result.nodeId;
      await cmd('DOM.setFileInputFiles', { nodeId: node, files });
    },
    // Wait for a turn to end. The model may ask to use a skill (the starter skills are
    // in the system prompt): the approval card is answered like a user would answer it
    // (Allow once), and the turn goes on. Returns true when the app is idle again.
    finishTurn: async (ms = 180000) => {
      const end = Date.now() + ms;
      let idle = 0;
      while (Date.now() < end) {
        if (await ev(`!!document.querySelector('.toolcall.awaiting')`)) {
          idle = 0;
          await ev(`document.querySelector('.toolcall.awaiting [data-tc=once]').click(); 1`);
          await sleep(600);
          continue;
        }
        if (await ev(`!state.streaming && !state.toolsBusy`)) { if (++idle >= 4) return true; } else idle = 0;
        await sleep(250);
      }
      return false;
    },
    // send a message through the app and wait for the reply to finish.
    // The reply of the assistant is waited for: the message of the user is never the
    // answer, and a message that only holds a tool call is not the answer either.
    ask: async (q, ms = 180000) => {
      const before = await ev('state.chat.messages.length');
      await ev(`send(${JSON.stringify(q)}); 1`);
      await sleep(600);
      await h.finishTurn(ms);
      await h.waitFor(`state.chat.messages.length > ${before} && (state.chat.messages.at(-1) || {}).role === 'assistant' && !!((state.chat.messages.at(-1) || {}).content || '').trim()`, ms);
      await sleep(500);
      return ev('state.chat.messages.at(-1).content');
    },
    // real keyboard event with modifiers (ctrl=2, meta=4, shift=8)
    key: async (key, code, vk, modifiers = 0) => {
      for (const type of ['rawKeyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    },
    ok: (label, cond, extra = '') => { if (!cond) failures++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== '' ? '  -> ' + extra : '')); },
    close: () => { chrome.kill(); ws.close(); console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED'); process.exit(failures ? 1 : 0); },
  };
  await cmd('Runtime.enable'); await cmd('Page.enable');
  if (preScript) await cmd('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
  await cmd('Page.navigate', { url });
  await sleep(1500);
  // Pin the model for the whole run (e.g. LUMEN_TEST_MODEL=gemma4:latest keeps test prompts off cloud models).
  // Without it the tests use the first model Lumen lists, which may be a cloud model.
  if (process.env.LUMEN_TEST_MODEL) {
    await ev(`(() => { const s = document.querySelector('#modelSelect'); s.value = ${JSON.stringify(process.env.LUMEN_TEST_MODEL)}; s.dispatchEvent(new Event('change')); })(); 1`);
    if ((await ev(`document.querySelector('#modelSelect').value`)) !== process.env.LUMEN_TEST_MODEL) throw new Error('LUMEN_TEST_MODEL is not installed: ' + process.env.LUMEN_TEST_MODEL);
  }
  return h;
}
module.exports = { launch, sleep, T, freePort, listenerPids, profileDirs, sweepProfiles };
