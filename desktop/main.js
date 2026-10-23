// Lumen as a desktop app (Electron). The server runs in this process (or an already
// running Lumen server is used), and the window shows the same web app as a browser
// would — with context isolation, the sandbox, no Node.js in the page and a minimal
// preload. The window never leaves the local origin.
//
//   npm run desktop                  start (development)
//   LUMEN_DESKTOP_TEST=1             test mode: test hooks on, and nothing outside the
//                                    app is touched (no browser, no login item, no
//                                    global shortcuts, no protocol registration)
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, nativeImage, Notification, session, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST = process.env.LUMEN_DESKTOP_TEST === '1';
const PORT = Number(process.env.PORT || 3100);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const QUICK_FILE = path.join(__dirname, 'quick.html');
const SHORTCUTS = { quick: 'Alt+CommandOrControl+L', dictate: 'Alt+CommandOrControl+D' };
const MAX_OPEN_BYTES = 20 * 1024 * 1024;

app.setName('Lumen');
// A profile of its own for the tests (and the single-instance lock is per profile).
if (process.env.LUMEN_DESKTOP_PROFILE) app.setPath('userData', process.env.LUMEN_DESKTOP_PROFILE);
// A packaged app cannot write next to its code: its data goes into the profile.
if (app.isPackaged && !process.env.LUMEN_DATA) process.env.LUMEN_DATA = path.join(app.getPath('userData'), 'data', 'chats.json');

// ---- one instance --------------------------------------------------------------
// A second start hands its arguments (a deep link, files to open) to the first one and
// quits.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, quick = null, tray = null, quitting = false;
const pending = { files: [], links: [] };   // what arrived before the window was ready
const testLog = { notifications: [], external: [], secondInstances: 0, loginItem: null };

// ---- preferences -------------------------------------------------------------------
const PREFS_FILE = path.join(app.getPath('userData'), 'desktop.json');
let prefs = { background: false, openAtLogin: false };
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }; } catch { /* first run */ }
function savePrefs() {
  try { fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true }); fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch { /* read-only */ }
}
function setPrefs(p) {
  if (typeof p.background === 'boolean') prefs.background = p.background;
  if (typeof p.openAtLogin === 'boolean') {
    prefs.openAtLogin = p.openAtLogin;
    if (TEST) testLog.loginItem = p.openAtLogin;
    else app.setLoginItemSettings({ openAtLogin: p.openAtLogin });
  }
  savePrefs();
  buildTray();
  return prefs;
}

