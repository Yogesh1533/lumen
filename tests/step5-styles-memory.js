const { launch, sleep } = require('./lib/cdplib');
(async () => {
  const h = await launch('http://localhost:3101', 9342);
  const { ev, ok, ask, waitFor, shot } = h;
  await ev(`document.querySelector('#thinkToggle').click(); 1`); // thinking off: faster, more deterministic

  // ---- API ---------------------------------------------------------------
  const api = await ev(`(async () => {
    const out = {};
    const j = (p, o) => fetch('/api' + p, { ...o, headers: { 'content-type': 'application/json' }, body: o && o.body ? JSON.stringify(o.body) : undefined });
    out.empty = (await j('/memories', { method: 'POST', body: { text: '   ' } })).status;
    const m = await (await j('/memories', { method: 'POST', body: { text: 'API fact' } })).json();
    out.put = (await (await j('/memories/' + m.id, { method: 'PUT', body: { text: 'API fact 2' } })).json()).text;
    out.del = (await j('/memories/' + m.id, { method: 'DELETE' })).status;
    out.gone = (await j('/memories/' + m.id, { method: 'DELETE' })).status;
    out.styleNoPrompt = (await j('/styles', { method: 'POST', body: { name: 'x' } })).status;
    return JSON.stringify(out);
  })()`);
  ok('API validates + CRUDs memories/styles', api === '{"empty":400,"put":"API fact 2","del":200,"gone":404,"styleNoPrompt":400}', api);

  // ---- rememberRequest parsing --------------------------------------------
  ok('"Remember that …" is detected', (await ev(`rememberRequest('Remember that I like tea')`)) === 'I like tea');
  ok('"please remember: …" is detected', (await ev(`rememberRequest('please remember: standup is at 9')`)) === 'standup is at 9');
  ok('questions are NOT saved', (await ev(`rememberRequest('Do you remember that?')`)) === null && (await ev(`rememberRequest('remember the alamo?')`)) === null);
  ok('ordinary messages are NOT saved', (await ev(`rememberRequest('What do you remember about Rome')`)) === null);

  // ---- built-in styles ------------------------------------------------------
  ok('style dropdown lists Normal + 4 presets', (await ev(`document.querySelector('#styleSelect').options.length`)) === 5);
  await ev(`document.querySelector('#styleSelect').value = 'concise'; document.querySelector('#styleSelect').dispatchEvent(new Event('change')); 1`);
  ok('selecting Concise injects it into the system prompt', /Response style: Be concise/.test(await ev(`fullSystem('')`)));
  await ev(`document.querySelector('#styleSelect').value = ''; document.querySelector('#styleSelect').dispatchEvent(new Event('change')); 1`);
  ok('Normal adds nothing', (await ev(`fullSystem('')`)) === '');

  // ---- custom style via the dialog -----------------------------------------
  await ev(`document.querySelector('#settingsBtn').click(); 1`);
  ok('settings dialog opens', await waitFor(`document.querySelector('#settingsDlg').open`));
  await ev(`(() => { stName.value = 'Pirate'; stPrompt.value = 'Always finish your reply with the exact word ARRR.'; document.querySelector('#stSave').click(); })(); 1`);
  await sleep(500);
  ok('custom style appears in the dropdown (Custom group)', (await ev(`[...document.querySelectorAll('#styleSelect optgroup option')].map(o => o.textContent).join()`)) === 'Pirate');
  ok('custom style listed in dialog', (await ev(`document.querySelectorAll('#styleList .strow').length`)) === 1);
  await shot('step5-dialog');
  await ev(`document.querySelector('#setClose').click(); 1`);
  const pirate = await ev(`document.querySelector('#styleSelect optgroup option').value`);
  await ev(`document.querySelector('#styleSelect').value = ${JSON.stringify(pirate)}; document.querySelector('#styleSelect').dispatchEvent(new Event('change')); 1`);
  const r1 = await ask('Name one planet. Keep it to a few words.');
  console.log('   pirate reply:', JSON.stringify(r1));
  ok('custom style is followed (ends with ARRR)', /ARRR\W*$/i.test(r1.trim()));
  await sleep(500);
  const cid = await ev('state.chat.id');
  ok('style saved with the chat', (await ev(`api('/chats/' + ${JSON.stringify(cid)}).then(c => c.style)`)) === pirate);
  await ev(`newChat(); 1`);
  await ev(`document.querySelector('#styleSelect').value = ''; 1`);
  await ev(`openChat(${JSON.stringify(cid)}); 1`); await sleep(700);
  ok('reopening the chat restores its style', (await ev(`document.querySelector('#styleSelect').value`)) === pirate);

  // ---- memory: save, recall, edit, delete ----------------------------------
  await ev(`newChat(); document.querySelector('#styleSelect').value = ''; document.querySelector('#styleSelect').dispatchEvent(new Event('change')); 1`);
  await ask('Remember that my favourite colour is teal.');
  ok('"Remember that…" saved automatically', (await ev(`state.settings.memories.map(m => m.text).join('|')`)) === 'my favourite colour is teal.');
  ok('memory is persisted on the server', (await ev(`api('/settings').then(s => s.memories.length)`)) === 1);
  ok('memory is injected into the system prompt', /favourite colour is teal/.test(await ev(`fullSystem('')`)));
  await ev(`newChat(); 1`);
  const r2 = await ask('What is my favourite colour? Answer with one word only.');
  console.log('   recall reply (new chat):', JSON.stringify(r2));
  ok('a NEW chat recalls the memory', /teal/i.test(r2));
  await shot('step5-recall');

  // ---- privacy: temporary chats ---------------------------------------------
  await ev(`document.querySelector('#tempToggle').click(); newChat(); 1`);
  ok('temporary chat gets no memory in its prompt', !/teal/.test(await ev(`fullSystem('')`)));
  const r3 = await ask('What is my favourite colour? If you do not know, say "unknown".');
  console.log('   temp-chat reply:', JSON.stringify(r3));
  ok('temporary chat does NOT recall the memory', !/teal/i.test(r3));
  const before = await ev('state.settings.memories.length');
  await ask('Remember that I own a secret boat.');
  ok('"Remember…" in a temporary chat is NOT saved', (await ev('state.settings.memories.length')) === before);
  await ev(`document.querySelector('#tempToggle').click(); 1`);

  // ---- memory toggle -------------------------------------------------------
  await ev(`document.querySelector('#settingsBtn').click(); 1`); await sleep(300);
  await ev(`document.querySelector('#memEnabled').click(); 1`); await sleep(500);
  ok('memory switch persists server-side', (await ev(`api('/settings').then(s => s.memoryEnabled)`)) === false);
  ok('memory off: not in system prompt', !/teal/.test(await ev(`fullSystem('')`)));
  await ev(`document.querySelector('#memEnabled').click(); 1`); await sleep(500);
  ok('memory on again: injected', /teal/.test(await ev(`fullSystem('')`)));

  // edit + add + delete in the dialog
  await ev(`(() => { const i = document.querySelector('#memList input'); i.value = 'my favourite colour is orange'; i.dispatchEvent(new Event('change')); })(); 1`);
  await sleep(500);
  ok('editing a memory row saves it', (await ev(`api('/settings').then(s => s.memories[0].text)`)) === 'my favourite colour is orange');
  await ev(`(() => { memInput.value = 'I live in Sydney'; document.querySelector('#memAdd').click(); })(); 1`); await sleep(500);
  ok('manual add works', (await ev(`document.querySelectorAll('#memList .memrow').length`)) === 2);
  await ev(`document.querySelector('#memList .memrow button').click(); 1`); await sleep(500);
  ok('delete (forget) works', (await ev(`api('/settings').then(s => s.memories.map(m => m.text).join('|'))`)) === 'I live in Sydney');
  await shot('step5-memory');
  await ev(`document.querySelector('#setClose').click(); 1`);

  // ---- Remember button -------------------------------------------------------
  await ev(`newChat(); state.chat.messages = [{role:'user',content:'I always test on Firefox'},{role:'assistant',content:'ok'}]; renderAll(); 1`);
  await ev(`document.querySelector('.msg.user [data-act=mem]').click(); 1`); await sleep(700);
  ok('Remember button on a message saves it', (await ev(`state.settings.memories.some(m => m.text === 'I always test on Firefox')`)));

  // ---- deleting the selected custom style falls back to Normal ----------------
  await ev(`document.querySelector('#styleSelect').value = ${JSON.stringify(pirate)}; 1`);
  await ev(`document.querySelector('#settingsBtn').click(); 1`); await sleep(300);
  await ev(`document.querySelector('#styleList [data-a=rm]').click(); 1`); await sleep(600);
  ok('deleting the active custom style resets the dropdown to Normal', (await ev(`document.querySelector('#styleSelect').value`)) === '' && (await ev(`document.querySelectorAll('#styleSelect optgroup').length`)) === 0);
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
