// Step 13 — the page side of the desktop app (Electron). It does nothing in a browser:
// it only acts when the preload of the desktop app gave the page `window.lumenDesktop`.
//
// Quick Entry sends its text to a new chat, a file opened with Lumen (or dropped on its
// icon) is attached, a lumen:// link opens a chat or puts text into the message box (it
// never sends it), the menu runs the commands of the app, and a notification is shown
// when a reply is finished or a tool call waits while the window is not in front.

const desk = window.lumenDesktop;
if (desk && !isEmbed) {
  const whenIdle = async () => {
    await state.ready;
    for (let i = 0; i < 600 && (state.streaming || state.toolsBusy); i++) await new Promise((r) => setTimeout(r, 100));
  };

  desk.on('quick-entry', async (text) => {
    await whenIdle();
    newChat();
    send(String(text || ''));
  });

  desk.on('open-files', async (list) => {
    await state.ready;
    const files = [];
    for (const f of list || []) {
      if (f.error) { toast(`${f.name}: ${f.error}`); continue; }
      const bin = atob(f.data || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      files.push(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
    }
    if (files.length) { await addFiles(files); toast(files.length === 1 ? `Attached ${files[0].name}` : `Attached ${files.length} files`); }
  });

  desk.on('deep-link', async (l) => {
    await state.ready;
    if (!l) return;
    if (l.kind === 'chat') { try { await openChat(l.id); } catch (e) { toast('That chat does not exist'); } return; }
    if (l.kind === 'new') {
      await whenIdle();
      newChat();
      const box = $('#input');
      box.value = String(l.text || '');
      box.dispatchEvent(new Event('input'));
      box.focus();
      // A link can come from any web page: the text waits for you to read it and send it.
      if (l.text) toast('Text from a lumen:// link — read it before you send it');
    }
  });

  const MENU = {
    'new-chat': () => newChat(),
    find: () => $('#findBtn') && $('#findBtn').click(),
    'side-chat': () => $('#sideChatBtn') && $('#sideChatBtn').click(),
    split: () => $('#splitBtn') && $('#splitBtn').click(),
    settings: () => $('#settingsBtn').click(),
    troubleshooting: () => $('#troubleBtn') && $('#troubleBtn').click(),
    dictate: () => { const m = $('#micBtn'); if (m && !m.hidden) m.click(); else toast('Dictation is not available here'); },
  };
  desk.on('menu', (cmd) => { const f = MENU[cmd]; if (f) f(); });

  // Notifications while the window is not in front. (A hidden window is covered by the
  // workspace feature, which sends its notifications through the desktop app as well.)
  const away = () => !document.hasFocus() && !document.hidden;
  const prevReply = hooks.onReply;
  hooks.onReply = (reply, c) => {
    if (prevReply) prevReply(reply, c);
    if ((away() || document.hidden) && reply && !reply.error && (reply.content || '').trim()) desk.notify('Lumen: reply finished', (c && c.title) || 'New chat');
  };
  const prevAwait = hooks.onAwait;
  hooks.onAwait = (call, c, waiting) => {
    if (prevAwait) prevAwait(call, c, waiting);
    if (waiting && away()) desk.notify('Lumen needs your input', `${call.serverName} › ${call.tool} is waiting for your approval`);
  };

  // The settings of the desktop app, in the Settings dialog.
  const actions = $('#settingsDlg .dlg-actions');
  if (actions) {
    const box = document.createElement('div');
    box.id = 'deskPrefs';
    box.innerHTML = `<h3>Desktop app</h3>
      <label class="check"><input type="checkbox" id="deskBg"> Keep running in the background when the window is closed (Lumen stays in the menu bar / tray)</label>
      <label class="check"><input type="checkbox" id="deskLogin"> Open Lumen when I log in</label>
      <p class="sub" id="deskKeys"></p>`;
    actions.before(box);
    const fill = async () => {
      try {
        const p = await desk.prefs();
        $('#deskBg').checked = !!p.background; $('#deskLogin').checked = !!p.openAtLogin;
        const info = await desk.info();
        const k = info.shortcuts || {};
        $('#deskKeys').textContent = `Quick Entry: ${k.quick} · Dictation (press to start, press again to stop): ${k.dictate}` +
          (info.shortcutState && (info.shortcutState.quick === false || info.shortcutState.dictate === false) ? ' — a shortcut is taken by another app' : '');
      } catch (e) { /* the bridge said no */ }
    };
    $('#deskBg').onchange = (e) => desk.prefs({ background: e.target.checked }).then(fill);
    $('#deskLogin').onchange = (e) => desk.prefs({ openAtLogin: e.target.checked }).then(fill);
    $('#settingsBtn').addEventListener('click', fill);
    fill();
  }
  document.documentElement.classList.add('desktop');
}
