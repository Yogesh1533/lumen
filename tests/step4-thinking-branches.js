const { launch, sleep } = require('./lib/cdplib');
(async () => {
  const h = await launch('http://localhost:3101', 9341);
  const { ev, ok, ask, waitFor, shot } = h;

  // ---- thinking block ----------------------------------------------------
  ok('thinking toggle visible for a reasoning model', !(await ev(`document.querySelector('#thinkWrap').hidden`)));
  // NB: a "one short sentence" prompt makes gemma4 skip its reasoning half the time (empty
  // `thinking` from Ollama even with think:true), so ask for a step-by-step explanation.
  // The model still skips it now and then, so try a few times before giving up.
  //
  // Two things are checked apart, because they are two different features:
  //   * the LIVE indicator: the block is open and marked "live" while the model thinks.
  //     It can be on screen for a very short time, so a MutationObserver watches the
  //     DOM instead of only polling it (polling can miss it).
  //   * the THINKING TEXT of the finished message (and its thinkMs).
  // The live indicator is never derived from the thinking text: a broken "live" class
  // has to fail the test. An attempt that shows neither is repeated (the model may
  // simply not have reasoned), but the two results are reported separately.
  const watchLive = `(() => {
    window.__sawLive = false;
    if (window.__thinkWatch) window.__thinkWatch.disconnect();
    window.__thinkWatch = new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        const hit = (el) => el.matches && el.matches('details.think.live[open]');
        if (hit(n) || (n.querySelector && n.querySelector('details.think.live[open]'))) window.__sawLive = true;
      }
    });
    window.__thinkWatch.observe(document.body, { childList: true, subtree: true });
    // The one and only source of truth for "the block was open and live": the DOM.
    // It never falls back to the thinking text of the finished message.
    window.__liveSeen = () => !!window.__sawLive || !!document.querySelector('details.think.live[open]');
    return 1;
  })()`;
  // The rule that decides "the block was open and live while the model thinks":
  // the live indicator alone. The thinking text of the finished message must never
  // stand in for it — otherwise a broken live indicator would go unnoticed.
  const liveVerdict = (live) => live;
  let sawLive = false;     // the block was open and live while the model was thinking
  let hasThinking = false; // the finished message carries the thinking text
  for (let attempt = 0; attempt < 3 && !hasThinking; attempt++) {
    await ev(watchLive);
    const before = await ev('state.chat.messages.length');
    await ev(`send('Explain step by step why the sky appears blue.'); 1`);
    let live = false;
    for (let i = 0; i < 600 && !live; i++) { await sleep(100); live = await ev(`!!window.__liveSeen()`); if (await ev(`!state.streaming && state.chat.messages.length >= ${before + 2}`)) break; }
    await waitFor(`!state.streaming && state.chat.messages.length >= ${before + 2}`, 180000); await sleep(1000);
    live = live || !!(await ev(`!!window.__liveSeen()`)); // the observer may have seen it after the last poll
    const thinking = !!String(await ev(`(state.chat.messages.at(-1) || {}).thinking || ''`)).trim();
    if (thinking) { hasThinking = true; sawLive = liveVerdict(live); } // the live check belongs to this answer
  }
  await ev(`if (window.__thinkWatch) { window.__thinkWatch.disconnect(); window.__thinkWatch = null; } 1`);
  ok('thinking block is open + live while the model thinks', sawLive);
  ok('the finished message keeps the thinking text', hasThinking);
  // The live check above must not be vacuous, and it must not be derived from the
  // thinking text. Model-free proof, using the app's own renderer:
  //   * with the "live" class the live selector finds the block,
  //   * with the "live" class broken the selector finds nothing while the thinking
  //     text is still there — so the old fallback rule ("the message has thinking
  //     text" => "the block was live") would have passed and the new rule fails.
  const liveProbe = await ev(`(() => {
    const orig = window.thinkHTML;
    const m = { role: 'assistant', content: '', thinking: 'reasoning' };
    const el = msgEl(m, 0);
    const box = document.querySelector('#messages');
    box.appendChild(el); // the detector looks at the document, not at a detached node
    const liveOf = () => !!window.__liveSeen();
    const textOf = () => !!el.querySelector('details.think .tbody');
    window.__sawLive = false;
    paint(el, m, true);
    const good = liveOf();
    window.thinkHTML = (mm, live) => orig(mm, false); // break the live marker
    window.__sawLive = false;
    paint(el, m, true);
    const brokenLive = liveOf(), brokenText = textOf();
    window.thinkHTML = orig;
    el.remove();
    return JSON.stringify({
      good,
      brokenLive, brokenText,
      newRule: brokenLive,              // the rule the test uses now: the live indicator only
      oldRule: brokenLive || brokenText // the old rule: the thinking text covers a missing indicator
    });
  })()`);
  const probe = JSON.parse(String(liveProbe));
  ok('the live detector finds the live thinking block', probe.good === true, liveProbe);
  ok('a broken live class is not found by the live detector, but the thinking text is',
    probe.brokenLive === false && probe.brokenText === true, liveProbe);
  ok('the live rule fails on a broken live indicator while the old fallback rule would have passed',
    probe.newRule === false && probe.oldRule === true, liveProbe);
  // The rule the test uses must be the live indicator alone (not the thinking text).
  ok('the live verdict does not fall back to the thinking text', liveVerdict(false) === false && liveVerdict(true) === true);
  await waitFor('!state.streaming && state.chat.messages.length >= 2', 180000); await sleep(1000);
  ok('block collapses when the answer starts', (await ev(`document.querySelector('details.think').open`)) === false);
  const label = await ev(`document.querySelector('details.think summary').textContent`);
  ok('summary shows thinking time', /^Thought for \d+\.\d+s$/.test(label), label);
  ok('(manual) user click on the summary expands it and sticks', await (async () => { await ev(`document.querySelector('details.think summary').click(); 1`); await sleep(100); await ev(`renderAll(); 1`); const o = await ev(`document.querySelector('details.think').open`); await ev(`document.querySelector('details.think summary').click(); 1`); await sleep(100); await ev(`renderAll(); 1`); return o === true && (await ev(`document.querySelector('details.think').open`)) === false; })());
  ok('thinkMs stored on the message', (await ev(`state.chat.messages.at(-1).thinkMs`)) > 0);
  await shot('step4-thought');

  // ---- the model may ask to use a skill ----------------------------------
  // The starter skills are in the system prompt, so a question like this one can make the
  // model ask for the `explain` skill. The card is answered like a user would answer it,
  // and the turn goes on until the answer is there.
  const finishTurn = async (ms = 180000) => {
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
  };
  ok('the turn ends (a skill card is answered if the model asks for one)', await finishTurn());

  // ---- auto title ---------------------------------------------------------
  const prefix = 'Explain step by step why the sky appears blue.';
  ok('auto title replaces the message-prefix title', await waitFor(`state.chat.titled === true && state.chat.title !== ${JSON.stringify(prefix)}`, 60000), `"${prefix}" -> "${await ev('state.chat.title')}"`);
  const t = await ev('state.chat.title');
  ok('auto title is short', t.length > 0 && t.length <= 60 && t.split(/\s+/).length <= 10, t);
  ok('sidebar shows the new title', await waitFor(`document.querySelector('#chatList .chat.active .t').textContent === state.chat.title`, 8000));

  // ---- thinking OFF -------------------------------------------------------
  await ev(`document.querySelector('#thinkToggle').click(); 1`);
  const beforeOff = await ev(`state.chat.messages.length`);
  await ev(`send('Reply with the single word: pong'); 1`);
  await finishTurn();
  // The reply of the assistant must really be there: without it the message that is
  // checked below would be the one of the user, and the assertion would prove nothing.
  const gotReply = await waitFor(`state.chat.messages.length >= ${beforeOff + 2} && (state.chat.messages.at(-1) || {}).role === 'assistant'`, 120000);
  ok('the reply of the assistant is there', gotReply, 'messages: ' + String(await ev(`state.chat.messages.length`)));
  const offRole = await ev(`(state.chat.messages.at(-1) || {}).role`);
  const offThinking = await ev(`(state.chat.messages.at(-1) || {}).thinking || ''`);
  ok('with Thinking off, no reasoning block is produced', offRole === 'assistant' && offThinking === '',
    'role: ' + offRole + ' thinking: ' + JSON.stringify(offThinking));
  await ev(`document.querySelector('#thinkToggle').click(); 1`);

  // ---- edit with branching ------------------------------------------------
  await ev(`newChat(); 1`); await sleep(300);
  await ev(`document.querySelector('#thinkToggle').click(); 1`); // thinking off: faster, deterministic
  const a1 = await ask('Reply with exactly one word: alpha');
  await ask('Reply with exactly one word: gamma');
  ok('built a 4-message chat', (await ev('state.chat.messages.length')) === 4);
  await ev(`document.querySelector('.msg.user [data-act=edit]').click(); 1`);
  ok('Edit opens an inline editor', !!(await ev(`document.querySelector('.editbox')`)));
  await ev(`(() => { document.querySelector('.editbox').value = 'Reply with exactly one word: beta'; document.querySelector('[data-act=editsave]').click(); })(); 1`);
  await sleep(600); await waitFor('!state.streaming && state.chat.messages.length >= 2', 120000); await sleep(800);
  ok('saving the edit forks: chat is now 2 messages (edited + new reply)', (await ev('state.chat.messages.length')) === 2, await ev(`state.chat.messages.map(m => m.content.slice(0,30)).join(' | ')`));
  ok('version switcher shows 2/2', (await ev(`document.querySelector('.msg.user .vers span').textContent`)) === '2/2');
  const beta = await ev(`state.chat.messages[1].content`);
  console.log('   edited-branch reply:', JSON.stringify(beta));
  await shot('step4-branch');
  await ev(`document.querySelector('.msg.user [data-act=vprev]').click(); 1`); await sleep(500);
  ok('‹ restores the ORIGINAL branch (4 messages, alpha reply intact)', (await ev('state.chat.messages.length')) === 4 && (await ev(`state.chat.messages[1].content`)) === a1 && /alpha/.test(await ev(`state.chat.messages[0].content`)));
  ok('switcher shows 1/2 with ‹ disabled', (await ev(`document.querySelector('.msg.user .vers span').textContent`)) === '1/2' && (await ev(`document.querySelector('.msg.user [data-act=vprev]').disabled`)));

  // ---- persistence of branches -------------------------------------------
  await sleep(800);
  const cid = await ev('state.chat.id');
  const saved = await ev(`api('/chats/' + ${JSON.stringify(cid)}).then(c => JSON.stringify({ n: c.messages.length, fk: c.messages[0].fk && c.messages[0].fk.tails.length, cur: c.messages[0].fk && c.messages[0].fk.cur }))`);
  ok('branches persisted on the server', saved === '{"n":4,"fk":2,"cur":0}', saved);
  await ev(`openChat(${JSON.stringify(cid)}); 1`); await sleep(800);
  await ev(`document.querySelector('.msg.user [data-act=vnext]').click(); 1`); await sleep(500);
  ok('after reload, › still reaches the edited branch', (await ev('state.chat.messages.length')) === 2 && /beta/.test(await ev(`state.chat.messages[0].content`)));

  // ---- regenerate as a variant -------------------------------------------
  await ev(`document.querySelector('.msg.assistant [data-act=regen]').click(); 1`);
  await sleep(600); await waitFor('!state.streaming', 120000); await sleep(800);
  ok('Regenerate creates a version switcher on the assistant message', (await ev(`document.querySelector('.msg.assistant .vers span') && document.querySelector('.msg.assistant .vers span').textContent`)) === '2/2');
  await ev(`document.querySelector('.msg.assistant [data-act=vprev]').click(); 1`); await sleep(400);
  ok('‹ returns to the first reply', (await ev(`state.chat.messages[1].content`)) === beta);
  ok('user message unaffected by assistant-level fork', (await ev('state.chat.messages.length')) === 2 && (await ev(`!!state.chat.messages[0].fk`)));

  // ---- cancel edit --------------------------------------------------------
  await ev(`document.querySelector('.msg.user [data-act=edit]').click(); 1`);
  await ev(`document.querySelector('[data-act=editcancel]').click(); 1`);
  ok('cancelling an edit changes nothing', !(await ev(`document.querySelector('.editbox')`)) && (await ev('state.chat.messages.length')) === 2);
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
