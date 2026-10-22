const { launch, sleep } = require('./lib/cdplib');
(async () => {
  const h = await launch('http://localhost:3101', 9341);
  const { ev, ok, ask, waitFor, shot } = h;

  // ---- thinking block ----------------------------------------------------
  ok('thinking toggle visible for a reasoning model', !(await ev(`document.querySelector('#thinkWrap').hidden`)));
  // NB: a "one short sentence" prompt makes gemma4 skip its reasoning half the time (empty
  // `thinking` from Ollama even with think:true), so ask for a step-by-step explanation.
  // The model still skips it now and then, so try a few times before giving up.
  let sawLive = false;
  for (let attempt = 0; attempt < 3 && !sawLive; attempt++) {
    await ev(`send('Explain step by step why the sky appears blue.'); 1`);
    for (let i = 0; i < 240 && !sawLive; i++) { await sleep(250); sawLive = await ev(`!!document.querySelector('details.think.live[open]')`); if (await ev('!state.streaming && state.chat.messages.length >= 2')) break; }
    await waitFor('!state.streaming && state.chat.messages.length >= 2', 180000); await sleep(1000);
    if (!sawLive) sawLive = !!String(await ev(`(state.chat.messages.at(-1) || {}).thinking || ''`)).trim(); // the block may have closed too fast to catch it live
  }
  ok('thinking block is open + live while the model thinks', sawLive);
  await waitFor('!state.streaming && state.chat.messages.length >= 2', 180000); await sleep(1000);
  ok('block collapses when the answer starts', (await ev(`document.querySelector('details.think').open`)) === false);
  const label = await ev(`document.querySelector('details.think summary').textContent`);
  ok('summary shows thinking time', /^Thought for \d+\.\d+s$/.test(label), label);
  ok('(manual) user click on the summary expands it and sticks', await (async () => { await ev(`document.querySelector('details.think summary').click(); 1`); await sleep(100); await ev(`renderAll(); 1`); const o = await ev(`document.querySelector('details.think').open`); await ev(`document.querySelector('details.think summary').click(); 1`); await sleep(100); await ev(`renderAll(); 1`); return o === true && (await ev(`document.querySelector('details.think').open`)) === false; })());
  ok('thinkMs stored on the message', (await ev(`state.chat.messages.at(-1).thinkMs`)) > 0);
  await shot('step4-thought');

  // ---- auto title ---------------------------------------------------------
  const prefix = 'Explain step by step why the sky appears blue.';
  ok('auto title replaces the message-prefix title', await waitFor(`state.chat.titled === true && state.chat.title !== ${JSON.stringify(prefix)}`, 60000), `"${prefix}" -> "${await ev('state.chat.title')}"`);
  const t = await ev('state.chat.title');
  ok('auto title is short', t.length > 0 && t.length <= 60 && t.split(/\s+/).length <= 10, t);
  ok('sidebar shows the new title', await waitFor(`document.querySelector('#chatList .chat.active .t').textContent === state.chat.title`, 8000));

  // ---- thinking OFF -------------------------------------------------------
  await ev(`document.querySelector('#thinkToggle').click(); 1`);
  await ask('Reply with the single word: pong');
  ok('with Thinking off, no reasoning block is produced', (await ev(`state.chat.messages.at(-1).thinking || ''`)) === '');
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
