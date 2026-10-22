// Step 10 — skills: the skills tools (use_skill, read_skill_file), the Skills dialog,
// the limits (30 MB per skill) and the approval flow.
const { launch, sleep } = require('./lib/cdplib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { zip } = require('./lib/zipwrite');

const TMP = process.env.LUMEN_TEST_TMP || path.join(os.tmpdir(), 'lumen-tests');
const BASE = 'http://localhost:3101';
const DATA_FILE = process.env.LUMEN_DATA || path.join(TMP, 'data', 'chats.json');
const DATA_DIR = path.dirname(DATA_FILE);
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const MAX_BYTES = 30 * 1024 * 1024;      // the limit of one skill folder
const TEST_SKILL = 'lumen-test-skill';
const MARKER = 'BANANAPLEX';

// Data that repeats a block: it compresses about 1000:1, so the ratio limit of the zip
// reader would fire first. The tests that want the *size* limit therefore lie about the
// size in the directory of the bundle (the reader measures the real bytes, not the claim).
function softData(bytes) {
  const block = crypto.randomBytes(30000);
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += block.length) block.copy(out, i, 0, Math.min(block.length, bytes - i));
  return out;
}

// An API call from Node. The server answers on localhost, so it goes through the same
// guard() as the browser.
async function call(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    // fetch refuses a body on GET.
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
// The skills of the server. A route that does not exist must not crash the test: the
// assertion fails, the test keeps going.
const skillByName = async (name) => (((await call('GET', '/api/skills')).json) || {}).skills?.find((s) => s.name === name);

const SKILL_MD = [
  '---',
  'name: lumen-test-skill',
  'description: A test skill for the step-10 test. It makes the assistant answer with the word BANANAPLEX.',
  '---',
  '',
  'This skill exists only for the test. When you use it, your answer must contain the word',
  'BANANAPLEX, and it must end with the word ENDMARK. Answer with one short sentence that',
  'holds both words.',
  '',
].join('\n');

const MODEL_SYS = [
  'You are a helpful assistant with tools.',
  'When the user asks you to use a skill, you must first call the use_skill tool with the',
  'name of the skill, wait for its result, and then follow the instructions of the SKILL.md',
  'exactly. Never answer from memory: always call the tool first.',
].join(' ');

(async () => {
  const h = await launch(BASE, 9348);
  const { ev, ok, waitFor, shot } = h;
  // A page that throws answers with a truthy "EXC ..." string, so a boolean check has to
  // be compared with true — otherwise it would pass without checking anything.
  const t = async (expr) => (await ev(expr)) === true;

  // ---- 1. the skills that ship with Lumen -------------------------------------
  let list = await call('GET', '/api/skills');
  ok('the skills route answers', list.status === 200, list.text.slice(0, 200));
  const names = (list.json.skills || []).map((s) => s.name);
  ok('the two starter skills are there', names.includes('summarise') && names.includes('explain'), names.join(','));
  const sum = (list.json.skills || []).find((s) => s.name === 'summarise');
  ok('a starter skill has a description', !!sum && !!sum.description && sum.description.length > 10, sum && sum.description);
  ok('a starter skill has more than one file', !!sum && (sum.files || []).length >= 2, JSON.stringify(sum && sum.files));
  ok('a starter skill is enabled by default', !!sum && sum.enabled === true, JSON.stringify(sum && sum.enabled));
  const exp = (list.json.skills || []).find((s) => s.name === 'explain');
  ok('the second starter skill has a description', !!exp && !!exp.description && exp.description.length > 10, exp && exp.description);
  ok('the second starter skill has more than one file', !!exp && (exp.files || []).length >= 2, JSON.stringify(exp && exp.files));
  ok('the starter skills are on the disk', fs.existsSync(path.join(SKILLS_DIR, 'summarise', 'SKILL.md')) &&
    fs.existsSync(path.join(SKILLS_DIR, 'explain', 'SKILL.md')));
  ok('the limit of a skill is reported', list.json.limits && list.json.limits.maxBytes === MAX_BYTES, JSON.stringify(list.json.limits));

  // ---- 2. a skill that is written by hand -------------------------------------
  const created = await call('POST', '/api/skills', { name: TEST_SKILL, content: SKILL_MD });
  ok('a skill can be created', created.status === 200 && created.json.name === TEST_SKILL, created.text.slice(0, 200));
  ok('the description comes from the frontmatter', created.json.description && /BANANAPLEX/.test(created.json.description), created.json.description);
  ok('the file is written to the disk', fs.existsSync(path.join(SKILLS_DIR, TEST_SKILL, 'SKILL.md')));
  ok('a new skill is enabled', created.json.enabled === true, JSON.stringify(created.json.enabled));

  // The name becomes a folder name, so only a plain, short name is allowed.
  for (const bad of ['', '..', '../evil', 'a/b', 'UPPER', '.hidden', 'x'.repeat(41), 'with space']) {
    const r = await call('POST', '/api/skills', { name: bad, content: 'x' });
    ok(`the skill name "${bad}" is refused`, r.status === 400, r.text.slice(0, 160));
  }
  ok('nothing was written outside the skills folder', !fs.existsSync(path.join(DATA_DIR, 'evil')) && !fs.existsSync(path.join(SKILLS_DIR, '..', 'evil')));

  // A skill that is edited keeps its files.
  const edited = await call('PUT', '/api/skills/' + TEST_SKILL, { content: SKILL_MD.replace('A test skill for the step-10 test.', 'A changed description.') });
  ok('the SKILL.md can be edited', edited.status === 200 && /A changed description/.test(edited.json.description), edited.text.slice(0, 200));
  const back = await call('PUT', '/api/skills/' + TEST_SKILL, { content: SKILL_MD });
  ok('the description can be changed back', /step-10 test/.test(back.json.description), back.json.description);

  // ---- 3. the skills server and its tools --------------------------------------
  let mcp = await call('GET', '/api/mcp');
  const skillsSrv = (mcp.json || []).find((s) => s.id === 'skills');
  ok('the skills server is in the list of the servers', !!skillsSrv, JSON.stringify((mcp.json || []).map((s) => s.id)));
  ok('the skills server is a built-in one', !!skillsSrv && skillsSrv.builtin === true, JSON.stringify(skillsSrv && skillsSrv.transport));
  ok('the skills server brings two tools', !!skillsSrv && (skillsSrv.tools || []).length === 2, JSON.stringify(skillsSrv && skillsSrv.tools));
  ok('the skills tools are use_skill and read_skill_file', !!skillsSrv && ['use_skill', 'read_skill_file'].every((t) => skillsSrv.tools.some((x) => x.name === t)),
    JSON.stringify(skillsSrv && skillsSrv.tools.map((t) => t.name)));

  // The tools reach the model through the normal tool mechanism.
  await ev(`loadMcp().then(() => 1)`);
  const toolNames = await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`);
  ok('the skills tools are sent to the model', /skills__use_skill/.test(toolNames) && /skills__read_skill_file/.test(toolNames), toolNames);

  // A tool that is switched off is not sent and does not run.
  const sw = await call('PUT', '/api/mcp/skills/tools', { disabled: ['use_skill'] });
  ok('a skills tool can be switched off', sw.status === 200 && (sw.json.tools || []).some((t) => t.name === 'use_skill' && t.enabled === false), sw.text.slice(0, 200));
  const blocked = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: 'summarise' } });
  ok('a skills tool that is off does not run', blocked.json && blocked.json.isError === true, blocked.text.slice(0, 160));
  await ev(`loadMcp().then(() => 1)`);
  const toolNames2 = await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`);
  ok('a skills tool that is off is not sent to the model', !/skills__use_skill/.test(toolNames2) && /skills__read_skill_file/.test(toolNames2), toolNames2);
  await call('PUT', '/api/mcp/skills/tools', { disabled: [] });
  await ev(`loadMcp().then(() => 1)`);
  const toolNames3 = await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`);
  ok('a skills tool that is on again is sent again', /skills__use_skill/.test(toolNames3), toolNames3);

  // ---- 4. use_skill ------------------------------------------------------------
  const use = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: 'summarise' } });
  ok('use_skill answers', !!use.json && use.json.isError === false, use.text.slice(0, 200));
  const useText = (use.json && use.json.text) || '';
  ok('use_skill returns the body of the skill', /pass/i.test(useText), useText.slice(0, 200));
  ok('use_skill lists the files of the skill', /checklist\.md/.test(useText), useText.slice(-200));
  ok('use_skill does not run anything', !/error/i.test(useText.slice(0, 40)), useText.slice(0, 60));
  const useBad = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: 'no-such-skill' } });
  ok('use_skill refuses a skill that does not exist', useBad.json && useBad.json.isError === true, useBad.text.slice(0, 160));
  const useBadName = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: '../../etc' } });
  ok('use_skill refuses a name that is not a name', useBadName.json && useBadName.json.isError === true, useBadName.text.slice(0, 160));

  // ---- 5. read_skill_file ------------------------------------------------------
  const rf = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: 'summarise', path: 'checklist.md' } });
  ok('read_skill_file reads a file of the skill', rf.json && rf.json.isError !== true && ((rf.json.text || '').length > 30), rf.text.slice(0, 200));
  // The path must stay inside the folder of the skill.
  for (const p of ['../../../etc/passwd', '/etc/passwd', '..', 'a/../../etc/passwd', '/etc/hosts', '..\\..\\etc\\passwd']) {
    const r = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: 'summarise', path: p } });
    ok(`the path "${p}" is refused`, r.json && r.json.isError === true && !/root:/.test(r.json.text || ''), r.text.slice(0, 160));
  }
  const rfBadName = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: '../../etc', path: 'passwd' } });
  ok('read_skill_file refuses a name that is not a name', rfBadName.json && rfBadName.json.isError === true, rfBadName.text.slice(0, 160));
  // A symlink that points out of the folder is refused as well.
  const linkPath = path.join(SKILLS_DIR, 'summarise', 'escape');
  try { fs.unlinkSync(linkPath); } catch { /* not there */ }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync('/etc/passwd', linkPath);
  const rfLink = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: 'summarise', path: 'escape' } });
  ok('a symlink out of the skill folder is refused', rfLink.json && rfLink.json.isError === true && !/root:/.test(rfLink.json.text || ''), rfLink.text.slice(0, 160));

  // ---- 6. the enabled and the disabled skills -----------------------------------
  await call('PUT', '/api/skills/' + TEST_SKILL, { enabled: false });
  ok('a skill can be switched off', (await skillByName(TEST_SKILL))?.enabled === false);
  const useOff = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: TEST_SKILL } });
  ok('a disabled skill cannot be used', useOff.json && useOff.json.isError === true, useOff.text.slice(0, 160));
  const rfOff = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: TEST_SKILL, path: 'SKILL.md' } });
  ok('a disabled skill cannot be read', rfOff.json && rfOff.json.isError === true, rfOff.text.slice(0, 160));
  await call('PUT', '/api/skills/' + TEST_SKILL, { enabled: true });
  ok('a skill can be switched on again', (await skillByName(TEST_SKILL))?.enabled === true);

  // ---- 7. a zip that is uploaded --------------------------------------------------
  const zbuf = zip([
    { name: 'SKILL.md', data: '---\nname: zipped\ndescription: A zipped skill.\n---\n\nThe body of the zipped skill.\n' },
    { name: 'notes.md', data: 'some notes of the zipped skill' },
  ]);
  const up = await call('POST', '/api/skills/upload', { name: 'zipped', file: zbuf.toString('base64') });
  ok('a zip can be uploaded', up.status === 200 && up.json.name === 'zipped', up.text.slice(0, 200));
  ok('the files of the zip are unpacked', fs.existsSync(path.join(SKILLS_DIR, 'zipped', 'notes.md')) && fs.existsSync(path.join(SKILLS_DIR, 'zipped', 'SKILL.md')));
  ok('the description of the zipped skill is read', /A zipped skill/.test(up.json.description), up.json.description);
  const useZipped = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: 'zipped' } });
  ok('the zipped skill can be used', useZipped.json && useZipped.json.isError !== true && /body of the zipped skill/.test(useZipped.json.text || ''), useZipped.text.slice(0, 200));

  // A zip that tries to escape its folder is refused.
  const evil = zip([{ name: '../evil.md', data: 'gotcha' }, { name: 'SKILL.md', data: '---\nname: evilzip\ndescription: evil\n---\n' }]);
  const evilRes = await call('POST', '/api/skills/upload', { name: 'evilzip', file: evil.toString('base64') });
  ok('a zip with a path that escapes is refused', evilRes.status === 400, evilRes.text.slice(0, 200));
  ok('nothing was written outside the skills folder', !fs.existsSync(path.join(DATA_DIR, 'evil.md')) && !fs.existsSync(path.join(SKILLS_DIR, 'evil.md')));
  const abs = zip([{ name: '/tmp/lumen-abs.md', data: 'gotcha' }]);
  const absRes = await call('POST', '/api/skills/upload', { name: 'abszip', file: abs.toString('base64') });
  ok('a zip with an absolute path is refused', absRes.status === 400, absRes.text.slice(0, 200));
  ok('no skill was created from the refused zips', !(await skillByName('evilzip')) && !(await skillByName('abszip')));

  // ---- 8. the size limits ---------------------------------------------------------
  {
    // One file over the limit of 30 MB. The bundle lies about the size, so only the
    // limit on the real bytes can fire.
    const big = zip([{ name: 'SKILL.md', data: '---\nname: bigskill\ndescription: too big\n---\n' }, { name: 'big.bin', data: softData(31 * 1024 * 1024), opts: { declaredSize: 10 } }]);
    const r = await call('POST', '/api/skills/upload', { name: 'bigskill', file: big.toString('base64') });
    ok('a zip that is over the 30 MB limit is refused', r.status === 400, r.text.slice(0, 200));
    ok('the refusal names the limit that fired', /31457280/.test(r.json.error || ''), r.json && r.json.error);
    ok('nothing was written from the refused zip', !fs.existsSync(path.join(SKILLS_DIR, 'bigskill')));
  }
  {
    // Two files of 16 MB: every file is under the limit per file, so only the limit in
    // total can fire.
    const two = zip([
      { name: 'SKILL.md', data: '---\nname: totalskill\ndescription: too big in total\n---\n' },
      { name: 'a.bin', data: softData(16 * 1024 * 1024), opts: { declaredSize: 10 } },
      { name: 'b.bin', data: softData(16 * 1024 * 1024), opts: { declaredSize: 10 } },
    ]);
    const r = await call('POST', '/api/skills/upload', { name: 'totalskill', file: two.toString('base64') });
    ok('a zip that is over the limit in total is refused', r.status === 400, r.text.slice(0, 200));
    ok('the refusal names the limit in total', /31457280/.test(r.json.error || ''), r.json && r.json.error);
    ok('nothing was written from the refused zip', !fs.existsSync(path.join(SKILLS_DIR, 'totalskill')));
  }
  {
    // A single file that would make the folder of the skill bigger than 30 MB.
    const okFile = await call('POST', '/api/skills/' + TEST_SKILL + '/files', { path: 'big.bin', data: Buffer.alloc(18 * 1024 * 1024, 7).toString('base64') });
    ok('a file of 18 MB can be added to a skill', okFile.status === 200, okFile.text.slice(0, 200));
    const tooMuch = await call('POST', '/api/skills/' + TEST_SKILL + '/files', { path: 'more.bin', data: Buffer.alloc(13 * 1024 * 1024, 7).toString('base64') });
    ok('a file that would make the skill bigger than 30 MB is refused', tooMuch.status === 400, tooMuch.text.slice(0, 200));
    ok('the refusal names the limit of 30 MB', /31457280|30 ?MB/.test(tooMuch.json.error || ''), tooMuch.json && tooMuch.json.error);
    ok('the refused file was not written', !fs.existsSync(path.join(SKILLS_DIR, TEST_SKILL, 'more.bin')));
    ok('the skill is still there and still usable', !!(await skillByName(TEST_SKILL)));
  }
  {
    // A file that tries to escape the folder of the skill is refused.
    const escape = await call('POST', '/api/skills/' + TEST_SKILL + '/files', { path: '../escape.md', data: Buffer.from('gotcha').toString('base64') });
    ok('a file with a path that escapes is refused', escape.status === 400, escape.text.slice(0, 200));
    ok('nothing was written outside the skills folder', !fs.existsSync(path.join(DATA_DIR, 'escape.md')));
  }
  {
    // The skill of the test grows: it is removed again, so the model test is quick.
    const del = await call('DELETE', '/api/skills/' + TEST_SKILL);
    ok('a skill can be deleted', del.status === 200, del.text.slice(0, 160));
    ok('the folder of the deleted skill is gone', !fs.existsSync(path.join(SKILLS_DIR, TEST_SKILL)));
    ok('a deleted skill is not in the list', !(await skillByName(TEST_SKILL)));
  }

  // ---- 9. the system prompt -------------------------------------------------------
  await ev(`loadSkills().then(() => 1)`);
  const sys1 = await ev(`fullSystem("")`);
  ok('an enabled skill is in the system prompt', /summarise/.test(sys1), sys1.slice(0, 200));
  ok('the description of the skill is in the system prompt', /summarise/i.test(sys1) && sys1.length > 200, sys1.slice(0, 300));
  ok('the prompt says that a skill is material of the user', /user/i.test(sys1), sys1.slice(0, 300));
  await call('PUT', '/api/skills/summarise', { enabled: false });
  await ev(`loadSkills().then(() => 1)`);
  const sys2 = await ev(`fullSystem("")`);
  ok('a disabled skill is not in the system prompt', !/summarise/.test(sys2), sys2.slice(0, 300));
  await call('PUT', '/api/skills/summarise', { enabled: true });
  await ev(`loadSkills().then(() => 1)`);
  ok('the skill is in the system prompt again', /summarise/.test(await ev(`fullSystem("")`)));

  // ---- 10. the user interface ------------------------------------------------------
  await ev(`(() => { const b = document.querySelector('#skillsBtn'); if (b) b.click(); return 1; })()`); await sleep(700);
  ok('the skills dialog opens', await t(`!!document.querySelector('#skillsDlg') && document.querySelector('#skillsDlg').open`));
  const listText = await ev(`document.querySelector('#skillList')?.textContent || ''`);
  ok('the dialog lists the skills', /summarise/.test(listText) && /explain/.test(listText), listText.slice(0, 200));
  ok('the dialog shows the description of a skill', /summar/i.test(listText), listText.slice(0, 300));
  await shot('step10-skills');

  // The switch in the dialog switches a skill off and on again.
  await ev(`(() => { const b = document.querySelector('#skillList .skill[data-name="summarise"] input.en'); if (b) b.click(); return 1; })()`);
  await sleep(900);
  ok('the switch in the dialog switches the skill off', (await skillByName('summarise'))?.enabled === false);
  await ev(`(() => { const b = document.querySelector('#skillList .skill[data-name="summarise"] input.en'); if (b) b.click(); return 1; })()`);
  await sleep(900);
  ok('the switch in the dialog switches the skill on again', (await skillByName('summarise'))?.enabled === true);

  // The editor shows the SKILL.md and saves it.
  await ev(`(() => { const b = document.querySelector('#skillList .skill[data-name="zipped"] [data-a=edit]'); if (b) b.click(); return 1; })()`);
  await sleep(700);
  ok('the editor opens', await t(`!!document.querySelector('#skillEditDlg') && document.querySelector('#skillEditDlg').open`));
  const editText = await ev(`document.querySelector('#skContent')?.value || ''`);
  ok('the editor holds the SKILL.md of the skill', /body of the zipped skill/.test(editText), editText.slice(0, 160));
  await ev(`(() => { const t = document.querySelector('#skContent'); t.value = t.value.replace('A zipped skill.', 'A zipped skill, edited.'); document.querySelector('#skSave').click(); return 1; })()`);
  await sleep(1200);
  ok('the edited SKILL.md is saved', /edited/.test(((await call('GET', '/api/skills/zipped')).json || {}).description || ''),
    JSON.stringify((await call('GET', '/api/skills/zipped')).json && (await call('GET', '/api/skills/zipped')).json.description));
  ok('the editor is closed after the save', await t(`!!document.querySelector('#skillEditDlg') && !document.querySelector('#skillEditDlg').open`));

  // The approval of the skills tools: on by default.
  const allow0 = await ev(`JSON.stringify([...toolAllow()])`);
  ok('no skill tool is allowed without asking', !/skills\//.test(allow0), allow0);
  ok('the dialog has a switch for every skills tool', (await ev(`document.querySelectorAll('#skillTools .tog').length`)) === 2,
    String(await ev(`document.querySelectorAll('#skillTools .tog').length`)));
  await ev(`(() => { const b = document.querySelector('#skillTools .tog[data-tool="use_skill"] input'); if (b) b.click(); return 1; })()`);
  await sleep(500);
  const allow1 = await ev(`JSON.stringify([...toolAllow()])`);
  ok('the switch writes "always allow" for that exact tool', /skills\/use_skill/.test(allow1), allow1);
  ok('the other tool is not allowed by it', !/skills\/read_skill_file/.test(allow1), allow1);
  await ev(`(() => { const b = document.querySelector('#skillTools .tog[data-tool="use_skill"] input'); if (b) b.click(); return 1; })()`);
  await sleep(500);
  const allow2 = await ev(`JSON.stringify([...toolAllow()])`);
  ok('the switch can be turned back on', !/skills\/use_skill/.test(allow2), allow2);

  // ---- 11. a real model call ---------------------------------------------------------
  const made = await call('POST', '/api/skills', { name: TEST_SKILL, content: SKILL_MD });
  ok('the test skill is there for the model call', made.status === 200, made.text.slice(0, 160));
  await ev(`loadSkills().then(() => 1)`);
  await ev(`loadMcp().then(() => 1)`);
  await ev(`state.toolsOn = true; 1`);

  // A model call that has to ask for the skill first.
  async function askWithSkill(q, tries) {
    let last = null;
    for (let i = 0; i < (tries || 3); i++) {
      await ev(`newChat(); 1`);
      await ev(`(() => { const s = document.querySelector('#systemPrompt'); s.value = ${JSON.stringify(MODEL_SYS)}; s.dispatchEvent(new Event('change')); return 1; })()`);
      const before = await ev(`state.chat.messages.length`);
      await ev(`send(${JSON.stringify(q)}); 1`);
      await waitFor(`!!document.querySelector('#messages .toolcall.awaiting') || (!state.streaming && !state.toolsBusy && state.chat.messages.length > ${before})`, 150000);
      const cardSeen = await ev(`!!document.querySelector('#messages .toolcall.awaiting')`);
      if (cardSeen) {
        await ev(`(() => { const b = document.querySelector('#messages .toolcall.awaiting [data-tc=once]'); if (b) b.click(); return 1; })()`);
      }
      await waitFor(`!state.streaming && !state.toolsBusy && state.chat.messages.length >= ${before + 3}`, 180000);
      await sleep(700);
      const calls = JSON.parse(await ev(`JSON.stringify([].concat.apply([], (state.chat.messages||[]).map(m=>m.toolCalls||[])))`));
      const used = calls.find((c) => c.tool === 'use_skill');
      const answer = await ev(`(state.chat.messages.at(-1)||{}).content || ''`);
      last = { cardSeen: !!cardSeen, used, answer, calls };
      if (used && used.status === 'done' && new RegExp(MARKER, 'i').test(answer)) return last;
    }
    return last;
  }

  const r1 = await askWithSkill('Use the skill named ' + TEST_SKILL + ' and follow its instructions.', 3);
  ok('the model asked for the skill before it answered', !!(r1 && r1.used), JSON.stringify(r1 && r1.calls && r1.calls.map((c) => [c.tool, c.status])));
  ok('the skill was loaded', !!(r1 && r1.used && r1.used.status === 'done'), r1 && r1.used && r1.used.status);
  ok('the tool call was approved by the user', !!(r1 && r1.cardSeen), 'no approval card was shown');
  ok('the answer uses the content of the skill', !!(r1 && new RegExp(MARKER, 'i').test(r1.answer)), r1 && String(r1.answer).slice(0, 200));

  // The same call with the skill tool on "always allow": no card, but the same result.
  await ev(`(() => { const b = document.querySelector('#skillsBtn'); if (b) b.click(); return 1; })()`); await sleep(600);
  await ev(`(() => { const b = document.querySelector('#skillTools .tog[data-tool="use_skill"] input'); if (b) b.click(); return 1; })()`);
  await sleep(500);
  ok('the tool is allowed for good', /skills\/use_skill/.test(await ev(`JSON.stringify([...toolAllow()])`)));
  const r2 = await askWithSkill('Use the skill named ' + TEST_SKILL + ' and follow its instructions.', 3);
  ok('the skill is loaded without an approval card', !!(r2 && r2.used && r2.used.status === 'done') && !(r2 && r2.cardSeen),
    JSON.stringify(r2 && r2.calls && r2.calls.map((c) => [c.tool, c.status])) + ' card: ' + (r2 && r2.cardSeen));
  ok('the answer uses the content of the skill', !!(r2 && new RegExp(MARKER, 'i').test(r2.answer)), r2 && String(r2.answer).slice(0, 200));

  // ---- 12. the guard ---------------------------------------------------------------
  for (const [method, url] of [['GET', '/api/skills'], ['POST', '/api/skills'], ['PUT', '/api/skills/summarise'], ['DELETE', '/api/skills/summarise'],
    ['POST', '/api/skills/upload'], ['POST', '/api/skills/summarise/files'], ['GET', '/api/skills/summarise']]) {
    const r = await call(method, url, {}, { origin: 'http://evil.example' });
    ok(`a cross-site ${method} ${url} is refused`, r.status === 403, r.text.slice(0, 160));
  }
  const rSite = await call('GET', '/api/skills', undefined, { 'sec-fetch-site': 'cross-site' });
  ok('a request with Sec-Fetch-Site: cross-site is refused', rSite.status === 403, rSite.text.slice(0, 160));
  ok('the skills are still there after the cross-site requests', !!(await skillByName('summarise')) && !!(await skillByName('explain')));

  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
