// Step 11 — side chat and split view.
//
// The main window is the page of the test: a normal Lumen. The split pane and the
// side chat are iframes of that page — the app makes them itself, so the test drives
// the real thing: the same origin, no sandbox, a full user of the app.
const { launch, sleep } = require('./lib/cdplib');

const BASE = process.env.LUMEN_URL || 'http://localhost:3101';
const MODEL = process.env.LUMEN_TEST_MODEL || 'gemma4:latest';
// The CDP helpers live in the harness; the frame helpers below need them, so the
// handle is kept here and filled in when the browser starts.
let ev = null;
let cmd = null;

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

// Run an expression inside a frame of the main window (the split pane, the side
// chat, a pane the test makes itself). The frames are same-origin, so the test can
// use their window directly. The state of the app is a global *lexical* binding (a
// top-level const), so it is read with eval() and never as a property of window.
async function frameEval(sel, expr) {
  return await ev(`(() => {
    const f = document.querySelector(${JSON.stringify(sel)});
    if (!f || !f.contentWindow) return 'NOFRAME';
    try { return f.contentWindow.eval(${JSON.stringify(expr)}); }
    catch (e) { return 'EXC ' + (e && e.message); }
  })()`);
}
const frameBool = async (sel, expr) => (await frameEval(sel, expr)) === true;
const frameText = async (sel, expr) => { const v = await frameEval(sel, expr); return v === undefined || v === null ? '' : String(v); };
// The window of the app itself: in this test the page IS the app (the panes are its
// own frames). The step that checks the stamps of the server needs the app of the
// user, not a pane.
const appEval = (expr) => ev(expr);
const appReload = () => cmd('Page.reload');

async function until(fn, ms = 20000, every = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(every); }
  return false;
}
// A frame is ready when its app has booted (the model list is there and a chat is open).
async function frameReady(sel, ms = 30000) {
  return await until(async () => await frameBool(sel, "!!(state && state.models && state.models.length && state.chat)"), ms, 250);
}
// Wait for the turn of a frame to be over. The model may ask to use a skill (the
// starter skills are in the system prompt): the approval card is answered like a user
// would answer it ("Allow once") and the turn goes on.
async function frameFinish(sel, ms = 180000) {
  const end = Date.now() + ms;
  let idle = 0;
  while (Date.now() < end) {
    if (await frameBool(sel, "!!document.querySelector('.toolcall.awaiting')")) {
      idle = 0;
      await frameEval(sel, "(() => { const b = document.querySelector('.toolcall.awaiting [data-tc=once]'); if (b) b.click(); return 1; })()");
      await sleep(600);
      continue;
    }
    if (await frameBool(sel, "!state.streaming && !state.toolsBusy")) { if (++idle >= 4) return true; } else idle = 0;
    await sleep(250);
  }
  return false;
}
// Send a message in a frame and wait for the answer.
async function frameAsk(sel, question, ms = 180000) {
  await frameEval(sel, `send(${JSON.stringify(question)}); 1`);
  await sleep(600);
  await frameFinish(sel, ms);
  await until(async () => await frameBool(sel, "(() => { const m = state.chat.messages.at(-1) || {}; return m.role === 'assistant' && !!((m.content||'').trim()); })()"), ms, 300);
  return await frameText(sel, "((state.chat.messages.at(-1)||{}).content || '')");
}
const msgList = "JSON.stringify((state.chat ? state.chat.messages : []).map(m => (m.role||'') + ':' + (m.content||'').slice(0,300)))";

