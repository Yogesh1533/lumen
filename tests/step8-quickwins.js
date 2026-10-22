// Step 8 — quick wins: usage stats, read aloud, find, export, chat tabs, retry/compare, troubleshooting.
const { launch, sleep } = require('./lib/cdplib');
const { runHarnessChecks } = require('./lib/harness-checks');

// A fake speechSynthesis so "read aloud" can be tested without a real voice.
const FAKE_SPEECH = `
  window.__spoken = []; window.__cancelled = 0;
  class FakeUtterance { constructor(text) { this.text = text; } }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true, writable: true });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    speak(u) { window.__spoken.push(u.text); },
    cancel() { window.__cancelled++; },
    getVoices() { return [{ name: 'Test Voice', lang: 'en-US' }]; },
  } });
`;

(async () => {
  const h = await launch('http://localhost:3101', 9345, { preScript: FAKE_SPEECH });
  const { ev, ok, waitFor, shot } = h;
  // The harness itself: freeing a debug port must not kill processes that are not ours.
  await runHarnessChecks(ok);
  await ev(`document.querySelector('#thinkToggle').click(); 1`); // thinking off: faster
  const model = await ev(`document.querySelector('#modelSelect').value`);

  // ---- usage stats ------------------------------------------------------------------
  await ev(`newChat(); 1`);
  await ev(`send('Reply with exactly the word: banana'); 1`);
  ok('reply arrives', await waitFor(`!state.streaming && state.chat.messages.length === 2 && state.chat.messages[1].content.length > 0`, 120000));
  const stats = JSON.parse(await ev(`JSON.stringify(state.chat.messages[1].stats || null)`));
  ok('the assistant message carries the final chunk stats', !!stats && stats.eval_count > 0 && stats.prompt_eval_count > 0, JSON.stringify(stats));
  ok('the message records which model answered', (await ev(`state.chat.messages[1].model`)) === model, await ev(`state.chat.messages[1].model`));
  const chatId = await ev(`state.chat.id`);
  const stored = JSON.parse(await ev(`fetch('/api/chats/${chatId}').then(r => r.json()).then(c => JSON.stringify(c.messages[1].stats || null))`));
  ok('the stats are persisted on the message', !!stored && !!stats && stored.eval_count === stats.eval_count, JSON.stringify(stored));
  const usage = JSON.parse(await ev(`fetch('/api/usage').then(r => r.json()).then(u => JSON.stringify(u))`));
  const byModel = (usage.byModel || []).find((x) => x.model === model);
  ok('GET /api/usage aggregates by model', !!byModel && byModel.evalTokens >= (stats ? stats.eval_count : 0), JSON.stringify(usage.byModel));
  ok('GET /api/usage aggregates by day', (usage.byDay || []).length >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(usage.byDay[0].day), JSON.stringify(usage.byDay));
  ok('GET /api/usage reports the totals', usage.totals && usage.totals.evalTokens >= (stats ? stats.eval_count : 0), JSON.stringify(usage.totals));
  ok('the status line shows the speed', /tok\/s/.test(await ev(`document.querySelector('#status').textContent`)), await ev(`document.querySelector('#status').textContent`));
  await ev(`document.querySelector('#usageBtn').click(); 1`); await sleep(600);
  ok('the usage dialog opens', await waitFor(`!!document.querySelector('#usageDlg') && document.querySelector('#usageDlg').open`, 3000));
  ok('the usage dialog lists the model', new RegExp(model).test(await ev(`document.querySelector('#usageDlg')?.textContent || ''`)), await ev(`document.querySelector('#usageDlg')?.textContent || ''`));
  await ev(`document.querySelector('#usageClose')?.click(); 1`);

  // ---- read aloud ------------------------------------------------------------------
  await ev(`newChat(); 1`);
  await ev(`state.chat.messages.push({ role: 'assistant', content: '**Bold** and \`code\` and [link](https://example.test)' }); renderAll(); 1`);
  await ev(`document.querySelector('#messages .msg.assistant [data-act=speak]').click(); 1`);
  ok('the reply is spoken with the markdown stripped', (await ev(`JSON.stringify(window.__spoken)`)) === '["Bold and code and link"]', await ev(`JSON.stringify(window.__spoken)`));
  ok('the button turns into a stop control while speaking', (await ev(`document.querySelector('#messages .msg.assistant [data-act=speak]').textContent`)) === 'Stop');
  await ev(`document.querySelector('#messages .msg.assistant [data-act=speak]').click(); 1`);
  ok('clicking again stops the reading', (await ev(`window.__cancelled`)) === 1 && (await ev(`document.querySelector('#messages .msg.assistant [data-act=speak]').textContent`)) === 'Read aloud');
  await ev(`document.querySelector('#controlsBtn').click(); 1`); await sleep(200);
  ok('the voice picker lists the system voices', (await ev(`document.querySelector('#voiceSel').options.length`)) === 2 && (await ev(`document.querySelector('#voiceSel').options[1].textContent`)) === 'Test Voice');
  await ev(`(() => { const s = document.querySelector('#voiceSel'); s.value = 'Test Voice'; s.dispatchEvent(new Event('change')); })(); 1`);
  ok('the chosen voice is remembered', (await ev(`pref('voice')`)) === 'Test Voice');
  await ev(`document.querySelector('#autoRead').click(); 1`);
  ok('auto-read can be switched on', (await ev(`pref('autoRead')`)) === '1');
  await ev(`newChat(); send('Reply with exactly the word: papaya'); 1`);
  ok('the reply arrives', await waitFor(`!state.streaming && state.chat.messages.length === 2 && state.chat.messages[1].content.length > 0`, 120000));
  ok('the reply is read aloud automatically', await waitFor(`window.__spoken.length >= 2`, 5000), await ev(`JSON.stringify(window.__spoken)`));

  // ---- find in conversation --------------------------------------------------------
  const mac = await ev('isMac');
  const MOD = mac ? 4 : 2;
  await ev(`newChat(); 1`);
  await ev(`state.chat.messages.push({ role: 'user', content: 'zebra and zebra' }, { role: 'assistant', content: 'zebra' }); renderAll(); 1`);
  await ev(`document.querySelector('#findBtn').click(); 1`);
  ok('the find bar opens', await ev(`!!document.querySelector('#findBar') && !document.querySelector('#findBar').hidden`));
  await ev(`(() => { const i = document.querySelector('#findInput'); i.value = 'zebra'; i.dispatchEvent(new Event('input')); })(); 1`);
  ok('the matches are counted', (await ev(`document.querySelector('#findCount').textContent`)) === '1/3', await ev(`document.querySelector('#findCount').textContent`));
  ok('the matches are highlighted', (await ev(`document.querySelectorAll('#messages mark.find-hit').length`)) === 3);
  await ev(`document.querySelector('#findNext').click(); 1`);
  ok('next moves to the next match', (await ev(`document.querySelector('#findCount').textContent`)) === '2/3');
  await ev(`document.querySelector('#findPrev').click(); 1`);
  ok('previous moves back to the first match', (await ev(`document.querySelector('#findCount').textContent`)) === '1/3');
  await ev(`document.querySelector('#findClose').click(); 1`);
  ok('the find bar closes', await ev(`!!document.querySelector('#findBar') && document.querySelector('#findBar').hidden`));
  ok('the highlights are removed', (await ev(`document.querySelectorAll('#messages mark.find-hit').length`)) === 0);
  await h.key('f', 'KeyF', 70, MOD); await sleep(300);
  ok('Cmd/Ctrl+F opens the find bar', await ev(`!!document.querySelector('#findBar') && !document.querySelector('#findBar').hidden`));
  await h.key('Escape', 'Escape', 27); await sleep(300);
  ok('Esc closes the find bar', await ev(`!!document.querySelector('#findBar') && document.querySelector('#findBar').hidden`));

  // ---- export ------------------------------------------------------------------------
  await ev(`newChat(); 1`);
  await ev(`state.chat.title = 'Export Test'; state.chat.messages.push({ role: 'user', content: 'Hello **export**' }, { role: 'assistant', content: 'Exported reply', thinking: 'secret thoughts', model: 'gemma4:latest', toolCalls: [{ id: 'c1', name: 'fetch', serverName: 'Web', tool: 'fetch_page', arguments: { url: 'https://example.test' }, status: 'done' }] }); renderAll(); 1`);
  await ev(`document.querySelector('#exportChatBtn').click(); 1`);
  ok('the export dialog opens', await ev(`!!document.querySelector('#exportDlg') && document.querySelector('#exportDlg').open`));
  const md = await ev(`document.querySelector('#expPreview')?.textContent || ''`);
  ok('the exported markdown contains the conversation', /Hello \*\*export\*\*/.test(md) && /Exported reply/.test(md), md.slice(0, 120).replace(/\n/g, ' '));
  ok('thinking and tool calls are left out by default', !/secret thoughts/.test(md) && !/fetch_page/.test(md));
  await ev(`document.querySelector('#expThinking').click(); document.querySelector('#expTools').click(); 1`);
  const md2 = await ev(`document.querySelector('#expPreview')?.textContent || ''`);
  ok('thinking and tool calls can be included', /secret thoughts/.test(md2) && /fetch_page/.test(md2), md2.slice(0, 200).replace(/\n/g, ' '));
  ok('the download button is there', await ev(`!!document.querySelector('#expDownload')`));
  const dl = await ev(`(() => { document.querySelector('#expDownload').click(); return 1; })()`);
  ok('downloading does not throw', !String(dl).startsWith('EXC'), String(dl));
  await h.cmd('Browser.grantPermissions', { origin: 'http://localhost:3101', permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const cp = await ev(`(() => { document.querySelector('#expCopy').click(); return 1; })()`);
  ok('copying as markdown does not throw', !String(cp).startsWith('EXC'), String(cp));
  await sleep(400);
  const clip = await ev(`navigator.clipboard.readText().then(t => t).catch(e => 'ERR ' + e.name)`);
  ok('the clipboard holds the markdown', typeof clip === 'string' && /Exported reply/.test(clip), String(clip).slice(0, 120));
  ok('a print stylesheet exists', await ev(`[...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => (r.conditionText || '').includes('print')); } catch { return false; } })`));
  await ev(`document.querySelector('#expClose').click(); 1`);

  // ---- chat tabs ---------------------------------------------------------------------
  const mkChat = (title) => ev(`fetch('/api/chats', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ title: ${JSON.stringify(title)} }) }).then(r => r.json()).then(c => c.id)`);
  const idA = await mkChat('Tab Alpha');
  const idB = await mkChat('Tab Beta');
  await ev(`openChat(${JSON.stringify(idA)}); 1`); await sleep(700);
  ok('opening a chat opens a tab', (await ev(`chatTabs.list.length`)) === 1 && (await ev(`chatTabs.list[0].id`)) === idA, await ev(`JSON.stringify(chatTabs.list)`));
  await ev(`openChat(${JSON.stringify(idB)}); 1`); await sleep(700);
  ok('a second chat adds a second tab', (await ev(`chatTabs.list.length`)) === 2, await ev(`JSON.stringify(chatTabs.list)`));
  ok('the tab strip shows the open chats', (await ev(`document.querySelectorAll('#tabStrip .tab').length`)) === 2);
  ok('each tab shows the title of its own chat', (await ev(`chatTabs.list.map(t => t.title).join('|')`)) === 'Tab Alpha|Tab Beta', await ev(`chatTabs.list.map(t => t.title).join('|')`));
  await ev(`document.querySelectorAll('#tabStrip .tab')[0].click(); 1`); await sleep(700);
  ok('clicking a tab switches to that chat', (await ev(`state.chat.id`)) === idA);
  await ev(`document.querySelectorAll('#tabStrip .tab')[1].querySelector('button').click(); 1`); await sleep(700);
  ok('closing a tab removes it', (await ev(`chatTabs.list.length`)) === 1, await ev(`JSON.stringify(chatTabs.list)`));
  await h.key('T', 'KeyT', 84, MOD | 8); await sleep(900);
  ok('the closed tab can be reopened', (await ev(`chatTabs.list.length`)) === 2 && (await ev(`chatTabs.list.some(t => t.id === ${JSON.stringify(idB)})`)), await ev(`JSON.stringify(chatTabs.list)`));
  const active1 = await ev(`chatTabs.active`);
  await ev(`document.querySelector('#tabNext').click(); 1`); await sleep(700);
  const active2 = await ev(`chatTabs.active`);
  await ev(`document.querySelector('#tabPrev').click(); 1`); await sleep(700);
  ok('next and previous move through the tabs', active1 !== active2 && active1 === (await ev(`chatTabs.active`)), `${active1} ${active2} ${await ev(`chatTabs.active`)}`);
  ok('the open tabs are remembered', (await ev(`JSON.parse(localStorage.getItem('lumen.tabs')).list.length`)) === 2);
  await ev(`document.querySelector('#controlsBtn').click(); document.querySelector('#contLast').click(); 1`);
  ok('"continue last chat" can be switched on', (await ev(`pref('contLast')`)) === '1');
  await h.cmd('Page.reload');
  ok('the app comes back with the tabs restored', await waitFor(`typeof chatTabs !== 'undefined' && chatTabs.list.length === 2`, 15000), await ev(`typeof chatTabs !== 'undefined' ? JSON.stringify(chatTabs.list) : 'no chatTabs'`));
  ok('"continue last chat" opens the most recent chat', await waitFor(`state.chat && state.chat.id === ${JSON.stringify(idB)}`, 15000), await ev(`state.chat ? state.chat.id : null`));

  // ---- "continue last chat" must not follow the pinned chats --------------------------
  const pinnedId = await mkChat('Pinned Chat');
  const recentId = await mkChat('Recent Chat');
  await ev(`fetch('/api/chats/${pinnedId}', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ pinned: true }) }).then(r => r.json()).then(c => c.id)`);
  await sleep(40);
  await ev(`fetch('/api/chats/${recentId}', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ title: 'Recent Chat' }) }).then(r => r.json()).then(c => c.id)`);
  const chatList = JSON.parse(await ev(`fetch('/api/chats').then(r => r.json()).then(l => JSON.stringify(l))`));
  ok('a pinned chat is sorted to the top of the chat list', chatList[0].id === pinnedId, chatList[0].id);
  ok('the pinned chat is not the most recently updated one',
    chatList.find((c) => c.id === pinnedId).updated < chatList.find((c) => c.id === recentId).updated);
  await h.cmd('Page.reload');
  ok('"continue last chat" opens the most recently updated chat, not the pinned one',
    await waitFor(`state.chat && state.chat.id === ${JSON.stringify(recentId)}`, 15000), await ev(`state.chat ? state.chat.id : null`));

  // ---- retry with another model + compare --------------------------------------------
  const other = 'gemma4:12b';
  await ev(`newChat(); 1`);
  await ev(`send('Reply with exactly the word: kiwi'); 1`);
  ok('the first reply arrives', await waitFor(`!state.streaming && state.chat.messages.length === 2 && state.chat.messages[1].content.length > 0`, 120000));
  const firstModel = await ev(`state.chat.messages[1].model`);
  ok('the first reply came from the selected model', firstModel === model, firstModel);
  await ev(`document.querySelector('#messages .msg.assistant [data-act=regen2]').click(); 1`);
  ok('the model chooser opens', await ev(`!!document.querySelector('#modelPickDlg') && document.querySelector('#modelPickDlg').open`));
  ok('the chooser lists the other models', (await ev(`document.querySelectorAll('#modelPickList button').length`)) >= 2, String(await ev(`document.querySelectorAll('#modelPickList button').length`)));
  await ev(`(() => { [...document.querySelectorAll('#modelPickList button')].find(x => x.dataset.model === ${JSON.stringify(other)}).click(); })(); 1`);
  ok('the reply is regenerated with the other model', await waitFor(`!state.streaming && state.chat.messages.length === 2 && state.chat.messages[1].model === ${JSON.stringify(other)} && state.chat.messages[1].content.length > 0`, 240000), await ev(`state.chat.messages[1] && state.chat.messages[1].model`));
  ok('the old answer is kept as another version', (await ev(`state.chat.messages[1].fk.tails.length`)) === 2 && (await ev(`state.chat.messages[1].fk.tails[0][0].model`)) === firstModel, await ev(`JSON.stringify(state.chat.messages[1].fk.tails.map(t => t && t[0] && t[0].model))`));
  ok('the version switcher shows two versions', /2\/2/.test(await ev(`document.querySelector('#messages .msg.assistant .vers').textContent`)), await ev(`document.querySelector('#messages .msg.assistant .vers')?.textContent`));

  // ---- the answer that follows a tool call stays on the chosen model --------------------
  // A fake Ollama stream: the first answer calls a tool, the second one is the follow-up.
  await ev(`(() => {
    window.__realFetch = window.fetch;
    window.__fakeCalls = 0;
    window.fetch = async (url, opts) => {
      if (!/\\/api\\/chat(\\?|$)/.test(String(url))) return window.__realFetch(url, opts);
      window.__fakeCalls++;
      const lines = window.__fakeCalls === 1
        ? [{ message: { role: 'assistant', content: '' } },
           { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'test__echo', arguments: { q: 'x' } } }] } }]
        : [{ message: { role: 'assistant', content: 'the follow-up answer' } }];
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n')); c.close(); } });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  })(); 1`);
  await ev(`newChat(); 1`);
  await ev(`state.chat.messages.push({ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'the old answer', model: ${JSON.stringify(model)} }); renderAll(); 1`);
  await ev(`document.querySelector('#messages .msg.assistant [data-act=regen2]').click(); 1`);
  await ev(`(() => { [...document.querySelectorAll('#modelPickList button')].find(x => x.dataset.model === ${JSON.stringify(other)}).click(); })(); 1`);
  ok('the answer that follows the tool call arrives', await waitFor(`!state.streaming && state.chat.messages.length >= 3 && state.chat.messages.at(-1).content.length > 0`, 30000),
    await ev(`state.chat.messages.length + ' messages, model ' + (state.chat.messages.at(-1) || {}).model`));
  ok('the follow-up answer comes from the chosen model', (await ev(`state.chat.messages.at(-1).model`)) === other, await ev(`state.chat.messages.at(-1).model`));
  ok('the answer that follows the tool call stays inside the fork',
    (await ev(`!!state.chat.messages[1].fk`)) && (await ev(`state.chat.messages[1].fk.tails.length`)) === 2,
    await ev(`JSON.stringify(state.chat.messages[1] && state.chat.messages[1].fk ? state.chat.messages[1].fk.tails.map((t) => t && t[0] && t[0].model) : null)`));
  await ev(`window.fetch = window.__realFetch; 1`);

  // ---- the model choosers need a model ------------------------------------------------
  await ev(`window.__savedModels = state.models; state.models = []; 1`);
  await ev(`document.querySelector('#messages .msg.assistant [data-act=regen2]').click(); 1`); await sleep(300);
  ok('the model chooser does not open when no model is available', await ev(`!document.querySelector('#modelPickDlg').open`));
  await ev(`document.querySelector('#compareBtn').click(); 1`); await sleep(300);
  ok('the compare dialog does not open when no model is available', await ev(`!document.querySelector('#compareDlg').open`));
  ok('the app says that no models were found', /no models/i.test(await ev(`document.querySelector('#toast').textContent`)),
    await ev(`document.querySelector('#toast').textContent`));
  await ev(`state.models = window.__savedModels; 1`);

  // ---- compare two models -------------------------------------------------------------
  await ev(`document.querySelector('#compareBtn').click(); 1`);
  ok('the compare dialog opens', await ev(`!!document.querySelector('#compareDlg') && document.querySelector('#compareDlg').open`));
  ok('both model pickers are filled', (await ev(`document.querySelector('#cmpModelA').options.length`)) >= 2 && (await ev(`document.querySelector('#cmpModelB').options.length`)) >= 2);
  await ev(`(() => { document.querySelector('#cmpModelA').value = ${JSON.stringify(model)}; document.querySelector('#cmpModelB').value = ${JSON.stringify(other)}; document.querySelector('#cmpStart').click(); })(); 1`);
  ok('both models answer side by side', await waitFor(`document.querySelector('#cmpOutA').textContent.length > 0 && document.querySelector('#cmpOutB').textContent.length > 0`, 240000), await ev(`document.querySelector('#cmpOutA').textContent + ' | ' + document.querySelector('#cmpOutB').textContent`));
  ok('the "keep this one" buttons become available', await waitFor(`!document.querySelector('#cmpKeepA').disabled && !document.querySelector('#cmpKeepB').disabled`, 240000));
  const outA = await ev(`document.querySelector('#cmpOutA').textContent`);
  await ev(`document.querySelector('#cmpKeepA').click(); 1`); await sleep(500);
  ok('"keep this one" puts that answer in the chat', (await ev(`state.chat.messages.at(-1).content`)) === outA, await ev(`state.chat.messages.at(-1).content`));
  ok('the kept answer remembers which model wrote it', (await ev(`state.chat.messages.at(-1).model`)) === model, await ev(`state.chat.messages.at(-1).model`));
  await ev(`document.querySelector('#cmpClose').click(); 1`);

  // ---- troubleshooting ------------------------------------------------------------------
  // A second chat with a marker of its own: no report may show it.
  const MARKER = 'zebra-trombone-mango-9f3a7c';
  const markerChat = await ev(`fetch('/api/chats', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ title: 'Marker Chat' }) }).then(r => r.json()).then(c => c.id)`);
  await ev(`fetch('/api/chats/${markerChat}', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ messages: [{ role: 'user', content: ${JSON.stringify(MARKER)} }] }) }).then(r => r.json()).then(c => c.id)`);
  await ev(`document.querySelector('#settingsBtn').click(); 1`); await sleep(300);
  ok('the settings dialog has a troubleshooting entry', await ev(`!!document.querySelector('#troubleBtn')`));
  await ev(`document.querySelector('#troubleBtn').click(); 1`); await sleep(1000);
  ok('the troubleshooting dialog opens', await ev(`!!document.querySelector('#troubleDlg') && document.querySelector('#troubleDlg').open`));
  const diag = JSON.parse(await ev(`fetch('/api/diagnostics').then(r => r.json()).then(d => JSON.stringify(d))`));
  const box = await ev(`document.querySelector('#diagBox')?.textContent || ''`);
  ok('it shows the data folder', box.includes(diag.dataDir), box.slice(0, 200).replace(/\n/g, ' '));
  ok('it shows the versions and the Ollama status', /node/i.test(box) && /ollama/i.test(box), box.slice(0, 200).replace(/\n/g, ' '));
  ok('it lists the Ollama models', (await ev(`document.querySelector('#diagModels')?.textContent || ''`)).includes(diag.ollama.models[0]));
  const diagText = JSON.stringify(diag);
  ok('the diagnostic report has no chat content', !/kiwi|Reply with exactly/.test(diagText) && !diagText.includes(MARKER), diagText.slice(0, 200));
  ok('the diagnostic report knows Ollama and the data folder', !!diag.dataDir && diag.ollama.reachable && diag.ollama.models.length >= 1, JSON.stringify(diag).slice(0, 200));
  const logs = JSON.parse(await ev(`fetch('/api/logs').then(r => r.json()).then(l => JSON.stringify(l))`));
  const logText = JSON.stringify(logs);
  ok('the server log is available', Array.isArray(logs.lines));
  ok('the server log has no chat content', !/kiwi|Reply with exactly/.test(logText) && !logText.includes(MARKER), logText.slice(0, 200));
  // The strong check: no part of any stored message may show up in the report or the log.
  const allChats = JSON.parse(await ev(`fetch('/api/chats/export').then(r => r.json()).then(l => JSON.stringify(l))`));
  const storedTexts = [];
  for (const c of allChats) for (const m of (c.messages || [])) {
    const t = String(m.content || '').trim();
    if (t.length >= 12) storedTexts.push(t);
  }
  const report = diagText + logText;
  const leaked = storedTexts.filter((t) => report.includes(t) || report.includes(t.slice(0, 12)) || report.includes(t.slice(-12)));
  ok('the report and the log contain no part of any stored message', leaked.length === 0,
    leaked.slice(0, 3).map((t) => t.slice(0, 40)).join(' | ').slice(0, 200));
  ok('the log view is filled', (await ev(`document.querySelector('#logBox')?.textContent.length`)) > 0);
  await ev(`document.querySelector('#troubleClose').click(); 1`);

  // ---- the server log must not carry the stderr of an MCP server ------------------------
  // A second Lumen instance whose MCP server writes a secret to stderr and dies.
  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const SECRET = 'sk-MCP-STDERR-4f8a2b91';
  const leakyScript = path.join(os.tmpdir(), 'lumen-leaky-mcp.js');
  fs.writeFileSync(leakyScript, `process.stderr.write('starting up with token ${SECRET}\\n');\nprocess.exit(1);\n`);
  const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcp-log-'));
  fs.writeFileSync(path.join(mcpDir, 'settings.json'), JSON.stringify({
    mcpServers: [{ id: 'leaky', name: 'Leaky Server', transport: 'stdio', command: `${process.execPath} ${leakyScript}`, enabled: true, env: {} }],
  }));
  const srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: '3199', LUMEN_DATA: path.join(mcpDir, 'chats.json') }, stdio: 'ignore' });
  let mcpLog = '';
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:3199/api/logs');
      mcpLog = JSON.stringify(await r.json());
      if (/Leaky Server/.test(mcpLog)) break;
    } catch { /* the server is not up yet */ }
  }
  ok('the MCP server shows up in the server log', /Leaky Server/.test(mcpLog), mcpLog.slice(0, 200));
  ok('the server log does not contain the stderr of the MCP server', !mcpLog.includes(SECRET), mcpLog.slice(0, 300));
  try { srv2.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(mcpDir, { recursive: true, force: true });

  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
