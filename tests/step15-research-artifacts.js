// Step 15 — research and artifacts: the bridge of an AI-powered artifact (consent, a
// round trip to the model, storage, limits, link opening that asks first), the sandbox
// probes that must still be blocked, the artifact library, the pop-out with its CSP,
// the research budget, and a real research run against the fake SearXNG with real
// example.org pages.
const { launch, sleep } = require('./lib/cdplib');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = process.env.LUMEN_TEST_TMP || path.join(os.tmpdir(), 'lumen-tests');
const BASE = process.env.LUMEN_URL || 'http://localhost:3101';
const MODEL = process.env.LUMEN_TEST_MODEL || '';
async function call(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, headers: r.headers };
}
const fence = '```';
const APP = `${fence}html
<!doctype html>
<html><head><title>Bridge App</title></head>
<body><h1>Bridge App</h1><a id="ext" href="https://example.com/clicked">a link</a><pre id="probe"></pre>
<script>
  (async () => {
    const out = [];
    try { parent.document.title; out.push('parent.document: OPEN'); } catch (e) { out.push('parent.document: BLOCKED'); }
    try { localStorage.getItem('x'); out.push('localStorage: OPEN'); } catch (e) { out.push('localStorage: BLOCKED'); }
    try { document.cookie = 'a=1'; out.push(document.cookie ? 'cookie: OPEN' : 'cookie: BLOCKED'); } catch (e) { out.push('cookie: BLOCKED'); }
    try { const r = await fetch('/api/chats'); out.push('fetch: ' + (r.ok ? 'OPEN' : 'BLOCKED ' + r.status)); } catch (e) { out.push('fetch: BLOCKED'); }
    out.push('origin: ' + self.origin);
    document.getElementById('probe').textContent = out.join('\\n');
  })();
</script></body></html>
${fence}`;
const OTHER = `${fence}html
<!doctype html><html><head><title>Other App</title></head><body>other</body></html>
${fence}`;
const THIRD = `${fence}html
<!doctype html><html><head><title>Third App</title></head><body>third</body></html>
${fence}`;

