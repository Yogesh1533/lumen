// Tiny CDP harness: launch headless Chrome, evaluate JS, screenshot, upload files.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
// Scratch dir for Chrome profiles, screenshots and fake-server output (override with LUMEN_TEST_TMP).
const T = process.env.LUMEN_TEST_TMP || path.join(os.tmpdir(), 'lumen-tests');
fs.mkdirSync(T, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function launch(url, port, { extraArgs = [], width = 1400, height = 800, preScript = '' } = {}) {
  fs.rmSync(`${T}/chrome-prof-${port}`, { recursive: true, force: true }); // fresh profile every run
  const chrome = spawn((process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${T}/chrome-prof-${port}`, `--window-size=${width},${height}`, ...extraArgs, 'about:blank'], { stdio: 'ignore' });
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
    // send a message through the app and wait for the reply to finish
    ask: async (q, ms = 180000) => {
      const before = await ev('state.chat.messages.length');
      await ev(`send(${JSON.stringify(q)}); 1`);
      await sleep(600);
      await h.waitFor(`!state.streaming && state.chat.messages.length >= ${before + 2}`, ms);
      await sleep(800);
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
module.exports = { launch, sleep, T };
