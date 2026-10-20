#!/usr/bin/env node
// Opens Lumen in its own app window (no tabs or address bar) using Chrome, Edge, Brave or Chromium.
// Starts the server if it is not already running, and stops it again when the window is closed.
//   node bin/lumen-app.js            launch
//   node bin/lumen-app.js --print    show what would run, without launching
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3100;
const URL_ = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

function candidates() {
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    return roots.flatMap((r) => ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'].map((x) => path.join(r, x)));
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].flatMap((b) => dirs.map((d) => path.join(d, b)));
}
const browser = candidates().find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
// A dedicated profile keeps the app window separate from your normal browsing (and lets us know when it closes).
const profile = path.join(os.homedir(), '.lumen', 'app-profile');
const args = [`--app=${URL_}`, `--user-data-dir=${profile}`, '--window-size=1280,860', '--no-first-run', '--no-default-browser-check'];

if (process.argv.includes('--print')) {
  console.log(JSON.stringify({ url: URL_, browser: browser || null, args }, null, 2));
  process.exit(browser ? 0 : 1);
}
if (!browser) {
  console.error(`No Chromium-based browser found. Open ${URL_} in any browser, then use "Install app" from its menu.`);
  process.exit(1);
}

const up = () => fetch(`${URL_}/api/config`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
(async () => {
  let server = null;
  if (!(await up())) {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: 'inherit', env: process.env });
    for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await up())) { console.error('Lumen did not start.'); server.kill(); process.exit(1); }
  } else console.log(`Using the Lumen server already running at ${URL_}`);
  fs.mkdirSync(profile, { recursive: true });
  const win = spawn(browser, args, { stdio: 'ignore' });
  const stop = () => { if (server) server.kill('SIGTERM'); };
  win.on('exit', () => { stop(); process.exit(0); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { win.kill(); stop(); process.exit(0); });
})();
