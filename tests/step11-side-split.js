// Step 11 — side chat and split view.
// The two panes are two iframes in the one test page: two independent JS states, one
// server, one origin. The main window is the first pane (a normal Lumen), the second
// pane is Lumen itself in the embed mode ("/?embed=1").
const { launch, sleep } = require('./lib/cdplib');

const BASE = process.env.LUMEN_URL || 'http://localhost:3101';
const MODEL = process.env.LUMEN_TEST_MODEL || 'gemma4:latest';
// The CDP helpers live in the harness; the pane helpers below need them, so the
// handle is kept here and filled in when the browser starts.
let ev = null;

// An API call from Node. The server answers on localhost, so it goes through the same
// guard() as the browser.
async function call(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json' },
    // fetch refuses a body on GET.
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const CONTAINER = `<!doctype html><html><head><meta charset="utf-8"><title>step 11</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{width:50%;height:100%;border:0;border-right:1px solid #ccc;float:left}</style>
</head><body>
<iframe id="paneA" src="/"></iframe>
<iframe id="paneB" src="/?embed=1"></iframe>
</body></html>`;

// Run an expression inside a pane. The panes are same-origin, so the test page can use
// the window of the frame directly. The app's own state is a global *lexical* binding
// (a top-level const), so it is read with eval() and never as a property of window.
async function pEval(id, expr) {
  return await ev(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el || !el.contentWindow) return 'NOWINDOW';
    try { return el.contentWindow.eval(${JSON.stringify(expr)}); }
    catch (e) { return 'EXC ' + (e && e.message); }
  })()`);
}
const pBool = async (id, expr) => (await pEval(id, expr)) === true;
const pText = async (id, expr) => { const v = await pEval(id, expr); return v === undefined || v === null ? '' : String(v); };
// The same, but for the frame of the side chat inside the first pane.
async function sideEval(expr) {
  return await ev(`(() => {
    const host = document.getElementById('paneA').contentDocument;
    const f = host && host.querySelector('#sideFrame');
    if (!f || !f.contentWindow) return 'NOFRAME';
    try { return f.contentWindow.eval(${JSON.stringify(expr)}); }
    catch (e) { return 'EXC ' + (e && e.message); }
  })()`);
}
const sideBool = async (expr) => (await sideEval(expr)) === true;
const sideText = async (expr) => { const v = await sideEval(expr); return v === undefined || v === null ? '' : String(v); };

async function until(fn, ms = 20000, every = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(every); }
  return false;
}
// A pane is ready when its app has booted (the model list is there and a chat is open).
async function paneReady(id, ms = 30000) {
  return await until(async () => await pBool(id, "!!(state && state.models && state.models.length && state.chat)"), ms, 250);
}
// Wait for the turn of a pane to be over. The model may ask to use a skill (the starter
// skills are in the system prompt): the approval card is answered like a user would
// answer it ("Allow once") and the turn goes on.
async function finishTurn(id, ms = 180000) {
  const end = Date.now() + ms;
  let idle = 0;
  while (Date.now() < end) {
    if (await pBool(id, "!!document.querySelector('.toolcall.awaiting')")) {
      idle = 0;
      await pEval(id, "(() => { const b = document.querySelector('.toolcall.awaiting [data-tc=once]'); if (b) b.click(); return 1; })()");
      await sleep(600);
      continue;
    }
    if (await pBool(id, "!state.streaming && !state.toolsBusy")) { if (++idle >= 4) return true; } else idle = 0;
    await sleep(250);
  }
  return false;
}
async function sideFinishTurn(ms = 180000) {
  const end = Date.now() + ms;
  let idle = 0;
  while (Date.now() < end) {
    if (await sideBool("!!document.querySelector('.toolcall.awaiting')")) {
      idle = 0;
      await sideEval("(() => { const b = document.querySelector('.toolcall.awaiting [data-tc=once]'); if (b) b.click(); return 1; })()");
      await sleep(600);
      continue;
    }
    if (await sideBool("!state.streaming && !state.toolsBusy")) { if (++idle >= 4) return true; } else idle = 0;
    await sleep(250);
  }
  return false;
}
// Send a message in a pane and wait for the answer.
async function paneAsk(id, question, ms = 180000) {
  await pEval(id, `send(${JSON.stringify(question)}); 1`);
  await sleep(600);
  await finishTurn(id, ms);
  await until(async () => await pBool(id, "(() => { const m = state.chat.messages.at(-1) || {}; return m.role === 'assistant' && !!((m.content||'').trim()); })()"), ms, 300);
  return await pText(id, "((state.chat.messages.at(-1)||{}).content || '')");
}

(async () => {
  const h = await launch(BASE, 9350);
  const { ok, cmd, shot } = h;
  ev = h.ev;

  // ---- the two panes --------------------------------------------------------
  const tree = await cmd('Page.getFrameTree');
  await cmd('Page.setDocumentContent', { frameId: tree.result.frameTree.frame.id, html: CONTAINER });
  await sleep(1500);
  const aUp = await paneReady('paneA');
  const bUp = await paneReady('paneB');
  ok('both panes start', aUp && bUp, `A:${aUp} B:${bUp}`);
  if (!aUp || !bUp) { h.close(); return; }

  // The model is pinned in every pane, so no prompt goes to a cloud model.
  for (const id of ['paneA', 'paneB']) {
    await pEval(id, `localStorage.setItem('lumen.model', ${JSON.stringify(MODEL)})`);
    await pEval(id, `(() => { const s = document.querySelector('#modelSelect'); s.value = ${JSON.stringify(MODEL)}; s.dispatchEvent(new Event('change')); return 1; })()`);
  }
  ok('the model is pinned in the first pane', (await pText('paneA', "document.querySelector('#modelSelect').value")) === MODEL);
  ok('the model is pinned in the second pane', (await pText('paneB', "document.querySelector('#modelSelect').value")) === MODEL);

  // ---- 1. the embed mode -----------------------------------------------------
  ok('the second pane is in the embed mode', await pBool('paneB', "document.body.classList.contains('embed')"));
  ok('the embed pane has no sidebar', await pBool('paneB', "getComputedStyle(document.querySelector('#sidebar')).display === 'none'"));
  ok('the embed pane has a compact header', await pBool('paneB', "document.querySelector('header').classList.contains('compact')"));
  ok('the main window still has a sidebar', await pBool('paneA', "getComputedStyle(document.querySelector('#sidebar')).display !== 'none'"));
  ok('the main window still has a normal header', await pBool('paneA', "!document.querySelector('header').classList.contains('compact')"));
  const headA = Number(await pText('paneA', "document.querySelector('header').offsetHeight"));
  const headB = Number(await pText('paneB', "document.querySelector('header').offsetHeight"));
  ok('the header of the embed pane is shorter than the one of the main window', headB > 0 && headB < headA, `${headB} vs ${headA}`);
  // The artifact preview keeps its opaque origin — the embed pane is a different thing.
  ok('the artifact preview keeps its sandbox without the same origin',
    (await pText('paneA', "document.querySelector('#artFrame').getAttribute('sandbox')")) === 'allow-scripts allow-forms');

  // ---- 2. the split view -----------------------------------------------------
  const hasSplit = await pBool('paneA', "!!document.querySelector('#splitBtn')");
  ok('the main window has a split view button', hasSplit);
  if (hasSplit) {
    await pEval('paneA', "document.querySelector('#splitBtn').click(); 1");
    await sleep(1200);
    const splitSrc = await pText('paneA', "document.querySelector('#splitFrame').getAttribute('src')");
    ok('the split pane is Lumen itself', /embed=1/.test(splitSrc), splitSrc);
    ok('the split pane is not sandboxed (it is Lumen, not an artifact)', (await pEval('paneA', "document.querySelector('#splitFrame').getAttribute('sandbox')")) === null);
    const splitUp = await until(async () => await pBool('paneA', "!!document.querySelector('#splitFrame').contentWindow && !!document.querySelector('#splitFrame').contentWindow.eval('!!state')"), 15000);
    ok('the split pane is a running Lumen', splitUp);
  }

  // ---- 3. two panes stream independently ------------------------------------
  const MARK_A = 'PANEONE' + Date.now();
  const MARK_B = 'PANETWO' + Date.now();
  await pEval('paneA', `send(${JSON.stringify('Say one short sentence about the sea. The marker of this message is ' + MARK_A + '.')}); 1`);
  await until(async () => await pBool('paneA', "!!state.streaming"), 20000, 100);
  await pEval('paneB', `send(${JSON.stringify('Say one short sentence about the moon. The marker of this message is ' + MARK_B + '.')}); 1`);
  let bothStreaming = false;
  const bothEnd = Date.now() + 40000;
  while (Date.now() < bothEnd) {
    if (await pBool('paneA', "!!state.streaming") && await pBool('paneB', "!!state.streaming")) { bothStreaming = true; break; }
    await sleep(120);
  }
  ok('both panes can have a reply in flight at the same time', bothStreaming);
  await finishTurn('paneA');
  await finishTurn('paneB');
  const aMsgs = await pText('paneA', "JSON.stringify(state.chat.messages.map(m => (m.role||'') + ':' + (m.content||'').slice(0,300)))");
  const bMsgs = await pText('paneB', "JSON.stringify(state.chat.messages.map(m => (m.role||'') + ':' + (m.content||'').slice(0,300)))");
  ok('the first pane has an answer of the assistant', /assistant:/.test(aMsgs), aMsgs.slice(0, 200));
  ok('the second pane has an answer of the assistant', /assistant:/.test(bMsgs), bMsgs.slice(0, 200));
  ok('the message of the first pane does not appear in the second pane', !bMsgs.includes(MARK_A), bMsgs.slice(0, 300));
  ok('the message of the second pane does not appear in the first pane', !aMsgs.includes(MARK_B), aMsgs.slice(0, 300));
  // The markers are in the prompts of the panes themselves.
  ok('the first pane holds its own message', (await pText('paneA', "state.chat.messages[0].content")).includes(MARK_A),
    (await pText('paneA', "state.chat.messages[0].content")).slice(0, 120));
  ok('the second pane holds its own message', (await pText('paneB', "state.chat.messages[0].content")).includes(MARK_B),
    (await pText('paneB', "state.chat.messages[0].content")).slice(0, 120));

  // ---- 4. the side chat ------------------------------------------------------
  const hasSide = await pBool('paneA', "!!document.querySelector('#sideChatBtn')");
  ok('the main window has a side chat button', hasSide);
  let mainId = '', beforeMsgs = '[]', beforeMeta = '';
  if (hasSide) {
    mainId = await pText('paneA', "state.chat.id");
    ok('the main chat is saved and has an id', !!mainId && mainId !== 'undefined', String(mainId));
    const before = await call('GET', '/api/chats/' + mainId);
    beforeMsgs = JSON.stringify((before.json || {}).messages || []);
    beforeMeta = JSON.stringify({ t: (before.json || {}).title, m: (before.json || {}).model, s: (before.json || {}).system, p: (before.json || {}).project });

    await pEval('paneA', "document.querySelector('#sideChatBtn').click(); 1");
    const sideUp = await until(async () => await sideBool("!!(state && state.chat)"), 25000);
    ok('the side chat opens in a pane of its own', sideUp);
    const sideId = await sideText("state.chat.id");
    ok('the side chat is a chat record of its own', !!sideId && sideId !== 'undefined' && sideId !== mainId, `${sideId} vs ${mainId}`);
    const sideSrc = await pText('paneA', "document.querySelector('#sideFrame').getAttribute('src')");
    ok('the side chat runs in the embed mode', /embed=1/.test(sideSrc), sideSrc);
    ok('the side chat is not sandboxed (it is Lumen, not an artifact)', (await pEval('paneA', "document.querySelector('#sideFrame').getAttribute('sandbox')")) === null);

    // A question in the side chat.
    await sideEval(`send(${JSON.stringify('What is the capital of France? Answer with one word.')}); 1`);
    await sleep(600);
    await sideFinishTurn();
    const sideRec = await call('GET', '/api/chats/' + sideId);
    const sideMsgs = (sideRec.json || {}).messages || [];
    const answer = [...sideMsgs].reverse().find((m) => m.role === 'assistant' && (m.content || '').trim());
    ok('the side chat has an answer of the assistant', !!answer, JSON.stringify(sideMsgs.map((m) => m.role)));

    // The main chat is untouched.
    const after = await call('GET', '/api/chats/' + mainId);
    ok('the messages of the main chat are byte-for-byte the same', JSON.stringify((after.json || {}).messages || []) === beforeMsgs);
    const afterMeta = JSON.stringify({ t: (after.json || {}).title, m: (after.json || {}).model, s: (after.json || {}).system, p: (after.json || {}).project });
    ok('the title, the model and the project of the main chat are the same', afterMeta === beforeMeta, afterMeta + ' vs ' + beforeMeta);

    // ---- 5. insert into chat -------------------------------------------------
    const hasInsert = await pBool('paneA', "!!document.querySelector('#sideInsert')");
    ok('the side chat has an "insert into chat" button', hasInsert);
    if (hasInsert && answer) {
      await pEval('paneA', "document.querySelector('#sideInsert').click(); 1");
      await until(async () => {
        const c = await call('GET', '/api/chats/' + mainId);
        return ((c.json || {}).messages || []).length > JSON.parse(beforeMsgs).length;
      }, 15000, 400);
      const main2 = await call('GET', '/api/chats/' + mainId);
      const msgs = (main2.json || {}).messages || [];
      const last = msgs[msgs.length - 1] || {};
      ok('the insert puts a message into the main chat', msgs.length === JSON.parse(beforeMsgs).length + 1, `${msgs.length}`);
      ok('the inserted message is a message of the user', last.role === 'user', String(last.role));
      ok('the inserted message carries the marker of the side chat', /^\[Side chat\]/.test(last.content || ''), String(last.content || '').slice(0, 120));
      ok('the inserted message holds the answer of the side chat', (last.content || '').includes((answer.content || '').slice(0, 30)),
        String(last.content || '').slice(0, 200));
      ok('the messages of the main chat are still there', JSON.stringify(msgs.slice(0, JSON.parse(beforeMsgs).length)) === beforeMsgs);
    }
  }

  // ---- 6. the snapshot of the side chat is bounded ----------------------------
  if (hasSide) {
    // A long conversation in the main chat (in the memory of the pane only).
    await pEval('paneA', `(() => {
      for (let i = 0; i < 40; i++) state.chat.messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'FILLER' + i + ' ' + 'x'.repeat(1500) });
      return 1;
    })()`);
    const oldSide = await sideText("state.chat.id");
    await pEval('paneA', "document.querySelector('#sideChatBtn').click(); 1");
    let newSide = '';
    const gotSide = await until(async () => {
      const id = await sideText("state.chat.id");
      if (id && id !== oldSide) { newSide = id; return true; }
      return false;
    }, 25000, 300);
    ok('a second side chat opens', !!newSide, String(newSide));
    if (newSide) {
      const rec = await call('GET', '/api/chats/' + newSide);
      const seed = ((rec.json || {}).messages || [])[0] || {};
      const text = seed.content || '';
      ok('the side chat is seeded with a message of the user', seed.role === 'user', String(seed.role));
      ok('the seed says that it is a snapshot', /snapshot/i.test(text), text.slice(0, 160));
      ok('the seed shows the cap', /20/.test(text) && /20,?000/.test(text), text.slice(0, 240));
      ok('the seed says that this is a side question and asks for a brief answer',
        /side question/i.test(text) && /brief/i.test(text), text.slice(0, 240));
      const block = text.split('--- begin snapshot ---')[1] || '';
      const lines = block.split('--- end snapshot ---')[0].split('\n').filter((l) => /^\[(You|Assistant)\]:/.test(l));
      ok('the snapshot holds at most 20 messages', lines.length > 0 && lines.length <= 20, String(lines.length));
      ok('the seed is at most 20,000 characters', text.length <= 20000, String(text.length));
    }
  }

  // ---- 7. the sidebar of one pane follows the other --------------------------
  {
    const title = 'REFRESH' + Date.now();
    await pEval('paneA', "newChat(); 1");
    await pEval('paneA', `send(${JSON.stringify(title + ' a question for a new chat')}); 1`);
    await finishTurn('paneA');
    // The chat of the pane, by its id — the title of a chat is written by the model
    // after the first answer, so the id is the stable name of the chat.
    const freshId = await pText('paneA', "state.chat.id");
    const seen = await until(async () => await pBool('paneB',
      `(state.chats || []).some((c) => c.id === ${JSON.stringify(freshId)})`), 20000, 400);
    ok('a chat created in one pane shows up in the list of the other pane', seen,
      'id=' + freshId + ' posts=' + (await pText('paneA', 'JSON.stringify(window.__lumenPosts)')).slice(-300) +
      ' rxB=' + (await pText('paneB', 'window.__lumenRx')) +
      ' projB=' + (await pText('paneB', 'String(state.project)')) +
      ' listB=' + (await pText('paneB', "JSON.stringify((state.chats||[]).map(c=>c.id))")).slice(0, 300));
    // And the other way round: the embed pane creates a chat, the main window sees it.
    const title2 = 'REVERSE' + Date.now();
    await pEval('paneB', "newChat(); 1");
    await pEval('paneB', `send(${JSON.stringify(title2 + ' a question from the second pane')}); 1`);
    await finishTurn('paneB');
    const freshId2 = await pText('paneB', "state.chat.id");
    const seen2 = await until(async () => await pBool('paneA',
      `(state.chats || []).some((c) => c.id === ${JSON.stringify(freshId2)})`), 20000, 400);
    ok('a chat created in the second pane shows up in the list of the first pane', seen2,
      'id=' + freshId2 + ' posts=' + (await pText('paneB', 'JSON.stringify(window.__lumenPosts)')).slice(-300) +
      ' rxA=' + (await pText('paneA', 'window.__lumenRx')));
    // The list of the other pane is on the screen too, not only in the state.
    ok('the list of the other pane shows the new chat',
      (await pText('paneB', "document.querySelector('#chatList').textContent")).length > 0);
  }

  // ---- 8. no loop -------------------------------------------------------------
  {
    const rxA0 = Number(await pText('paneA', "window.__lumenRx || 0"));
    const rxB0 = Number(await pText('paneB', "window.__lumenRx || 0"));
    await sleep(4000);
    const rxA1 = Number(await pText('paneA', "window.__lumenRx || 0"));
    const rxB1 = Number(await pText('paneB', "window.__lumenRx || 0"));
    ok('the panes do not spin', (rxA1 - rxA0) <= 2 && (rxB1 - rxB0) <= 2, `A:${rxA1 - rxA0} B:${rxB1 - rxB0}`);
    ok('the panes still answer', (await pBool('paneA', "!state.streaming")) && (await pBool('paneB', "!state.streaming")));
  }

  // ---- 9. a chat that does not exist ----------------------------------------
  {
    await ev(`(() => {
      const f = document.createElement('iframe');
      f.id = 'paneC';
      f.src = '/?embed=1&chat=this-chat-does-not-exist';
      document.body.appendChild(f);
      return 1;
    })()`);
    const cUp = await until(async () => await pBool('paneC', "!!(state && state.chat)"), 30000, 250);
    ok('a pane with a chat that does not exist still starts', cUp);
    const cMsgs = await pText('paneC', "(state.chat ? String(state.chat.messages.length) : 'no chat')");
    ok('the pane falls back to the empty state', cMsgs === '0', cMsgs);
    const cId = await pText('paneC', "String(state.chat && state.chat.id)");
    ok('the pane has no chat of its own', cId === 'null' || cId === 'undefined' || cId === '', cId);
  }

  // ---- 10. the temporary chat rule in a pane ---------------------------------
  {
    // A memory of the user: a pane that is not temporary must use it.
    await call('POST', '/api/memories', { text: 'The user likes short answers' });
    await pEval('paneC', "loadSettings(); 1");
    await sleep(800);
    const usedNormal = await pText('paneC', "memoryPrompt()");
    ok('a pane knows the memory of the user', /short answers/.test(usedNormal), usedNormal.slice(0, 80));
    // Temporary: the memory is never used and nothing is saved.
    await pEval('paneC', "(() => { const t = document.querySelector('#tempToggle'); t.checked = true; t.dispatchEvent(new Event('change')); return 1; })()");
    ok('a temporary pane does not use the memory of the user', (await pText('paneC', "memoryPrompt()")) === '');
    const chatsBefore = ((await call('GET', '/api/chats')).json || []).length;
    await pEval('paneC', "send('Say one short sentence about a river.'); 1");
    await sleep(600);
    await finishTurn('paneC');
    const cId2 = await pText('paneC', "String(state.chat && state.chat.id)");
    ok('a temporary pane saves nothing', cId2 === 'null' || cId2 === 'undefined' || cId2 === '', cId2);
    const chatsAfter = ((await call('GET', '/api/chats')).json || []).length;
    ok('the server has no new chat of the temporary pane', chatsAfter === chatsBefore, `${chatsBefore} -> ${chatsAfter}`);
  }

  await shot('step11-side-split');
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