(async () => {
  const h = await launch(BASE, 9350);
  const { ok, shot } = h;
  ev = h.ev;
  cmd = h.cmd;

  // ---- the app starts --------------------------------------------------------
  const up = await until(async () => await ev(`!!(state && state.models && state.models.length && state.chat)`), 30000, 250);
  ok('the app starts', up);
  if (!up) { h.close(); return; }
  // The model of the user is in the localStorage, so every pane of the app (the same
  // origin) shows the same model.
  await ev(`localStorage.setItem('lumen.model', ${JSON.stringify(MODEL)})`);

  // The chats the test works with. They carry the model, so a pane that opens one
  // shows the model of the user.
  const mkChat = async (title) => {
    const r = await call('POST', '/api/chats', { title, model: MODEL, system: '', style: '', project: null, messages: [] });
    return (r.json || {}).id || '';
  };
  const chatA = await mkChat('Chat A');
  const chatB = await mkChat('Chat B');
  ok('the test has two chats of the user', !!chatA && !!chatB && chatA !== chatB, `${chatA} ${chatB}`);

  // The main window opens one of them.
  await ev(`openChat(${JSON.stringify(chatB)}); 1`);
  await until(async () => await ev(`state.chat && state.chat.id === ${JSON.stringify(chatB)}`), 15000, 200);
  ok('the main window has a chat of its own', (await ev(`state.chat.id`)) === chatB, String(await ev(`state.chat.id`)));

  // ---- 1. the split view -----------------------------------------------------
  await ev(`document.querySelector('#splitBtn').click(); 1`);
  const paneUp = await frameReady('#splitFrame');
  ok('the split pane starts', paneUp);
  const src = String(await ev(`document.querySelector('#splitFrame').getAttribute('src')`));
  ok('the split pane is Lumen itself in the embed mode', /[?&]embed=1(&|$)/.test(src), src);
  const mm = /[?&]chat=([^&]+)/.exec(src);
  const paneChat = mm ? decodeURIComponent(mm[1]) : '';
  ok('the address of the pane names a chat', !!paneChat, src);
  // The chat of the pane must be a real chat of the user, and the most recent one
  // that the main window does not have open. The list of the server puts the pinned
  // chats first, so the order of the list is not the order of the chats: the stamp
  // decides which chat the pane gets.
  const userChats = (await call('GET', '/api/chats')).json || [];
  ok('the chat of the pane is a chat of the user', userChats.some((c) => c.id === paneChat), `${paneChat} vs ${chatA}`);
  ok('the chat of the pane is the most recent chat that the main window does not have open', paneChat === chatA, `${paneChat} vs ${chatA}`);
  ok('the chat of the pane is not the chat of the main window', !!paneChat && paneChat !== chatB, `${paneChat} vs ${chatB}`);
  ok('the pane has the chat of its address', (await frameText('#splitFrame', 'String(state.chat && state.chat.id)')) === paneChat,
    await frameText('#splitFrame', 'String(state.chat && state.chat.id)'));
  ok('the split pane is not sandboxed (it is Lumen, not an artifact)',
    (await ev(`document.querySelector('#splitFrame').getAttribute('sandbox')`)) === null);

  // ---- 2. the embed mode -----------------------------------------------------
  ok('the pane is in the embed mode', await frameBool('#splitFrame', "document.body.classList.contains('embed')"));
  ok('the pane has no sidebar', await frameBool('#splitFrame', "getComputedStyle(document.querySelector('#sidebar')).display === 'none'"));
  ok('the main window has a sidebar', await ev(`getComputedStyle(document.querySelector('#sidebar')).display !== 'none'`));
  ok('the pane has no tab strip', await frameBool('#splitFrame', "getComputedStyle(document.querySelector('#tabStrip')).display === 'none'"));
  ok('the main window has a normal header', await ev(`!document.querySelector('header').classList.contains('compact')`));
  // The artifact preview keeps its opaque origin — the embed pane is a different thing.
  ok('the artifact preview keeps its sandbox without the same origin',
    (await ev(`document.querySelector('#artFrame').getAttribute('sandbox')`)) === 'allow-scripts allow-forms');

  // ---- 3. the picker of the pane ---------------------------------------------
  const pickerFilled = await until(async () => {
    const o = await frameText('#splitFrame', "JSON.stringify([...document.querySelectorAll('#embedChatSel option')].map(o => o.value))");
    return o !== '[]' && !o.includes(chatB);
  }, 20000, 300);
  const opts = await frameText('#splitFrame', "JSON.stringify([...document.querySelectorAll('#embedChatSel option')].map(o => o.value))");
  ok('the picker of the pane is filled', pickerFilled && opts !== '[]', opts);
  ok('the picker does not offer the chat of the main window', !opts.includes(chatB), opts);
  ok('the picker offers the chat of the pane', opts.includes(paneChat), opts);

  // ---- 4. the model of the pane ----------------------------------------------
  const paneModel = await frameText('#splitFrame', "document.querySelector('#modelSelect').value");
  ok('the pane shows the model of the user', paneModel === MODEL, paneModel);
  ok('the model of the pane is not empty', !!paneModel, paneModel);

  // ---- 5. two panes stream independently -------------------------------------
  const MARK_A = 'PANEONE' + Date.now();
  const MARK_B = 'PANETWO' + Date.now();
  await ev(`send(${JSON.stringify('Say one short sentence about the sea. The marker of this message is ' + MARK_A + '.')}); 1`);
  await until(async () => await ev(`!!state.streaming`), 20000, 100);
  await frameEval('#splitFrame', `send(${JSON.stringify('Say one short sentence about the moon. The marker of this message is ' + MARK_B + '.')}); 1`);
  let bothStreaming = false;
  const bothEnd = Date.now() + 40000;
  while (Date.now() < bothEnd) {
    if (await ev(`!!state.streaming`) && await frameBool('#splitFrame', '!!state.streaming')) { bothStreaming = true; break; }
    await sleep(120);
  }
  ok('both panes can have a reply in flight at the same time', bothStreaming);
  await h.finishTurn();
  await frameFinish('#splitFrame');
  const aMsgs = String(await ev(msgList));
  const bMsgs = await frameText('#splitFrame', msgList);
  ok('the main window has an answer of the assistant', /assistant:/.test(aMsgs), aMsgs.slice(0, 200));
  ok('the pane has an answer of the assistant', /assistant:/.test(bMsgs), bMsgs.slice(0, 200));
  ok('the message of the main window is not in the pane', !bMsgs.includes(MARK_A), bMsgs.slice(0, 300));
  ok('the message of the pane is not in the main window', !aMsgs.includes(MARK_B), aMsgs.slice(0, 300));
  ok('the main window holds its own message', aMsgs.includes(MARK_A), aMsgs.slice(0, 200));
  ok('the pane holds its own message', bMsgs.includes(MARK_B), bMsgs.slice(0, 200));

  // ---- 6. the side chat ------------------------------------------------------
  const mainId = String(await ev(`state.chat.id`));
  ok('the main chat is saved and has an id', !!mainId && mainId !== 'undefined', mainId);
  const before = await call('GET', '/api/chats/' + mainId);
  const beforeMsgs = JSON.stringify((before.json || {}).messages || []);
  const beforeMeta = JSON.stringify({ t: (before.json || {}).title, m: (before.json || {}).model, s: (before.json || {}).system, p: (before.json || {}).project });

  await ev(`document.querySelector('#sideChatBtn').click(); 1`);
  const sideUp = await frameReady('#sideFrame');
  ok('the side chat opens in a pane of its own', sideUp);
  const sideId = await frameText('#sideFrame', 'String(state.chat && state.chat.id)');
  ok('the side chat is a chat record of its own', !!sideId && sideId !== 'undefined' && sideId !== mainId, `${sideId} vs ${mainId}`);
  const sideSrc = String(await ev(`document.querySelector('#sideFrame').getAttribute('src')`));
  ok('the side chat runs in the embed mode with the chat of its address', /[?&]embed=1(&|$)/.test(sideSrc) && sideSrc.includes(sideId), sideSrc);
  ok('the side chat is not sandboxed (it is Lumen, not an artifact)',
    (await ev(`document.querySelector('#sideFrame').getAttribute('sandbox')`)) === null);

  // A question in the side chat.
  await frameAsk('#sideFrame', 'What is the capital of France? Answer with one word.');
  const sideRec = await call('GET', '/api/chats/' + sideId);
  const sideMsgs = (sideRec.json || {}).messages || [];
  const answer = [...sideMsgs].reverse().find((m) => m.role === 'assistant' && (m.content || '').trim());
  ok('the side chat has an answer of the assistant', !!answer, JSON.stringify(sideMsgs.map((m) => m.role)));

  // The main chat is untouched.
  const after = await call('GET', '/api/chats/' + mainId);
  ok('the messages of the main chat are byte-for-byte the same', JSON.stringify((after.json || {}).messages || []) === beforeMsgs);
  const afterMeta = JSON.stringify({ t: (after.json || {}).title, m: (after.json || {}).model, s: (after.json || {}).system, p: (after.json || {}).project });
  ok('the title, the model and the project of the main chat are the same', afterMeta === beforeMeta, afterMeta + ' vs ' + beforeMeta);

  // ---- 7. insert into chat ---------------------------------------------------
  {
    const hasInsert = await ev(`!!document.querySelector('#sideInsert')`);
    ok('the side chat has an "insert into chat" button', hasInsert);
    if (hasInsert && answer) {
      await ev(`document.querySelector('#sideInsert').click(); 1`);
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

  // ---- 8. the snapshot of the side chat is bounded ----------------------------
  {
    // A long conversation in the main chat (in the memory of the window only).
    await ev(`(() => {
      for (let i = 0; i < 40; i++) state.chat.messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'FILLER' + i + ' ' + 'x'.repeat(1500) });
      return 1;
    })()`);
    const oldSide = await frameText('#sideFrame', 'String(state.chat && state.chat.id)');
    await ev(`document.querySelector('#sideChatBtn').click(); 1`);
    let newSide = '';
    const gotSide = await until(async () => {
      const id = await frameText('#sideFrame', 'String(state.chat && state.chat.id)');
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
      // The seed says how much of the snapshot is really in it.
      const said = /(\d+) of (\d+) messages and ([\d,]+) of ([\d,]+) characters are shown/.exec(text);
      ok('the seed says how much it shows', !!said, text.slice(0, 400));
      if (said) {
        ok('the number of the messages it says is the number it has', Number(said[1]) === lines.length, `${said[1]} vs ${lines.length}`);
        ok('the number of the characters it says is the number it has', Number(said[3].replace(/,/g, '')) === lines.join('\n').length,
          `${said[3]} vs ${lines.join('\n').length}`);
        ok('the seed says that it is not more than the cap', Number(said[2]) === 20 && Number(said[4].replace(/,/g, '')) === 20000, `${said[2]} ${said[4]}`);
      }
    }
  }

  // ---- 9. the list of the other pane follows ---------------------------------
  {
    const title = 'REFRESH' + Date.now();
    await ev(`fetch('/api/chats', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ title: ${JSON.stringify(title)}, model: ${JSON.stringify(MODEL)}, messages: [] }) }).then(r => r.json()); refreshChats(); 1`);
    const seen = await until(async () => (await frameText('#splitFrame', "document.querySelector('#chatList').textContent")).includes(title), 20000, 400);
    ok('a chat created in the main window shows up in the sidebar of the pane', seen,
      'list=' + (await frameText('#splitFrame', "document.querySelector('#chatList').textContent")).slice(0, 200));
    const offered = await until(async () => (await frameText('#splitFrame', "JSON.stringify([...document.querySelectorAll('#embedChatSel option')].map(o => o.textContent))")).includes(title), 20000, 400);
    ok('the picker of the pane offers the new chat', offered,
      'picker=' + (await frameText('#splitFrame', "JSON.stringify([...document.querySelectorAll('#embedChatSel option')].map(o => o.textContent))")).slice(0, 200));
  }

  // ---- 10. the panes do not spin ---------------------------------------------
  {
    // A real change in the main window: a new chat of the user. The pane refreshes
    // its list because of it — and must not answer that refresh: a post that is
    // caused by a refresh of another window is dropped, not sent back.
    await sleep(1500);   // let the posts of the earlier steps settle
    const rx0 = Number(await frameText('#splitFrame', 'window.__lumenRx || 0'));
    const posts0 = Number(await frameText('#splitFrame', '(window.__lumenPosts || []).length'));
    const title = 'NEWCHAT' + Date.now();
    await ev(`fetch('/api/chats', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ title: ${JSON.stringify(title)}, model: ${JSON.stringify(MODEL)}, messages: [] }) }).then(r => r.json()); refreshChats(); 1`);
    await sleep(2000);
    const rx1 = Number(await frameText('#splitFrame', 'window.__lumenRx || 0'));
    const posts1 = Number(await frameText('#splitFrame', '(window.__lumenPosts || []).length'));
    ok('the pane receives exactly one message of the change', rx1 - rx0 === 1, `${rx0} -> ${rx1}`);
    ok('the pane does not answer the change of the other window', posts1 === posts0, `${posts0} -> ${posts1}`);
    ok('the pane still answers', await frameBool('#splitFrame', '!state.streaming') && await ev(`!state.streaming`));
  }

  // ---- 11. two windows never share a chat ------------------------------------
  {
    // The main window opens the chat of the pane. The pane must let it go: the app
    // saves the whole list of the messages of a chat, so two windows on one chat take
    // each other's messages away.
    await ev(`openChat(${JSON.stringify(paneChat)}); 1`);
    const moved = await until(async () => (await frameText('#splitFrame', 'String(state.chat && state.chat.id)')) !== paneChat, 20000, 300);
    ok('the pane lets the chat go when the main window opens it', moved,
      await frameText('#splitFrame', 'String(state.chat && state.chat.id)'));
    // The main window writes in the chat — the message must survive on the server.
    const MARK_C = 'MAINWIN' + Date.now();
    await ev(`send(${JSON.stringify('Say one short sentence about the wind. The marker of this message is ' + MARK_C + '.')}); 1`);
    await h.finishTurn();
    const rec = await call('GET', '/api/chats/' + paneChat);
    const msgs = (rec.json || {}).messages || [];
    ok('the message of the main window survives on the server', msgs.some((m) => (m.content || '').includes(MARK_C)),
      JSON.stringify(msgs.map((m) => m.role)));
    const before = msgs.length;
    // The pane writes in a chat of its own now: the chat of the main window must not change.
    await frameAsk('#splitFrame', 'Say one short sentence about the wind.');
    const rec2 = await call('GET', '/api/chats/' + paneChat);
    ok('the pane does not write to the chat of the main window', ((rec2.json || {}).messages || []).length === before,
      `${before} -> ${((rec2.json || {}).messages || []).length}`);
  }

  // ---- 12. a chat of the main window is not taken by a pane -------------------
  {
    // The main window makes a chat of its own by writing in it: such a chat gets its
    // id only when it is saved, and no chat is opened. The pane must learn that the
    // chat is taken — otherwise the picker would offer it and the pane could open
    // it, and the two windows would take each other's messages away.
    await ev(`(() => { newChat(); state.chat.messages.push({ role: 'user', content: 'a chat of the main window' }); return persist(); })()`);
    const newId = String(await ev(`state.chat ? state.chat.id : ''`));
    ok('the main window made a chat of its own', !!newId && newId !== 'undefined' && newId !== 'null', newId);
    const optsOf = () => frameText('#splitFrame', "JSON.stringify([...document.querySelectorAll('#embedChatSel option')].map(o => o.value))");
    const notOffered = await until(async () => {
      const opts = await optsOf();
      return opts !== '[]' && !opts.includes(newId);
    }, 20000, 400);
    ok('the picker of the pane does not offer the new chat of the main window', notOffered, await optsOf());
    // And the pane refuses the chat even when the id is forced.
    const paneChatNow = await frameText('#splitFrame', 'String(state.chat && state.chat.id)');
    await frameEval('#splitFrame', `openChat(${JSON.stringify(newId)}); 1`);
    await sleep(1000);
    ok('the pane refuses the chat of the main window', (await frameText('#splitFrame', 'String(state.chat && state.chat.id)')) === paneChatNow,
      `${paneChatNow} -> ${await frameText('#splitFrame', 'String(state.chat && state.chat.id)')}`);
  }

  // ---- 13. a pane without a chat of its own -----------------------------------
  {
    await ev(`(() => {
      const f = document.createElement('iframe');
      f.id = 'paneC';
      f.src = '/?embed=1&chat=this-chat-does-not-exist';
      document.body.appendChild(f);
      return 1;
    })()`);
    const cUp = await frameReady('#paneC');
    ok('a pane with a chat that does not exist still starts', cUp);
    const cMsgs = await frameText('#paneC', "(state.chat ? String(state.chat.messages.length) : 'no chat')");
    ok('the pane falls back to the empty state', cMsgs === '0', cMsgs);
    const cId = await frameText('#paneC', 'String(state.chat && state.chat.id)');
    ok('the pane has no chat of its own', cId === 'null' || cId === 'undefined' || cId === '', cId);
    // The picker of a pane is filled in every case — also when the pane has no chat.
    const cOpts = await until(async () => {
      const o = await frameText('#paneC', "JSON.stringify([...document.querySelectorAll('#embedChatSel option')].map(o => o.value))");
      return o !== '[]' ? o : '';
    }, 20000, 400);
    ok('the picker of a pane without a chat is filled', !!cOpts, cOpts);

    // A pane with no chat in its address at all ('/?embed=1') — a thing a user can
    // open by hand: its picker must be filled too.
    await ev(`(() => {
      const f = document.createElement('iframe');
      f.id = 'paneD';
      f.src = '/?embed=1';
      document.body.appendChild(f);
      return 1;
    })()`);
    const dUp = await frameReady('#paneD');
    ok('a pane with no chat in its address starts', dUp);
    const dOpts = await until(async () => {
      const o = await frameText('#paneD', "JSON.stringify([...document.querySelectorAll('#embedChatSel option')].map(o => o.value))");
      return o !== '[]' ? o : '';
    }, 20000, 400);
    ok('the picker of a pane with no chat in its address is filled', !!dOpts, dOpts);
  }

  // ---- 14. the temporary chat rule in a pane ----------------------------------
  {
    // A memory of the user: a pane that is not temporary must use it.
    await call('POST', '/api/memories', { text: 'The user likes short answers' });
    await frameEval('#paneC', "loadSettings(); 1");
    await sleep(800);
    const usedNormal = await frameText('#paneC', "memoryPrompt()");
    ok('a pane knows the memory of the user', /short answers/.test(usedNormal), usedNormal.slice(0, 80));
    // Temporary: the memory is never used and nothing is saved.
    await frameEval('#paneC', "(() => { const t = document.querySelector('#tempToggle'); t.checked = true; t.dispatchEvent(new Event('change')); return 1; })()");
    ok('a temporary pane does not use the memory of the user', (await frameText('#paneC', "memoryPrompt()")) === '');
    const chatsBefore = ((await call('GET', '/api/chats')).json || []).length;
    await frameAsk('#paneC', 'Say one short sentence about a river.');
    const cId2 = await frameText('#paneC', 'String(state.chat && state.chat.id)');
    ok('a temporary pane saves nothing', cId2 === 'null' || cId2 === 'undefined' || cId2 === '', cId2);
    const chatsAfter = ((await call('GET', '/api/chats')).json || []).length;
    ok('the server has no new chat of the temporary pane', chatsAfter === chatsBefore, `${chatsBefore} -> ${chatsAfter}`);
  }

  // ---- 15. the tabs of a pane do not come back in the main window -------------
  {
    await ev(`document.querySelector('#sideChatBtn').click(); 1`);
    const sideUp2 = await frameReady('#sideFrame');
    const sideId2 = await frameText('#sideFrame', 'String(state.chat && state.chat.id)');
    ok('a side chat is open before the reload', sideUp2 && !!sideId2, sideId2);
    // The panes share the localStorage of the app: a pane that saved its tabs would
    // make the next reload of the main window come back on the chat of the pane.
    const saved = await ev(`localStorage.getItem('lumen.tabs') || ''`);
    ok('the pane did not write the tabs of the app', !saved.includes(sideId2), saved.slice(0, 200));
    // The main window is reloaded: the side chat must not be the chat it lands on.
    await ev(`window.__lumenTestMark = 1; 1`);
    await cmd('Page.reload');
    // The page must really be the new one: the mark of the old page is gone.
    await until(async () => String(await ev(`typeof window.__lumenTestMark`)) === 'undefined', 30000, 250);
    const backUp = await until(async () => await ev(`!!(state && state.chat)`), 30000, 250);
    ok('the main window comes back', backUp);
    await sleep(1200);   // the app restores its tabs and opens the active one
    const landed = String(await ev(`state.chat ? state.chat.id : ''`));
    ok('the main window does not come back on the chat of the side chat', landed !== sideId2, `${landed} vs ${sideId2}`);
  }

  // ---- 16. the stamps of the server are strictly increasing --------------------
  {
    // The clock of the server: 1000 calls in a tight loop must give 1000 strictly
    // increasing values. With Date.now() they are all the same millisecond — and
    // "the most recent chat" is then not well defined (the list of the chats is
    // sorted by the stamp, and a tie leaves the order of the sort to chance).
    const { nowStamp } = require('../stamp.js');
    const stamps = [];
    for (let i = 0; i < 1000; i++) stamps.push(nowStamp());
    let rising = true;
    for (let i = 1; i < stamps.length; i++) if (stamps[i] <= stamps[i - 1]) rising = false;
    ok('the clock of the server is strictly increasing', rising, `${new Set(stamps).size} different values of 1000`);

    // Two chats of the user, one right after the other, with no pause between them:
    // their stamps must not tie.
    const mk = async (title) => ((await call('POST', '/api/chats', { title, model: MODEL, system: '', style: '', project: null, messages: [] })).json || {}).id || '';
    const first = await mk('STAMP ONE');
    const second = await mk('STAMP TWO');
    const s1 = (await call('GET', '/api/chats/' + first)).json || {};
    const s2 = (await call('GET', '/api/chats/' + second)).json || {};
    ok('the stamps of two chats of the user do not tie', (s2.updated || 0) > (s1.updated || 0), `${s1.updated} -> ${s2.updated}`);

    // The app of the user must open the later chat ("continue last chat").
    await appEval(`localStorage.setItem('lumen.contLast', '1'); window.__lumenTestMark = 1; 1`);
    await appReload();
    // The page must really be the new one: the mark of the old page is gone.
    await until(async () => String(await appEval(`typeof window.__lumenTestMark`)) === 'undefined', 30000, 250);
    await until(async () => (await appEval(`!!(state && state.chat && state.chat.id)`)) === true, 30000, 250);
    const landed = String(await appEval(`state.chat ? state.chat.id : ''`));
    ok('the app opens the most recent chat of the user', landed === second, `${landed} vs ${second}`);
  }

  await shot('step11-side-split');
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
