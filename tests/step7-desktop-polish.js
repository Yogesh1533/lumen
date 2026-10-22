const { launch, sleep } = require('./lib/cdplib');
const dns = require('dns').promises;

const FAKE_SPEECH = `
  window.__recs = [];
  class FakeRec { constructor() { window.__recs.push(this); } start() { this.started = true; } stop() { this.stopped = true; this.onend && this.onend(); } }
  window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec;
`;

(async () => {
  const h = await launch('http://localhost:3101', 9344, { preScript: FAKE_SPEECH });
  const { ev, ok, waitFor, shot, key } = h;
  await ev(`document.querySelector('#thinkToggle').click(); 1`); // thinking off: faster
  const mac = await ev('isMac');
  const MOD = mac ? 4 : 2, SHIFT = 8;
  const K = (k, code, vk, mods = 0) => key(k, code, vk, mods);
  const modK = () => K('k', 'KeyK', 75, MOD);

  // ---- seed chats (incl. one inside a project, invisible in the sidebar) -------------
  const mk = (path, body, method = 'POST') => ev(`fetch('/api${path}', { method: '${method}', headers: {'content-type':'application/json'}, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.json())`);
  await mk('/chats', { title: 'Zebra Planning' });
  await mk('/chats', { title: 'Octopus Notes' });
  const proj = await mk('/projects', { name: 'Safari' });
  await mk('/chats', { title: 'Quokka Project Chat', project: proj.id });
  await ev(`loadProjects(); refreshChats(); 1`); await sleep(800);

  // ---- command palette ---------------------------------------------------------------
  await modK();
  ok(`${mac ? '⌘' : 'Ctrl+'}K opens the palette`, await waitFor(`document.querySelector('#palette').open`, 3000));
  ok('palette input is focused', (await ev(`document.activeElement && document.activeElement.id`)) === 'palIn');
  ok('palette lists actions, models, styles and chats', (await ev(`document.querySelectorAll('#palList .pal').length`)) > 15);
  await ev(`(() => { palIn.value = 'theme'; palIn.dispatchEvent(new Event('input')); })(); 1`);
  ok('typing filters the list', (await ev(`document.querySelector('#palList .pal .l').textContent`)) === 'Toggle dark / light theme');
  const theme0 = await ev(`document.documentElement.dataset.theme`);
  await K('Enter', 'Enter', 13); await sleep(500);
  ok('Enter runs the command (theme flipped)', (await ev(`document.documentElement.dataset.theme`)) !== theme0);
  ok('palette closes after running', !(await ev(`document.querySelector('#palette').open`)));

  await modK();
  await ev(`(() => { palIn.value = 'octopus'; palIn.dispatchEvent(new Event('input')); })(); 1`);
  ok('chat search finds "Octopus Notes"', (await ev(`document.querySelector('#palList .pal .l').textContent`)) === 'Chat: Octopus Notes');
  await K('Enter', 'Enter', 13); await sleep(900);
  ok('Enter opens that chat', (await ev(`state.chat.title`)) === 'Octopus Notes');

  await modK();
  await ev(`(() => { palIn.value = 'quokka'; palIn.dispatchEvent(new Event('input')); })(); 1`); await sleep(800);
  ok('palette searches chats inside other projects too', (await ev(`document.querySelector('#palList .pal .l')?.textContent`)) === 'Chat: Quokka Project Chat');
  await K('Enter', 'Enter', 13); await sleep(1200);
  ok('opening it switches into its project', (await ev(`state.chat.title`)) === 'Quokka Project Chat' && (await ev(`state.project`)) === proj.id);
  await ev(`selectProject(null); 1`); await sleep(500);

  await modK();
  await ev(`(() => { palIn.value = 'zzzz-nothing'; palIn.dispatchEvent(new Event('input')); })(); 1`);
  ok('no matches shows an empty state', /No matches/.test(await ev(`document.querySelector('#palList').textContent`)));
  await ev(`(() => { palIn.value = 'style'; palIn.dispatchEvent(new Event('input')); })(); 1`);
  await K('ArrowDown', 'ArrowDown', 40); await K('ArrowDown', 'ArrowDown', 40); await K('ArrowUp', 'ArrowUp', 38);
  ok('arrow keys move the selection', (await ev(`palSel`)) === 1 && (await ev(`document.querySelectorAll('#palList .pal')[1].classList.contains('sel')`)));
  await shot('step7-palette');
  await K('Escape', 'Escape', 27); await sleep(300);
  ok('Esc closes the palette', !(await ev(`document.querySelector('#palette').open`)));
  await modK(); await modK(); await sleep(200);
  ok(`${mac ? '⌘' : 'Ctrl+'}K again toggles it closed`, !(await ev(`document.querySelector('#palette').open`)));

  // ---- shortcuts ----------------------------------------------------------------------
  await K('b', 'KeyB', 66, MOD); await sleep(200);
  ok('Cmd/Ctrl+B hides the sidebar', await ev(`document.querySelector('#sidebar').classList.contains('closed')`));
  await K('b', 'KeyB', 66, MOD);
  ok('…and shows it again', !(await ev(`document.querySelector('#sidebar').classList.contains('closed')`)));
  await ev(`openChat(state.chats[0].id); 1`); await sleep(600);
  await K('O', 'KeyO', 79, MOD | SHIFT); await sleep(400);
  ok('Cmd/Ctrl+Shift+O starts a new chat', (await ev(`state.chat.id`)) === null);
  await K('/', 'Slash', 191, MOD); await sleep(300);
  ok('Cmd/Ctrl+/ shows the shortcuts help', (await ev(`document.querySelector('#helpDlg').open`)) && (await ev(`document.querySelectorAll('#helpList .krow').length`)) >= 5);
  await K('Escape', 'Escape', 27); await sleep(300);
  ok('Esc closes the help', !(await ev(`document.querySelector('#helpDlg').open`)));
  await ev(`send('Write a 500 word story about a lighthouse keeper.'); 1`);
  ok('(reply starts streaming)', await waitFor(`!!state.streaming`, 20000));
  await sleep(600);
  await K('Escape', 'Escape', 27); await sleep(800);
  ok('Esc stops a running reply', (await ev(`!state.streaming && !document.querySelector('#sendBtn').hidden`)));
  ok('partial reply was kept', (await ev(`state.chat.messages.at(-1).content.length`)) > 0);

  // ---- dictation ------------------------------------------------------------------------
  ok('mic button is shown when speech recognition exists', !(await ev(`document.querySelector('#micBtn').hidden`)));
  await ev(`newChat(); window.__confirms = 0; window.__answer = false; window.confirm = () => { window.__confirms++; return window.__answer; }; document.querySelector('#input').value = 'Draft:'; 1`);
  await ev(`document.querySelector('#micBtn').click(); 1`);
  ok('consent is asked first; declining does not start listening', (await ev(`__confirms`)) === 1 && (await ev(`__recs.length`)) === 0 && (await ev(`pref('dictConsent')`)) !== '1');
  await ev(`__answer = true; document.querySelector('#micBtn').click(); 1`);
  ok('accepting starts recognition + shows recording state', (await ev(`__recs.length === 1 && __recs[0].started === true && document.querySelector('#micBtn').classList.contains('on')`)));
  ok('recognition configured for live results', (await ev(`__recs[0].interimResults === true && __recs[0].continuous === true && !!__recs[0].lang`)));
  await ev(`__recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello wor' }], { isFinal: false })] }); 1`);
  ok('interim text appears after existing text', (await ev(`document.querySelector('#input').value`)) === 'Draft: hello wor');
  await ev(`__recs[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'hello world' }], { isFinal: true })] }); 1`);
  await ev(`__recs[0].onresult({ resultIndex: 1, results: [Object.assign([{ transcript: 'hello world' }], { isFinal: true }), Object.assign([{ transcript: ' and more' }], { isFinal: false })] }); 1`);
  ok('final + new interim results accumulate without duplicating', (await ev(`document.querySelector('#input').value`)) === 'Draft: hello world and more');
  await ev(`document.querySelector('#micBtn').click(); 1`);
  ok('clicking again stops and clears the recording state', (await ev(`__recs[0].stopped === true && !document.querySelector('#micBtn').classList.contains('on')`)));
  ok('text is kept for review/sending', (await ev(`document.querySelector('#input').value`)) === 'Draft: hello world and more');
  await ev(`document.querySelector('#micBtn').click(); 1`);
  ok('consent is remembered (no second prompt)', (await ev(`__confirms`)) === 2 && (await ev(`__recs.length`)) === 2);
  await ev(`__recs[1].onerror({ error: 'not-allowed' }); 1`);
  ok('mic permission errors are explained', /Microphone access was blocked/.test(await ev(`document.querySelector('#toast').textContent`)));
  await ev(`__recs[1].stop(); 1`);

  // ---- web tools ----------------------------------------------------------------------------
  const probe = async (tool, args) => ev(`api('/mcp/call', { method: 'POST', body: { server: 'builtin', tool: ${JSON.stringify(tool)}, arguments: ${JSON.stringify(args)} } }).then(r => JSON.stringify(r))`);
  // The built-in "Skills" server (step 10) is always there, so the web server is looked
  // up by its own id.
  ok('web tools are off by default (no built-in server)', (await ev(`api('/mcp').then(l => l.some(s => s.id === 'builtin'))`)) === false);
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(600);
  ok('web config hidden until enabled', (await ev(`document.querySelector('#webCfg').hidden`)) === true);
  await ev(`document.querySelector('#webOn').click(); 1`); await sleep(900);
  ok('enabling adds a built-in "Web" server with fetch_page only', (await ev(`JSON.stringify(state.mcp.find(s => s.id === 'builtin').tools.map(t => t.name))`)) === '["fetch_page"]');
  ok('built-in row has no remove/toggle buttons', (await ev(`document.querySelector('#mcpList .mcp [data-a=rm]')`)) === null);
  await ev(`(() => { webProv.value = 'searxng'; webProv.dispatchEvent(new Event('change')); webUrl.value = 'http://127.0.0.1:3197'; document.querySelector('#webSave').click(); })(); 1`); await sleep(900);
  ok('configuring SearXNG adds web_search', (await ev(`JSON.stringify(state.mcp.find(s => s.builtin).tools.map(t => t.name))`)) === '["web_search","fetch_page"]');
  const sr = JSON.parse(await probe('web_search', { query: 'zebra handbook' }));
  ok('web_search returns formatted results', !sr.isError && /1\. Lumen Zebra Handbook\n\s+https:\/\/example\.org\/zebra/.test(sr.text), sr.text.slice(0, 60).replace(/\n/g, ' '));
  ok('query + json format reached SearXNG', require('fs').readFileSync(require('path').join(require('./lib/cdplib').T, 'searx-last-query.txt'), 'utf8') === 'zebra handbook|json');
  const empty = JSON.parse(await probe('web_search', { query: '  ' }));
  ok('empty query is rejected', empty.isError && /query is required/i.test(empty.text));
  // Brave key must never come back to the page
  await ev(`(() => { webProv.value = 'brave'; webProv.dispatchEvent(new Event('change')); webKey.value = 'sk-test-SECRET-123'; document.querySelector('#webSave').click(); })(); 1`); await sleep(900);
  const pub = await ev(`fetch('/api/settings').then(r => r.text())`);
  ok('Brave API key is stored but never sent back to the browser', !/SECRET-123/.test(pub) && /"hasBraveKey":true/.test(pub));
  ok('key field shows "saved" placeholder', /Key saved/.test(await ev(`document.querySelector('#webKey').placeholder`)));
  await ev(`(() => { webProv.value = 'searxng'; webProv.dispatchEvent(new Event('change')); webUrl.value = 'http://127.0.0.1:3197'; document.querySelector('#webSave').click(); })(); 1`); await sleep(800);
  ok('bad SearXNG URL is rejected', (await ev(`fetch('/api/settings', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ web: { searxngUrl: 'javascript:alert(1)' } }) }).then(r => r.status)`)) === 400);
  await ev(`document.querySelector('#toolsClose').click(); 1`);

  // ---- fetch_page: SSRF protection + a real page ---------------------------------------------
  for (const [label, url, re] of [
    ['loopback IP', 'http://127.0.0.1:3197/', /private or local/i],
    ['localhost name', 'http://localhost:3101/api/settings', /private or local/i],
    ['cloud metadata IP', 'http://169.254.169.254/latest/meta-data/', /private or local/i],
    ['private LAN IP', 'http://192.168.1.1/', /private or local/i],
    ['IPv6 loopback', 'http://[::1]:3101/', /private or local/i],
    ['file:// URL', 'file:///etc/passwd', /Only http/i],
    ['garbage URL', 'not a url', /valid URL/i],
  ]) {
    const r = JSON.parse(await probe('fetch_page', { url }));
    ok(`fetch_page blocks ${label}`, r.isError && re.test(r.text) && !/secret local content|root:/.test(r.text), r.text.slice(0, 70));
  }
  let rebinding = null;
  try { const a = await dns.lookup('localtest.me', { all: true }); rebinding = a.some((x) => x.address === '127.0.0.1'); } catch { /* no such DNS */ }
  if (rebinding) { const r = JSON.parse(await probe('fetch_page', { url: 'http://localtest.me:3101/' })); ok('fetch_page blocks a public hostname that resolves to 127.0.0.1', r.isError && /private or local/i.test(r.text), r.text); }
  else console.log('SKIP localtest.me rebinding check (hostname does not resolve to loopback here)');
  const ex = JSON.parse(await probe('fetch_page', { url: 'https://example.com/' }));
  ok('fetch_page reads a real public page as text', !ex.isError && /Title: Example Domain/.test(ex.text) && !/<html|<script/i.test(ex.text), ex.text.slice(0, 80).replace(/\n/g, ' '));
  const redir = JSON.parse(await probe('fetch_page', { url: 'http://example.com/' }));
  ok('fetch_page follows http→https redirects', !redir.isError && /Example Domain/.test(redir.text));

  // ---- model uses web_search (approval-gated) ------------------------------------------------------
  await ev(`newChat(); 1`);
  await ev(`send(${JSON.stringify("Search the web for 'zebra handbook' and tell me the title of the first result.")}); 1`);
  ok('web_search call asks for approval', await waitFor(`!!document.querySelector('.toolcall.awaiting')`, 90000), await ev(`document.querySelector('.toolcall .th')?.textContent`));
  ok('approval card is for Web › web_search', /Web › web_search/.test(await ev(`document.querySelector('.toolcall.awaiting .th').textContent`)));
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=once]').click(); 1`);
  await waitFor(`!state.streaming && !state.toolsBusy && state.chat.messages.at(-1).role === 'assistant' && !state.chat.messages.at(-1).toolCalls`, 150000);
  const ans = await ev(`state.chat.messages.at(-1).content`); console.log('   answer:', JSON.stringify(ans.slice(0, 140)));
  ok('model answers from the search results', /Lumen Zebra Handbook/i.test(ans));

  // ---- installable app (PWA) -------------------------------------------------------------------------
  const man = await ev(`fetch('/manifest.webmanifest').then(async r => JSON.stringify({ s: r.status, t: r.headers.get('content-type'), j: await r.json() }))`);
  const mj = JSON.parse(man);
  ok('manifest is served as application/manifest+json', mj.s === 200 && /manifest\+json/.test(mj.t) && mj.j.display === 'standalone' && mj.j.name === 'Lumen');
  for (const size of [192, 512]) {
    const info = await ev(`new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('ERR'); i.src = '/icon-${size}.png'; })`);
    ok(`icon-${size}.png loads at the right size`, info === `${size}x${size}`, info);
  }
  ok('page links the manifest', (await ev(`!!document.querySelector('link[rel=manifest]')`)));
  const inst = await h.cmd('Page.getInstallabilityErrors');
  ok('Chrome reports no installability errors', (inst.result.installabilityErrors || []).length === 0, JSON.stringify((inst.result.installabilityErrors || []).map((e) => e.errorId)));
  await shot('step7-final');
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