(async () => {
  const pre = `window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; };
    window.__confirmAnswer = true; window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAnswer; };`;
  const h = await launch(BASE, 9356, { extraArgs: ['--disable-features=IsolateSandboxedIframes'], preScript: pre });
  const { ev, waitFor, ok, cmd, ctxs } = h;
  await ev(`state.ready.then(() => 1)`);
  await ev(`document.querySelector('#thinkToggle').checked && document.querySelector('#thinkToggle').click(); 1`);
  const model = MODEL || await ev(`document.querySelector('#modelSelect').value`);

  // ---- 1. the library and the pop-out (API) --------------------------------------
  const chat = (await call('POST', '/api/chats', { title: 'Artifact chat', model, messages: [
    { role: 'user', content: 'make things' },
    { role: 'assistant', content: `Here:\n\n${APP}\n\nand a picture\n\n${fence}svg\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>\n${fence}\n\nand notes\n\n${fence}markdown\n# Zebra Notes\n\nStripes <b>bold</b>.\n${fence}` },
    { role: 'user', content: 'more' },
    { role: 'assistant', content: `${OTHER}\n\n${THIRD}` },
  ] })).json;
  const lib = (await call('GET', '/api/artifacts')).json;
  const mine = lib.filter((a) => a.chat === chat.id);
  ok('the library lists the artifacts of a chat', mine.length === 5 && mine.some((a) => a.title === 'Bridge App' && a.lang === 'html') && mine.some((a) => a.lang === 'svg') && mine.some((a) => a.title === 'Zebra Notes' && a.lang === 'md'), JSON.stringify(mine.map((a) => [a.title, a.lang, a.mi, a.n])));
  const q = (await call('GET', '/api/artifacts?q=zebra')).json;
  ok('the library searches titles and code', q.length >= 1 && q.every((a) => /zebra/i.test(a.title) || a.lang === 'md'), JSON.stringify(q.map((a) => a.title)));
  const one = (await call('GET', `/api/artifacts/${chat.id}/1/0`)).json;
  ok('one artifact can be read with its code', one && one.title === 'Bridge App' && /lumen|Bridge App/.test(one.code) && one.ext === 'html');
  const pop = await call('GET', `/pop/${chat.id}/1/0`);
  ok('the pop-out is served', pop.status === 200 && /Bridge App/.test(pop.text));
  ok('the pop-out has "Content-Security-Policy: sandbox allow-scripts"', pop.headers.get('content-security-policy') === 'sandbox allow-scripts', pop.headers.get('content-security-policy'));
  ok('the pop-out says nosniff and no-store', pop.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(pop.headers.get('cache-control') || ''));
  const popMd = await call('GET', `/pop/${chat.id}/1/2`);
  ok('a markdown pop-out shows its text escaped', /&lt;b&gt;bold&lt;\/b&gt;/.test(popMd.text) && !/<b>bold<\/b>/.test(popMd.text));
  const cross = await call('GET', `/pop/${chat.id}/1/0`, undefined, { 'sec-fetch-site': 'cross-site' });
  ok('another site cannot load a pop-out', cross.status === 403);
  ok('an unknown artifact is a 404', (await call('GET', `/pop/${chat.id}/9/9`)).status === 404 && (await call('GET', '/pop/nope/1/0')).status === 404);

  // The pop-out in a tab of its own has an opaque origin: no API, no storage.
  {
    const t = (await cmd('Target.createTarget', { url: `${BASE}/pop/${chat.id}/1/0` })).result.targetId;
    await sleep(2500);
    const list = await (await fetch('http://127.0.0.1:9356/json')).json();
    const tg = list.find((x) => x.id === t);
    const ws = new WebSocket(tg.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
    const pev = (expr) => new Promise((r) => { pend.set(++id, (j) => r(j.result && j.result.result ? j.result.result.value : 'ERR')); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
    await sleep(1500);
    const probe = await pev(`document.getElementById('probe').textContent`);
    ok('the pop-out has an opaque origin', /origin: null/.test(probe), probe);
    ok('the pop-out cannot reach the API, the storage, the cookies or a parent', /fetch: BLOCKED/.test(probe) && /localStorage: BLOCKED/.test(probe) && /cookie: BLOCKED/.test(probe), probe);
    ok('the pop-out has no bridge', (await pev(`typeof window.lumen`)) === 'undefined');
    ws.close();
    await cmd('Target.closeTarget', { targetId: t });
  }

  // ---- 2. the library in the page ---------------------------------------------------
  await ev(`refreshChats(); document.querySelector('#libBtn').click(); 1`);
  await waitFor(`document.querySelectorAll('#libList .libitem').length >= 5`, 8000);
  ok('the library dialog lists the artifacts', (await ev(`document.querySelectorAll('#libList .libitem').length`)) >= 5);
  await ev(`document.querySelector('#libQ').value = 'Zebra Notes'; document.querySelector('#libQ').dispatchEvent(new Event('input')); 1`);
  await waitFor(`document.querySelectorAll('#libList .libitem').length === 1`, 5000);
  ok('the library search filters the list', (await ev(`document.querySelector('#libList').innerText`)).includes('Zebra Notes'));
  await ev(`document.querySelector('#libList .libitem [data-a=pop]').click(); 1`);
  ok('Pop out opens the pop-out route', /^\/pop\/[0-9a-f-]+\/1\/2$/.test(await ev(`window.__opened.at(-1)`)), await ev(`window.__opened.at(-1)`));
  await ev(`document.querySelector('#libQ').value = 'Bridge App'; document.querySelector('#libQ').dispatchEvent(new Event('input')); 1`);
  await waitFor(`document.querySelectorAll('#libList .libitem').length === 1 && /Bridge App/.test(document.querySelector('#libList').innerText)`, 5000);
  await ev(`document.querySelector('#libList .libitem [data-a=open]').click(); 1`);
  await waitFor(`state.chat.id === ${JSON.stringify(chat.id)} && !document.querySelector('#artifact').hidden`, 8000);
  ok('Open in the library opens the chat and the artifact', (await ev(`document.querySelector('#artTitle').textContent`)) === 'Bridge App');

  // ---- 3. the bridge ---------------------------------------------------------------
  const frameCtx = async () => { await sleep(1200); return [...ctxs].reverse().find((c) => c.auxData && c.auxData.isDefault && c.origin === '://'); };
  let f = await frameCtx();
  ok('the artifact runs in an opaque origin', !!f);
  const probes = await ev(`document.getElementById('probe').textContent`, f.id);
  ok('the sandbox probes are still blocked (parent, localStorage, cookies, the API)', /parent\.document: BLOCKED/.test(probes) && /localStorage: BLOCKED/.test(probes) && /cookie: BLOCKED/.test(probes) && /fetch: BLOCKED/.test(probes) && /origin: null/.test(probes), probes);
  ok('the artifact has the bridge', (await ev(`typeof window.lumen.ask === 'function' && typeof window.lumen.storage.set === 'function' && Object.isFrozen(window.lumen)`, f.id)) === true);
  ok('the badge is off before the artifact uses Lumen', (await ev(`document.querySelector('#artAi').hidden`)) === true);
  // The first use asks the user.
  await ev(`window.__set = window.lumen.storage.set('greeting', { text: 'hello', n: 1 }).then(() => 'ok', (e) => 'ERR ' + e.message); 1`, f.id);
  await waitFor(`document.querySelector('#artConsentDlg').open`, 5000);
  ok('the first use asks for consent, naming the artifact', /Bridge App/.test(await ev(`document.querySelector('#artConsentText').textContent`)));
  await ev(`document.querySelector('#artConsentYes').click(); 1`);
  await sleep(400);
  ok('after consent the storage works', (await ev(`window.__set`, f.id)) === 'ok');
  ok('the stored value comes back', JSON.stringify(await ev(`window.lumen.storage.get('greeting')`, f.id)) === '{"text":"hello","n":1}');
  ok('the keys are listed', JSON.stringify(await ev(`window.lumen.storage.keys()`, f.id)) === '["greeting"]');
  ok('the badge shows that the artifact uses Lumen', (await ev(`!document.querySelector('#artAi').hidden`)) === true);
  ok('a value over 20 KB is refused', /at most 20 KB/.test(await ev(`window.lumen.storage.set('big', 'x'.repeat(21000)).then(() => 'ok', (e) => e.message)`, f.id)));
  ok('a value that is not plain data is refused', /plain data/.test(await ev(`window.lumen.storage.set('fn', undefined).then(() => 'ok', (e) => e.message)`, f.id)));
  const full = await ev(`(async () => { try { for (let i = 0; i < 7; i++) await window.lumen.storage.set('k' + i, 'y'.repeat(19000)); return 'ok'; } catch (e) { return e.message; } })()`, f.id);
  ok('the storage of an artifact is capped at 100 KB', /full \(100 KB\)/.test(full), full);
  ok('a removed key is gone', (await ev(`window.lumen.storage.remove('k0').then(() => window.lumen.storage.get('k0'))`, f.id)) === null);
  // Ask: a round trip to the model.
  const ans = await ev(`window.lumen.ask('Reply with exactly the word BRIDGEOK and nothing else.').then((a) => a, (e) => 'ERR ' + e.message)`, f.id);
  ok('ask() gets the answer of the model', /BRIDGEOK/i.test(ans), JSON.stringify(ans).slice(0, 120));
  // An artifact prompt never starts a research run, even with the toggle on.
  await ev(`rs.armed = true; state.chat.messages.push({ role: 'user', content: 'armed' }); 1`);
  const armedAns = await ev(`window.lumen.ask('Reply with exactly the word ARMEDOK.').then((a) => a, (e) => 'ERR ' + e.message)`, f.id);
  ok('an artifact prompt never starts a research run', !(await ev(`document.querySelector('#researchDlg').open`)) && !(await ev(`!!rs.run`)) && /ARMEDOK/i.test(armedAns), armedAns);
  await ev(`rs.armed = false; state.chat.messages.pop(); 1`);
  ok('a prompt over 4,000 characters is refused', /longer than 4000/.test(await ev(`window.lumen.ask('x'.repeat(4001)).then(() => 'ok', (e) => e.message)`, f.id)));
  ok('an empty prompt is refused', /empty/.test(await ev(`window.lumen.ask('   ').then(() => 'ok', (e) => e.message)`, f.id)));
  await ev(`artState.asks.set(artKey(artCurrent()), Array(10).fill(Date.now())); 1`);
  ok('at most 10 prompts a minute', /10 prompts a minute/.test(await ev(`window.lumen.ask('hi').then(() => 'ok', (e) => e.message)`, f.id)));
  await ev(`artState.asks.clear(); 1`);
  // Links ask first.
  await ev(`window.__confirmAnswer = false; window.__opened = []; 1`);
  ok('a link the user refuses is not opened', (await ev(`window.lumen.openLink('https://example.com/refused')`, f.id)) === false && (await ev(`window.__opened.length`)) === 0 && /example\.com\/refused/.test(await ev(`window.__confirms.at(-1)`)));
  await ev(`window.__confirmAnswer = true; 1`);
  ok('a link the user allows is opened', (await ev(`window.lumen.openLink('https://example.com/allowed')`, f.id)) === true && (await ev(`window.__opened.at(-1)`)) === 'https://example.com/allowed');
  ok('a javascript: link is refused', /http/.test(await ev(`window.lumen.openLink('javascript:alert(1)').then(() => 'ok', (e) => e.message)`, f.id)));
  await ev(`document.getElementById('ext').click(); 1`, f.id);
  await sleep(500);
  ok('a plain link click in the artifact asks first', /example\.com\/clicked/.test(await ev(`window.__confirms.at(-1)`)) && (await ev(`window.__opened.at(-1)`)) === 'https://example.com/clicked');
  // A message that does not come from the artifact is ignored.
  await ev(`window.__echo = 0; window.addEventListener('message', (e) => { if (e.data && e.data.__lumen === 2) window.__echo++; }); window.postMessage({ __lumen: 1, id: 77, op: 'keys', args: {} }, '*'); 1`);
  await sleep(400);
  ok('a message that does not come from the artifact is ignored', (await ev(`window.__echo`)) === 0);
  // Another artifact: denied, then a third one that is allowed sees none of the data.
  await ev(`state.art.i = state.art.list.findIndex((a) => artTitle(a) === 'Other App'); renderArtifact(); 1`);
  f = await frameCtx();
  await ev(`window.__other = window.lumen.storage.keys().then((k) => JSON.stringify(k), (e) => 'ERR ' + e.message); 1`, f.id);
  await waitFor(`document.querySelector('#artConsentDlg').open`, 5000);
  ok('every artifact asks for its own consent', /Other App/.test(await ev(`document.querySelector('#artConsentText').textContent`)));
  await ev(`document.querySelector('#artConsentNo').click(); 1`);
  await sleep(400);
  ok('a denied artifact gets nothing', /did not allow/.test(await ev(`window.__other`, f.id)));
  ok('a denied artifact is not asked again in this session', /did not allow/.test(await ev(`window.lumen.ask('hi').then(() => 'ok', (e) => e.message)`, f.id)) && (await ev(`document.querySelector('#artConsentDlg').open`)) === false);
  await ev(`state.art.i = state.art.list.findIndex((a) => artTitle(a) === 'Third App'); renderArtifact(); 1`);
  f = await frameCtx();
  await ev(`window.__third = window.lumen.storage.keys().then((k) => JSON.stringify(k), (e) => 'ERR ' + e.message); 1`, f.id);
  await waitFor(`document.querySelector('#artConsentDlg').open`, 5000);
  await ev(`document.querySelector('#artConsentYes').click(); 1`);
  await sleep(400);
  ok('an artifact cannot see the data of another artifact', (await ev(`window.__third`, f.id)) === '[]');
  ok('the Pop out button opens the pop-out of the shown artifact', await (async () => { await ev(`window.__opened = []; document.querySelector('#artPop').click(); 1`); return /^\/pop\/[0-9a-f-]+\/3\/1$/.test(await ev(`window.__opened.at(-1)`)); })());
  await ev(`closeArtifact(); 1`);

  // ---- 4. research: the budget ---------------------------------------------------------
  await call('PUT', '/api/settings', { web: { enabled: true, provider: 'searxng', searxngUrl: 'http://127.0.0.1:3197' } });
  // The switches of the web tools may be left off by an earlier step: this step sets
  // them itself.
  await call('PUT', '/api/mcp/builtin/tools', { disabled: [] });
  await ev(`loadMcp().then(() => { rsButton(); return 1; })`);
  ok('the research button shows when the web tools can search', (await ev(`!document.querySelector('#researchBtn').hidden`)) === true);
  await ev(`newChat(); 1`);
  const lastQ = () => { try { return fs.readFileSync(path.join(TMP, 'searx-last-query.txt'), 'utf8'); } catch { return ''; } };
  // Cancel: nothing happens.
  const q0 = lastQ();
  await ev(`document.querySelector('#researchBtn').click(); send('Research zebras'); 1`);
  await waitFor(`document.querySelector('#researchDlg').open`, 8000);
  ok('a research run asks once, with its budget', /8 web searches/.test(await ev(`document.querySelector('#researchText').textContent`)) && /15 pages/.test(await ev(`document.querySelector('#researchText').textContent`)) && /6 minutes/.test(await ev(`document.querySelector('#researchText').textContent`)));
  await ev(`document.querySelector('#researchNo').click(); 1`);
  await sleep(800);
  ok('Cancel starts nothing', !(await ev(`!!rs.run`)) && (await ev(`state.chat.messages.filter((m) => m.role === 'assistant').length`)) === 0 && lastQ() === q0);
  ok('the toggle is off after one message', (await ev(`document.querySelector('#researchBtn').getAttribute('aria-pressed')`)) === 'false');
  // A run whose tool calls are made by hand: the budget holds.
  await ev(`newChat(); state.chat.messages.push({ role: 'user', content: 'budget test' }); rs.armed = true; window.__go = hooks.beforeGenerate(document.querySelector('#modelSelect').value, state.chat); 1`);
  await waitFor(`document.querySelector('#researchDlg').open`, 8000);
  await ev(`document.querySelector('#researchYes').click(); 1`);
  ok('Start begins the run', (await ev(`window.__go`)) === true && (await ev(`!!rs.run && !rs.run.ended`)) === true);
  ok('the progress bar shows the run', (await ev(`!document.querySelector('#researchBar').hidden && /searches 0\\/8/.test(document.querySelector('#rsStats').textContent)`)) === true);
  const fakeCalls = (calls) => `(async () => {
    const set = buildTools();
    const reply = { role: 'assistant', content: '', model: state.chat.model, t: Date.now(), toolCalls: ${JSON.stringify(calls)}.map(([n, a]) => registerCall({ function: { name: n, arguments: a } }, set.map)) };
    state.chat.messages.push(reply); renderAll();
    await runToolCalls(state.chat, reply);
    return JSON.stringify(reply.toolCalls.map((c) => [c.tool, c.status, (c.result || '').slice(0, 140)]));
  })()`;
  const nine = JSON.parse(await ev(fakeCalls(Array.from({ length: 9 }, (_, i) => ['web__web_search', { query: 'zebra ' + i }]))));
  ok('the searches of the budget run without asking', nine.slice(0, 8).every((c) => c[1] === 'done'), JSON.stringify(nine.map((c) => c[1])));
  ok('the 9th search is refused', nine[8][1] === 'error' && /8 searches/.test(nine[8][2]), nine[8][2]);
  ok('no approval card was shown for the web tools', (await ev(`!document.querySelector('.toolcall.awaiting')`)) === true);
  const pages = JSON.parse(await ev(fakeCalls([['web__fetch_page', { url: 'https://example.org/' }], ['web__fetch_page', { url: 'https://example.com/' }]])));
  ok('a page that was read gets its source number', /^\[Source 1\] https:\/\/example\.org\//.test(pages[0][2]) && /^\[Source 2\] https:\/\/example\.com\//.test(pages[1][2]), JSON.stringify(pages));
  ok('the sources are recorded', (await ev(`rs.run.sources.length`)) === 2 && (await ev(`rs.run.pages`)) === 2);
  ok('the system prompt carries the research instructions and the budget', /RESEARCH MODE/.test(await ev(`fullSystem('')`)) && /used so far: 8 searches, 2 pages/.test(await ev(`fullSystem('')`)));
  await ev(`rs.run.pages = 15; rs.run.searches = 1; 1`);
  const sixteen = JSON.parse(await ev(fakeCalls([['web__fetch_page', { url: 'https://example.org/more' }]])));
  ok('a page over the budget is refused', sixteen[0][1] === 'error' && /15 pages/.test(sixteen[0][2]), JSON.stringify(sixteen));
  await ev(`rs.run.searches = 8; 1`);
  ok('when the budget is spent the web tools are taken away', (await ev(`!(buildTools() || { defs: [] }).defs.some((d) => d.function.name.startsWith('web__'))`)) === true);
  await ev(`rs.run.pages = 2; rs.run.searches = 1; rs.run.deadline = Date.now() - 1; 1`);
  await sleep(1300);
  ok('the time budget ends the tool calls', (await ev(`rs.run.timeUp`)) === true && /time of this research run is up/.test(await ev(`hooks.toolPolicy({ server: 'builtin', tool: 'web_search', arguments: { query: 'late' } }, state.chat).then((p) => p && p.error)`)));
  ok('… and takes the web tools away', (await ev(`!(buildTools() || { defs: [] }).defs.some((d) => d.function.name.startsWith('web__'))`)) === true);
  // A report without source numbers gets one more turn to add them (generate is
  // replaced here, so the model is not called).
  await ev(`window.__gen = generate; window.__regen = 0; generate = () => { window.__regen++; }; (() => { const r = { role: 'assistant', content: '# Zebra report\\n\\nZebras have stripes.', model: state.chat.model, t: Date.now() }; state.chat.messages.push(r); hooks.onReply(r, state.chat); return 1; })()`);
  await sleep(300);
  ok('a report without source numbers is sent back once to add them', (await ev(`window.__regen`)) === 1 && /^\[Research\] Your report does not cite/.test(await ev(`state.chat.messages.at(-1).content`)) && (await ev(`rs.run.ended`)) === false);
  ok('… and the revision gets no web tools', (await ev(`!(buildTools() || { defs: [] }).defs.some((d) => d.function.name.startsWith('web__'))`)) === true);
  await ev(`(() => { const r = { role: 'assistant', content: 'Still nothing.', model: state.chat.model, t: Date.now() }; state.chat.messages.push(r); hooks.onReply(r, state.chat); return 1; })()`);
  ok('… only once: the next answer is the report, with a note', (await ev(`window.__regen`)) === 1 && (await ev(`rs.run.ended`)) === true && /did not cite its sources/.test(await ev(`state.art.list[state.art.i].code`)));
  await ev(`generate = window.__gen; closeArtifact(); 1`);
  // A run whose report cites: it becomes the report as it is.
  await ev(`newChat(); state.chat.messages.push({ role: 'user', content: 'budget test 2' }); rs.armed = true; window.__go = hooks.beforeGenerate(document.querySelector('#modelSelect').value, state.chat); 1`);
  await waitFor(`document.querySelector('#researchDlg').open`, 8000);
  await ev(`document.querySelector('#researchYes').click(); 1`);
  await sleep(300);
  await ev(fakeCalls([['web__fetch_page', { url: 'https://example.org/' }], ['web__fetch_page', { url: 'https://example.com/' }]]));
  // The final answer becomes the report.
  await ev(`(() => { const r = { role: 'assistant', content: 'Plan: look.\\n\\n# Zebra report\\n\\nZebras have stripes [1].', model: state.chat.model, t: Date.now() }; state.chat.messages.push(r); hooks.onReply(r, state.chat); return 1; })()`);
  await sleep(500);
  ok('the report opens as a Markdown artifact', (await ev(`!document.querySelector('#artifact').hidden && document.querySelector('#artMeta').textContent === 'markdown' && document.querySelector('#artTitle').textContent === 'Zebra report'`)) === true, await ev(`document.querySelector('#artTitle').textContent`));
  const rep = await ev(`state.art.list[state.art.i].code`);
  ok('the report gets a source list with the numbers of the pages', /## Sources\n\[1\] .*https:\/\/example\.org\/\n\[2\] .*https:\/\/example\.com\//.test(rep), rep);
  ok('the plan before the title is not part of the report', !/Plan: look/.test(rep) && rep.startsWith('# Zebra report'));
  ok('the run is over', (await ev(`rs.run.ended && document.querySelector('#researchBar').hidden`)) === true);
  await ev(`closeArtifact(); 1`);

  // ---- 5. a real research run ----------------------------------------------------------
  {
    await ev(`newChat(); 1`);
    await sleep(300);
    await ev(`document.querySelector('#researchBtn').click(); send('Search for "Lumen Zebra Handbook", read the pages the search finds, and report what those pages say they are for.'); 1`);
    const asked = await waitFor(`document.querySelector('#researchDlg').open`, 15000);
    ok('the real run asks first', asked, await ev(`JSON.stringify({ armed: rs.armed, streaming: !!state.streaming, busy: state.toolsBusy, msgs: state.chat.messages.length })`));
    const before = await ev(`rs.run`);
    await ev(`window.__oldRun = rs.run; document.querySelector('#researchYes').click(); 1`);
    await sleep(500);
    ok('… and starts a new run', (await ev(`!!rs.run && rs.run !== window.__oldRun && !rs.run.ended`)) === true);
    const t0 = Date.now();
    const done = await waitFor(`!!rs.run && rs.run !== window.__oldRun && rs.run.ended && !state.streaming && !state.toolsBusy`, 7 * 60 * 1000);
    const stats = await ev(`JSON.stringify({ searches: rs.run.searches, pages: rs.run.pages, sources: rs.run.sources.map((s) => s.url) })`);
    ok('the research run ends with a report', done, `${Math.round((Date.now() - t0) / 1000)} s ${stats}`);
    ok('the model searched (through the fake SearXNG)', (await ev(`rs.run.searches`)) >= 1 && /zebra/i.test(lastQ()), lastQ());
    ok('the model read real pages', (await ev(`rs.run.pages`)) >= 1, stats);
    ok('the budget held', (await ev(`rs.run.searches <= 8 && rs.run.pages <= 15`)) === true);
    const art = await ev(`!document.querySelector('#artifact').hidden && document.querySelector('#artMeta').textContent`);
    ok('the report is open as a Markdown artifact', art === 'markdown', String(art));
    const report = await ev(`(state.art.list[state.art.i] || {}).code || ''`);
    ok('the report has a source list with the pages it read', /## Sources/i.test(report) && /example\.(org|com)/.test(report.slice(report.search(/## Sources/i))), report.slice(-300));
    ok('the report cites its sources with numbers', /\[\d+\]/.test(report.slice(0, Math.max(0, report.search(/## Sources/i)))), report.slice(0, 300));
    ok('the report was saved with the chat', /```markdown/.test((await call('GET', '/api/chats/' + await ev(`state.chat.id`))).json.messages.at(-1).content));
  }
  await call('PUT', '/api/settings', { web: { enabled: false, provider: '', searxngUrl: '' } });
  h.close();
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
