const path = require('path');
const { launch, sleep } = require('./lib/cdplib');
const FX = path.join(__dirname, 'fixtures');
const env = { URL: process.env.LUMEN_URL || 'http://localhost:3101', FILE: path.join(FX, 'handbook.txt') };

(async () => {
  const h = await launch(env.URL, 9347);
  const { ev, ok, waitFor, shot, cmd, ask } = h;
  await ev(`window.confirm = () => true; document.querySelector('#thinkToggle').click(); 1`); // thinking off: faster
  // h.ask answers a skill card like a user would and waits for the reply of the
  // assistant, so the answer that is checked below is really the answer.

  // 1. create a project through the UI
  await ev(`document.querySelector('#newProject').click(); 1`);
  ok('new project opens editor dialog', await waitFor(`document.querySelector('#projDlg').open`));
  await ev(`(() => { pName.value = 'Staff Handbook'; pInstr.value = 'Always end your answer with the single word ZEBRA.'; })(); 1`);
  const doc = (await cmd('DOM.getDocument')).result.root.nodeId;
  const node = (await cmd('DOM.querySelector', { nodeId: doc, selector: '#pFileInput' })).result.nodeId;
  await cmd('DOM.setFileInputFiles', { nodeId: node, files: [env.FILE] });
  ok('knowledge file added in dialog', await waitFor(`document.querySelectorAll('#pFiles .pfile').length === 1`), await ev(`document.querySelector('#pTokens').textContent`));
  await shot('proj-dialog');
  await ev(`document.querySelector('#projForm button[type=submit]').click(); 1`);
  await sleep(800);
  ok('dialog closed after Save', !(await ev(`document.querySelector('#projDlg').open`)));
  ok('project listed in sidebar', (await ev(`document.querySelectorAll('#projects .proj').length`)) === 1, await ev(`document.querySelector('#projects .proj').innerText.replace(/\\n/g, ' ')`));

  // 2. enter the project and chat
  await ev(`document.querySelector('#projects .proj .t').click(); 1`);
  await waitFor(`state.project`);
  await sleep(300);
  ok('selecting project shows header chip', !(await ev(`document.querySelector('#projChip').hidden`)), await ev(`document.querySelector('#projOpen').textContent`));
  ok('context auto-grows for big prompts', (await ev(`settings(0).num_ctx`)) === 4096 && (await ev(`settings(300000).num_ctx`)) === 32768, `small=${await ev('settings(0).num_ctx')} large=${await ev('settings(300000).num_ctx')}`);
  const a1 = await ask('What is the office door code, and when is standup? Answer in one short sentence.');
  console.log('   in-project answer:', JSON.stringify(a1));
  ok('uses project KNOWLEDGE (door code 7391)', /7391/.test(a1));
  ok('follows project INSTRUCTIONS (ends with ZEBRA)', /ZEBRA\W*$/i.test(a1.trim()));
  await shot('proj-chat');
  const saved = await ev(`api('/chats').then(() => api('/chats?project=' + state.project)).then(l => l.length)`);
  ok('chat saved under the project', saved === 1 && (await ev(`state.chat.project === state.project`)), 'chats in project: ' + saved);
  ok('sidebar lists the chat', (await ev(`document.querySelectorAll('#chatList .chat').length`)) === 1);

  // 3. leaving the project: chat list is filtered and knowledge is NOT used
  await ev(`document.querySelector('#projLeave').click(); 1`);
  await waitFor(`state.project === null && state.chat.messages.length === 0`);
  await sleep(500);
  ok('leaving project hides its chats from main list', (await ev(`document.querySelectorAll('#chatList .chat').length`)) === (await ev(`api('/chats?project=none').then(l => l.length)`)));
  const a2 = await ask('What is the Lumen office door code? If you do not know, say you do not know.');
  console.log('   no-project answer:', JSON.stringify(a2.slice(0, 160)));
  ok('knowledge does NOT leak outside the project', !/7391/.test(a2));

  // 4. move a chat into the project via the UI dialog, then out again
  await ev(`state.chat.project = null; 1`);
  const cid = await ev(`state.chat.id`);
  await ev(`moveChat(state.chats.find(c => c.id === ${JSON.stringify(cid)})); 1`);
  await ev(`document.querySelector('#moveSel').value = state.projects[0].id; document.querySelector('#moveForm button[type=submit]').click(); 1`);
  await sleep(1000);
  ok('move chat into project', (await ev(`api('/chats/' + ${JSON.stringify(cid)}).then(c => c.project === state.projects[0].id)`)) === true);

  // 5. delete the project: chats survive, unassigned
  await ev(`document.querySelector('#projects .proj button').click(); 1`);
  await waitFor(`document.querySelector('#projDlg').open`);
  await ev(`document.querySelector('#pDelete').click(); 1`);
  await sleep(1200);
  ok('project deleted', (await ev(`document.querySelectorAll('#projects .proj').length`)) === 0);
  const after = await ev(`api('/chats').then(l => JSON.stringify(l.map(c => c.project)))`);
  ok('chats kept and unassigned after delete', after !== '[]' && !/"[0-9a-f-]{36}"/.test(after), after);
  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