// ---- the server ----------------------------------------------------------------------
const lumenUp = () => fetch(ORIGIN + '/api/config', { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok ? r.json() : null).then((j) => !!(j && j.name === 'Lumen'), () => false);
async function startServer() {
  // A Lumen that already runs on the port is used as it is: two servers must not write
  // the same data folder.
  if (await lumenUp()) return 'reused';
  process.env.PORT = String(PORT);
  require(path.join(ROOT, 'server.js'));
  for (let i = 0; i < 80; i++) { if (await lumenUp()) return 'started'; await new Promise((r) => setTimeout(r, 125)); }
  throw new Error('The Lumen server did not start on port ' + PORT);
}

// ---- the origin lock -------------------------------------------------------------------
const sameOrigin = (u) => { try { return new URL(u).origin === ORIGIN; } catch { return false; } };
const isQuick = (u) => { try { return new URL(u).protocol === 'file:' && path.resolve(decodeURIComponent(new URL(u).pathname)) === QUICK_FILE; } catch { return false; } };
// A link that leaves the app opens in the browser of the user — only http(s).
function openOutside(u) {
  let url;
  try { url = new URL(u); } catch { return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (TEST) { testLog.external.push(url.href); return; }
  shell.openExternal(url.href);
}
app.on('web-contents-created', (_e, wc) => {
  // The main window stays on the app's origin; only the Quick Entry window may show its
  // own file.
  const allowedNav = (u) => (quick && wc === quick.webContents) ? isQuick(u) : sameOrigin(u);
  const guardNav = (e, u) => { if (!allowedNav(u)) { e.preventDefault(); openOutside(u); } };
  wc.on('will-navigate', guardNav);
  wc.on('will-redirect', guardNav);
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

// ---- the windows -----------------------------------------------------------------------
const webPreferences = (preload, extra = {}) => ({
  preload: path.join(__dirname, preload), contextIsolation: true, sandbox: true, nodeIntegration: false,
  nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false, spellcheck: true,
  additionalArguments: TEST ? ['--lumen-test'] : [], ...extra,
});
function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 860, minWidth: 520, minHeight: 420, show: false, title: 'Lumen',
    backgroundColor: '#1b1b1f', webPreferences: webPreferences('preload.js') });
  win.loadURL(ORIGIN + '/');
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  // Close to the tray when "keep running" is on; otherwise closing the window quits.
  win.on('close', (e) => {
    if (quitting) return;
    if (prefs.background) { e.preventDefault(); win.hide(); return; }
    quitting = true;
  });
  win.on('closed', () => { win = null; if (!prefs.background) app.quit(); });
  win.webContents.on('did-finish-load', flushPending);
}
function showMain() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function send(channel, payload) {
  if (!win || win.webContents.isLoading()) return false;
  win.webContents.send('desktop:' + channel, payload);
  return true;
}

// Quick Entry: a small window on top of everything; Enter sends the text to a new chat
// in the main window, Esc (or leaving it) hides it.
function openQuick() {
  if (!quick) {
    quick = new BrowserWindow({ width: 640, height: 76, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
      show: false, transparent: false, backgroundColor: '#1b1b1f', title: 'Lumen Quick Entry', webPreferences: webPreferences('quick-preload.js') });
    quick.loadFile(QUICK_FILE);
    quick.on('blur', () => { if (quick && !TEST) quick.hide(); });
    quick.on('closed', () => { quick = null; });
  }
  quick.center();
  quick.show(); quick.focus();
  quick.webContents.send('quick:reset');
}

// ---- files, deep links -----------------------------------------------------------------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html' };
function readOpenFiles(paths) {
  const out = [];
  for (const p of paths.slice(0, 20)) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > MAX_OPEN_BYTES) { out.push({ name: path.basename(p), error: 'larger than 20 MB' }); continue; }
      out.push({ name: path.basename(p), type: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', data: fs.readFileSync(p).toString('base64') });
    } catch { /* gone */ }
  }
  return out;
}
function openFiles(paths) {
  if (!paths.length) return;
  showMain();
  if (!send('open-files', readOpenFiles(paths))) pending.files.push(...paths);
}
// lumen://new?text=…  puts the text into the message box (it is never sent by itself: a
//                     link of a web page must not talk to the model in your name)
// lumen://chat/<id>   opens that chat
function parseLink(s) {
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'lumen:') return null;
  const host = u.hostname, rest = u.pathname.replace(/^\/+/, '');
  if (host === 'new') return { kind: 'new', text: String(u.searchParams.get('text') || '').slice(0, 4000) };
  if (host === 'chat' && /^[0-9a-f-]{36}$/i.test(rest)) return { kind: 'chat', id: rest };
  return null;
}
function openLink(s) {
  const l = parseLink(s);
  if (!l) return;
  showMain();
  if (!send('deep-link', l)) pending.links.push(s);
}
function flushPending() {
  const f = pending.files.splice(0), l = pending.links.splice(0);
  if (f.length) send('open-files', readOpenFiles(f));
  for (const s of l) { const x = parseLink(s); if (x) send('deep-link', x); }
}
const argFiles = (argv) => argv.slice(1).filter((a) => !a.startsWith('-') && !a.startsWith('lumen:') && path.isAbsolute(a) && a !== __filename && !a.endsWith('main.js') && fs.existsSync(a));
const argLinks = (argv) => argv.filter((a) => a.startsWith('lumen://'));

app.on('second-instance', (_e, argv) => {
  testLog.secondInstances++;
  showMain();
  argLinks(argv).forEach(openLink);
  openFiles(argFiles(argv));
});
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady() && win) openFiles([p]); else pending.files.push(p); });
app.on('open-url', (e, u) => { e.preventDefault(); if (app.isReady() && win) openLink(u); else pending.links.push(u); });

