const { launch, sleep } = require('./lib/cdplib');
const { execSync } = require('child_process');
const SRV = require('path').join(__dirname, 'mcp-test-server.js');
const procs = () => { try { return Number(execSync('pgrep -f mcp-test-server.js | wc -l').toString().trim()); } catch { return 0; } };

(async () => {
  const h = await launch('http://localhost:3101', 9343);
  const { ev, ok, waitFor, shot } = h;
  await ev(`document.querySelector('#thinkToggle').click(); window.confirm = () => true; 1`); // thinking off for speed
  const send = (q) => ev(`send(${JSON.stringify(q)}); 1`);
  const idle = (ms = 150000) => waitFor(`!state.streaming && !state.toolsBusy && state.chat.messages.length > 1 && state.chat.messages.at(-1).role === 'assistant' && !state.chat.messages.at(-1).toolCalls`, ms);
  const awaiting = (ms = 90000) => waitFor(`!!document.querySelector('.toolcall.awaiting')`, ms);
  const lastText = () => ev(`state.chat.messages.at(-1).content`);

  // ---- add a server through the UI ----------------------------------------
  await ev(`document.querySelector('#toolsBtn').click(); 1`);
  ok('tools dialog opens', await waitFor(`document.querySelector('#toolsDlg').open`));
  ok('trust warning is shown before adding', /only add servers you trust/i.test(await ev(`document.querySelector('#toolsDlg .warn').textContent`)));
  await ev(`(() => { mcName.value = 'Test'; mcCmd.value = ${JSON.stringify('node ' + SRV)}; document.querySelector('#mcAdd').click(); })(); 1`);
  // The list also holds the built-in "Skills" server (step 10), so the test server is
  // looked up by its name and not by its place in the list.
  const testRow = `#mcpList .mcp[data-id="' + state.mcp.find(m => m.name === 'Test').id + '"]`;
  ok('server connects', await waitFor(`!!state.mcp.find(m => m.name === 'Test' && m.status === 'connected')`, 30000), await ev(`JSON.stringify(state.mcp.map(m => [m.name, m.status, m.error]))`));
  ok('3 tools discovered', (await ev(`state.mcp.find(m => m.name === 'Test').tools.length`)) === 3);
  ok('server row rendered with green status', (await ev(`document.querySelector('${testRow} .dot.connected') !== null`)));
  // 3 tools of the test server + 2 built-in skills tools.
  ok('header badge shows tool count', (await ev(`document.querySelector('#toolsBtn').dataset.n`)) === '5' && (await ev(`document.querySelector('#toolsBtn').classList.contains('on')`)));
  ok('server process is running', procs() === 1, 'procs=' + procs());
  await shot('step6-dialog');
  await ev(`document.querySelector('#toolsClose').click(); 1`);

  // ---- tool call with approval (Allow once) -------------------------------
  await send('What is the vault secret code? Use your tools to find out, then tell me the code.');
  ok('approval card appears BEFORE the tool runs', await awaiting(), await ev(`document.querySelector('.toolcall .th')?.innerText.replace(/\\n/g,' ')`));
  ok('card names the server and tool', /Test › get_secret_code/.test(await ev(`document.querySelector('.toolcall.awaiting .th').textContent`)));
  ok('tool has NOT run yet (no result)', (await ev(`state.chat.messages.at(-1).toolCalls[0].result`)) === undefined);
  ok('3 approval buttons shown', (await ev(`document.querySelectorAll('.toolcall.awaiting [data-tc]').length`)) === 3);
  await send('this message must be ignored while waiting');
  ok('typing a new message is blocked while approval is pending', (await ev(`state.chat.messages.length`)) === 2);
  await shot('step6-approval');
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=once]').click(); 1`);
  ok('model answers after the tool ran', await idle());
  const a1 = await lastText(); console.log('   answer:', JSON.stringify(a1.slice(0, 160)));
  ok('answer contains the code from the tool (ORCHID-5521)', /ORCHID-5521/.test(a1));
  ok('transcript: user, assistant(tool call), assistant(answer)', (await ev(`state.chat.messages.map(m => m.role + (m.toolCalls ? '+tool' : '')).join()`)) === 'user,assistant+tool,assistant');
  ok('tool call recorded as done with result', (await ev(`state.chat.messages[1].toolCalls[0].status`)) === 'done' && /ORCHID-5521/.test(await ev(`state.chat.messages[1].toolCalls[0].result`)));
  const wire = await ev(`JSON.stringify(toOllama(state.chat.messages[1]).map(m => [m.role, m.tool_name || (m.tool_calls && m.tool_calls[0].function.name)]))`);
  ok('replayed to the model as tool_calls + role:"tool"', /assistant/.test(wire) && /"tool","test__get_secret_code"/.test(wire), wire);
  ok('"Allow once" did not add to the allow list', (await ev(`toolAllow().size`)) === 0);
  await shot('step6-result');
  const chatA = await ev('state.chat.id');

  // ---- persistence ----------------------------------------------------------
  await sleep(800);
  await ev(`newChat(); 1`); await ev(`openChat(${JSON.stringify(chatA)}); 1`); await sleep(900);
  ok('reopened chat still shows the finished tool card', (await ev(`document.querySelectorAll('.toolcall.done').length`)) === 1);

  // ---- Deny -----------------------------------------------------------------
  await ev(`newChat(); 1`);
  await send('Use the get_secret_code tool and tell me the code.');
  await awaiting();
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=deny]').click(); 1`);
  ok('model replies after a denial', await idle());
  ok('call recorded as denied', (await ev(`state.chat.messages[1].toolCalls[0].status`)) === 'denied');
  const a2 = await lastText(); console.log('   answer after deny:', JSON.stringify(a2.slice(0, 160)));
  ok('denied tool result never reaches the answer', !/ORCHID-5521/.test(a2));

  // ---- Always allow ---------------------------------------------------------
  await ev(`newChat(); 1`);
  await send('Use the add tool to compute 17 + 25 and tell me the result.');
  await awaiting();
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=always]').click(); 1`);
  await idle();
  const a3 = await lastText(); console.log('   add answer:', JSON.stringify(a3.slice(0, 120)));
  ok('add tool result used (42)', /42/.test(a3));
  ok('"Always allow" saved the tool', (await ev(`[...toolAllow()].some(k => k.endsWith('/add'))`)));
  await ev(`newChat(); 1`);
  await send('Use the add tool to compute 100 + 23 and tell me the result.');
  let sawPrompt = false;
  for (let i = 0; i < 200; i++) { await sleep(250); if (await ev(`!!document.querySelector('.toolcall.awaiting')`)) { sawPrompt = true; break; } if (await ev(`!state.streaming && !state.toolsBusy && state.chat.messages.length > 2`)) break; }
  await idle();
  const a4 = await lastText(); console.log('   auto-approved answer:', JSON.stringify(a4.slice(0, 120)));
  ok('auto-approved tool ran WITHOUT asking', !sawPrompt && /123/.test(a4));
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(500);
  ok('allow list shows the tool', (await ev(`document.querySelectorAll('#allowList .allow').length`)) === 1);
  await ev(`document.querySelector('#allowList .allow button').click(); 1`);
  ok('Revoke removes it', (await ev(`toolAllow().size`)) === 0);
  await ev(`document.querySelector('#toolsClose').click(); 1`);

  // ---- tool errors ------------------------------------------------------------
  await ev(`newChat(); 1`);
  await send('Call the always_fails tool and tell me exactly what error it returned.');
  await awaiting();
  await ev(`document.querySelector('.toolcall.awaiting [data-tc=once]').click(); 1`);
  await idle();
  ok('failing tool recorded as error with its message', (await ev(`state.chat.messages[1].toolCalls[0].status`)) === 'error' && /disk on fire/.test(await ev(`state.chat.messages[1].toolCalls[0].result`)));
  const a5 = await lastText(); console.log('   error answer:', JSON.stringify(a5.slice(0, 140)));
  ok('model sees the error and reports it', /fire|fail|error/i.test(a5));

  // ---- Stop while waiting for approval -----------------------------------------
  await ev(`newChat(); 1`);
  await send('Use the get_secret_code tool and tell me the code.');
  await awaiting();
  await ev(`document.querySelector('#stopBtn').click(); 1`); await sleep(1200);
  ok('Stop cancels the pending call', (await ev(`state.chat.messages.at(-1).toolCalls[0].status`)) === 'denied');
  ok('Stop ends the turn (no follow-up reply, UI idle)', (await ev(`!state.toolsBusy && !state.streaming && state.chat.messages.length === 2 && !document.querySelector('#sendBtn').hidden`)));

  // ---- master switch -------------------------------------------------------------
  await ev(`newChat(); document.querySelector('#toolsOn') && 1`);
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#toolsOn').click(); 1`);
  await ev(`document.querySelector('#toolsClose').click(); 1`);
  ok('switching tools off persists + clears badge', (await ev(`pref('tools')`)) === '0' && !(await ev(`document.querySelector('#toolsBtn').classList.contains('on')`)));
  await send('Use the get_secret_code tool and tell me the code.');
  await idle();
  ok('with tools off the model gets none (no tool call)', (await ev(`state.chat.messages.some(m => m.toolCalls)`)) === false);
  await ev(`document.querySelector('#toolsBtn').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#toolsOn').click(); 1`);

  // ---- disable / remove --------------------------------------------------------------
  await ev(`document.querySelector('${testRow} [data-a=en]').click(); 1`);
  ok('disabling the server stops its process', await waitFor(`state.mcp.find(m => m.name === 'Test').enabled === false`, 10000) && (await sleep(600), procs() === 0), 'procs=' + procs());
  ok('disabled server contributes no tools', (await ev(`JSON.stringify(buildTools())`)).indexOf('test__') === -1);
  await ev(`document.querySelector('${testRow} [data-a=en]').click(); 1`);
  ok('re-enabling reconnects', await waitFor(`state.mcp.find(m => m.name === 'Test').status === 'connected'`, 20000));
  await ev(`document.querySelector('${testRow} [data-a=rm]').click(); 1`);
  ok('removing the server deletes it and kills the process', await waitFor(`state.mcp.filter(m => !m.builtin).length === 0`, 10000) && (await sleep(600), procs() === 0));
  await ev(`document.querySelector('#toolsClose').click(); 1`);
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