// ---- the menu and the tray --------------------------------------------------------------
const menuCmd = (cmd) => () => { showMain(); send('menu', cmd); };
function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Chat', accelerator: 'CommandOrControl+N', click: menuCmd('new-chat') },
      { label: 'Quick Entry', accelerator: SHORTCUTS.quick, registerAccelerator: false, click: () => openQuick() },
      { label: 'Open File…', accelerator: 'CommandOrControl+O', click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
        if (!r.canceled) openFiles(r.filePaths);
      } },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: menuCmd('settings') },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Find in Conversation', accelerator: 'CommandOrControl+F', click: menuCmd('find') },
      { label: 'Side Chat', accelerator: 'Alt+CommandOrControl+S', click: menuCmd('side-chat') },
      { label: 'Split View', accelerator: 'Alt+CommandOrControl+P', click: menuCmd('split') },
      { label: 'Dictate', accelerator: SHORTCUTS.dictate, registerAccelerator: false, click: menuCmd('dictate') },
      { type: 'separator' },
      { role: 'reload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Troubleshooting', click: menuCmd('troubleshooting') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function buildTray() {
  if (!app.isReady()) return;
  if (!tray) {
    const img = nativeImage.createFromPath(path.join(ROOT, 'public', 'icon-192.png')).resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip('Lumen');
    tray.on('click', () => showMain());
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Lumen', click: () => showMain() },
    { label: 'Quick Entry', accelerator: SHORTCUTS.quick, registerAccelerator: false, click: () => openQuick() },
    { type: 'separator' },
    { label: 'Keep running when the window is closed', type: 'checkbox', checked: prefs.background, click: (i) => setPrefs({ background: i.checked }) },
    { label: 'Open at login', type: 'checkbox', checked: prefs.openAtLogin, click: (i) => setPrefs({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: 'Quit Lumen', click: () => { quitting = true; app.quit(); } },
  ]));
}
const shortcutState = {};
function registerShortcuts() {
  if (TEST) return;   // the tests must not take shortcuts away from the user's other apps
  shortcutState.quick = globalShortcut.register(SHORTCUTS.quick, () => openQuick());
  // Electron has no global key-up, so dictation is a toggle: press to start, press to stop.
  shortcutState.dictate = globalShortcut.register(SHORTCUTS.dictate, () => { showMain(); send('menu', 'dictate'); });
  for (const [k, okk] of Object.entries(shortcutState)) if (!okk) console.warn(`Lumen: the shortcut ${SHORTCUTS[k]} is used by another app`);
}

// ---- IPC ------------------------------------------------------------------------------------
// Only the main frame of the main window (on the app's origin) may talk to the main
// process — never an iframe (the split panes, the artifact previews) and never a page
// that is not the app.
const fromMain = (e) => !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame && sameOrigin(e.senderFrame.url);
const fromQuick = (e) => !!quick && e.sender === quick.webContents && isQuick(e.senderFrame.url);
let lastNote = 0;
ipcMain.on('desktop:notify', (e, n) => {
  if (!fromMain(e) || !n || typeof n !== 'object') return;
  if (Date.now() - lastNote < 1500) return;   // at most one every 1.5 s
  lastNote = Date.now();
  const note = { title: String(n.title || 'Lumen').slice(0, 80), body: String(n.body || '').slice(0, 240) };
  if (TEST) { testLog.notifications.push(note); return; }
  if (!Notification.isSupported()) return;
  const x = new Notification(note);
  x.on('click', () => showMain());
  x.show();
});
ipcMain.handle('desktop:prefs', (e, p) => {
  if (!fromMain(e)) throw new Error('not allowed');
  return p && typeof p === 'object' ? setPrefs(p) : prefs;
});
ipcMain.handle('desktop:info', (e) => {
  if (!fromMain(e)) throw new Error('not allowed');
  return { version: app.getVersion(), electron: process.versions.electron, platform: process.platform, shortcuts: SHORTCUTS, shortcutState };
});
ipcMain.on('quick:submit', (e, text) => {
  if (!fromQuick(e) || typeof text !== 'string') return;
  const t = text.trim().slice(0, 20000);
  if (quick) quick.hide();
  if (!t) return;
  showMain();
  send('quick-entry', t);
});
ipcMain.on('quick:close', (e) => { if (fromQuick(e) && quick) quick.hide(); });

// The test hooks. They only exist in the test mode.
if (TEST) {
  ipcMain.handle('desktop:test', async (e, op, arg) => {
    if (!fromMain(e)) throw new Error('not allowed');
    switch (op) {
      case 'openQuick': openQuick(); return true;
      case 'openFiles': openFiles(Array.isArray(arg) ? arg.map(String) : []); return true;
      case 'deepLink': openLink(String(arg)); return true;
      case 'state': return {
        ...testLog, prefs, quickVisible: !!(quick && quick.isVisible()), winVisible: !!(win && win.isVisible()),
        menu: (Menu.getApplicationMenu() || { items: [] }).items.map((i) => ({ label: i.label, items: (i.submenu ? i.submenu.items : []).map((s) => s.label).filter(Boolean) })),
        tray: !!tray, webPreferences: win ? (({ contextIsolation, sandbox, nodeIntegration }) => ({ contextIsolation, sandbox, nodeIntegration }))(win.webContents.getLastWebPreferences()) : null,
      };
      case 'closeWindow': if (win) win.close(); return true;
      case 'showWindow': showMain(); return true;
      case 'quit': setTimeout(() => { quitting = true; app.quit(); }, 50); return true;
    }
    return null;
  });
}

// ---- start -----------------------------------------------------------------------------------
app.whenReady().then(async () => {
  try { await startServer(); }
  catch (e) { dialog.showErrorBox('Lumen', String(e.message || e)); app.exit(1); return; }
  // The app asks for the microphone (dictation), notifications and the clipboard — and
  // only for its own origin.
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => cb(allowed.has(perm) && sameOrigin(details.requestingUrl || '')));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => allowed.has(perm) && sameOrigin(origin || ''));
  if (!TEST && (app.isPackaged || process.env.LUMEN_DESKTOP_REGISTER === '1')) {
    if (app.isPackaged) app.setAsDefaultProtocolClient('lumen');
    else app.setAsDefaultProtocolClient('lumen', process.execPath, [path.resolve(process.argv[1])]);
  }
  buildMenu();
  createWindow();
  buildTray();
  registerShortcuts();
  pending.files.push(...argFiles(process.argv));
  pending.links.push(...argLinks(process.argv));
});
app.on('activate', () => showMain());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!prefs.background) app.quit(); });
