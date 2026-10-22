// Step 10 — skills: the skills tools (use_skill, read_skill_file), the Skills dialog,
// the limits (30 MB per skill) and the approval flow.
const { launch, sleep } = require('./lib/cdplib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
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
// A second Lumen with the same data folder: this is the code path of a restart.
async function startServer(port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LUMEN_DATA: DATA_FILE },
    stdio: 'ignore',
  });
  const url = 'http://127.0.0.1:' + port;
  let okUp = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/api/config'); if (r.ok) { okUp = true; break; } } catch { /* not up yet */ }
    await sleep(100);
  }
  const call2 = async (method, u, body) => {
    const r = await fetch(url + u, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  return {
    ok: okUp, url, call: call2,
    stop: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}
// A snapshot of a folder: every file with its size, its mtime and its content. It is
// used to prove that a tool only reads.
function snapshotDir(dir) {
  const out = {};
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = path.join(d, n);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      const r = rel ? rel + '/' + n : n;
      if (st.isSymbolicLink()) { out[r] = { link: fs.readlinkSync(p) }; continue; }
      if (st.isDirectory()) { walk(p, r); continue; }
      out[r] = { size: st.size, mtime: st.mtimeMs, hash: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') };
    }
  };
  walk(dir, '');
  return JSON.stringify(out);
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
  const { ev, ok, waitFor, shot, setFiles } = h;
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
  // The tool only reads: the folder of the skill must be the same before and after.
  const beforeUse = snapshotDir(path.join(SKILLS_DIR, 'summarise'));
  const use = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: 'summarise' } });
  ok('use_skill answers', !!use.json && use.json.isError === false, use.text.slice(0, 200));
  const useText = (use.json && use.json.text) || '';
  ok('use_skill returns the body of the skill', /pass/i.test(useText), useText.slice(0, 200));
  ok('use_skill lists the files of the skill', /checklist\.md/.test(useText), useText.slice(-200));
  const afterUse = snapshotDir(path.join(SKILLS_DIR, 'summarise'));
  ok('use_skill does not change the folder of the skill', beforeUse === afterUse && beforeUse.length > 10, afterUse.slice(0, 300));
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
  // The model asked for a tool called use_skill (whatever the tool answered is checked
  // by the next assertion).
  ok('the model called a tool named use_skill', !!(r1 && r1.used), JSON.stringify(r1 && r1.calls && r1.calls.map((c) => [c.tool, c.status])));
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
    ['POST', '/api/skills/upload'], ['POST', '/api/skills/summarise/files'], ['GET', '/api/skills/summarise'],
    ['DELETE', '/api/skills/summarise/files?path=checklist.md']]) {
    const r = await call(method, url, {}, { origin: 'http://evil.example' });
    ok(`a cross-site ${method} ${url} is refused`, r.status === 403, r.text.slice(0, 160));
  }
  const rSite = await call('GET', '/api/skills', undefined, { 'sec-fetch-site': 'cross-site' });
  ok('a request with Sec-Fetch-Site: cross-site is refused', rSite.status === 403, rSite.text.slice(0, 160));
  ok('the skills are still there after the cross-site requests', !!(await skillByName('summarise')) && !!(await skillByName('explain')));
  ok('the file of a skill was not deleted by the cross-site request', fs.existsSync(path.join(SKILLS_DIR, 'summarise', 'checklist.md')));

  // ---- 13. a starter that is deleted stays deleted; one that is edited stays edited ----
  {
    // The user switches a starter off and deletes it.
    const off = await call('PUT', '/api/skills/summarise', { enabled: false });
    ok('a starter can be switched off', off.status === 200 && off.json.enabled === false, off.text.slice(0, 160));
    const del = await call('DELETE', '/api/skills/summarise');
    ok('a starter can be deleted', del.status === 200, del.text.slice(0, 160));
    ok('the folder of the deleted starter is gone', !fs.existsSync(path.join(SKILLS_DIR, 'summarise')));
    // The name keeps a tombstone in the settings, so the starter is not copied over it.
    // The server writes the settings with a short delay, so the file is read after it.
    await sleep(500);
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    const tomb = (saved.skills || {}).summarise;
    ok('the deleted starter is remembered as deleted', !!(tomb && tomb.removed === true), JSON.stringify(tomb));
    ok('the deleted starter is not switched on again', !!(tomb && tomb.enabled === false), JSON.stringify(tomb));

    // The other starter is edited.
    const expl = await call('GET', '/api/skills/explain');
    const marked = (expl.json.content || '') + '\nEDITED BY THE TEST\n';
    const ed = await call('PUT', '/api/skills/explain', { content: marked });
    ok('a starter can be edited', ed.status === 200 && /EDITED BY THE TEST/.test(ed.json.content || ''), ed.text.slice(0, 160));

    // A leftover of an upload that crashed: it is swept away at the start.
    const stale = path.join(SKILLS_DIR, '.staging-stale');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'half.txt'), 'half a file');

    // A restart: a second Lumen with the same data folder.
    const s2 = await startServer(3196);
    ok('the server starts again', s2.ok, 'the second server did not come up');
    const list2 = await s2.call('GET', '/api/skills');
    const names2 = ((list2.json || {}).skills || []).map((s) => s.name);
    ok('a deleted starter does not come back after a restart', !names2.includes('summarise'), names2.join(','));
    ok('the deleted starter is not in the list of the user', !(await skillByName('summarise')));
    const expl2 = await s2.call('GET', '/api/skills/explain');
    ok('an edited starter is still there after a restart', /EDITED BY THE TEST/.test((expl2.json || {}).content || ''),
      String((expl2.json || {}).content || '').slice(-120));
    ok('a leftover of an upload is swept away at the start', !fs.existsSync(stale));
    s2.stop();
  }

  // ---- 14. an upload that replaces a skill of the same name --------------------
  {
    const created = await call('POST', '/api/skills', { name: 'replace-me', content: '---\nname: replace-me\ndescription: The old skill.\n---\n\nOLD BODY\n' });
    ok('the skill that is replaced exists', created.status === 200, created.text.slice(0, 160));
    const add = await call('POST', '/api/skills/replace-me/files', { path: 'notes.md', data: Buffer.from('OLD CONTENT').toString('base64') });
    ok('the skill has a file of its own', add.status === 200, add.text.slice(0, 160));

    const bundle = zip([
      { name: 'SKILL.md', data: '---\nname: replace-me\ndescription: The new skill.\n---\n\nNEW BODY\n' },
      { name: 'new.md', data: 'NEW CONTENT' },
    ]);
    const up = await call('POST', '/api/skills/upload', { name: 'replace-me', file: bundle.toString('base64') });
    ok('a zip can replace a skill of the same name', up.status === 200, up.text.slice(0, 200));
    ok('the old file of the skill is gone', !fs.existsSync(path.join(SKILLS_DIR, 'replace-me', 'notes.md')));
    ok('the new file of the skill is there', fs.existsSync(path.join(SKILLS_DIR, 'replace-me', 'new.md')));
    ok('the new content is in place', fs.readFileSync(path.join(SKILLS_DIR, 'replace-me', 'new.md'), 'utf8') === 'NEW CONTENT');
    const reRead = await call('GET', '/api/skills/replace-me');
    ok('the description of the new skill is in place', /The new skill/.test((reRead.json || {}).description || ''), (reRead.json || {}).description);

    // A refused bundle must not destroy the skill that is there.
    const bad = zip([{ name: '../escape.md', data: 'gotcha' }, { name: 'SKILL.md', data: '---\nname: replace-me\ndescription: bad\n---\n' }]);
    const badRes = await call('POST', '/api/skills/upload', { name: 'replace-me', file: bad.toString('base64') });
    ok('a refused bundle that would replace a skill is refused', badRes.status === 400, badRes.text.slice(0, 200));
    ok('the skill is still there after the refused bundle', fs.existsSync(path.join(SKILLS_DIR, 'replace-me', 'new.md')));
    ok('the content of the skill is untouched', fs.readFileSync(path.join(SKILLS_DIR, 'replace-me', 'new.md'), 'utf8') === 'NEW CONTENT');
  }

  // ---- 15. the dialog warns before it replaces a skill ------------------------
  {
    // A zip on the disk, for the file picker of the dialog.
    const zipPath = path.join(TMP, 'replace-ui.zip');
    fs.writeFileSync(zipPath, zip([
      { name: 'SKILL.md', data: '---\nname: replace-me\ndescription: The new skill from the dialog.\n---\n\nNEW BODY\n' },
      { name: 'ui.md', data: 'UI CONTENT' },
    ]));
    await ev(`loadSkills().then(() => 1)`);
    // The dialog asks with prompt() and confirm(): both are stubbed, so the test sees
    // what the user would see.
    await ev(`(() => {
      window.__prompts = []; window.__confirms = [];
      window.prompt = (m, d) => { window.__prompts.push(String(m)); return window.__promptAnswer || d; };
      window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAnswer !== false; };
      window.__promptAnswer = 'replace-me'; window.__confirmAnswer = false;
      return 1;
    })()`);
    await h.setFiles('#skillZipInput', [zipPath]);
    await ev(`(() => { document.querySelector('#skillZipInput').dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(2000);
    const confirms = String(await ev(`JSON.stringify(window.__confirms)`));
    ok('the dialog warns before it replaces a skill', /replace-me/.test(confirms) && /replac/i.test(confirms), confirms.slice(0, 300));
    ok('the warning says what is lost', /file/i.test(confirms), confirms.slice(0, 300));
    ok('a cancelled upload does not replace the skill',
      !fs.existsSync(path.join(SKILLS_DIR, 'replace-me', 'ui.md')) && fs.existsSync(path.join(SKILLS_DIR, 'replace-me', 'new.md')));
    // And with the answer "yes" the skill is replaced.
    await ev(`window.__confirmAnswer = true; 1`);
    await h.setFiles('#skillZipInput', [zipPath]);
    await ev(`(() => { document.querySelector('#skillZipInput').dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(2500);
    ok('an accepted upload replaces the skill', fs.existsSync(path.join(SKILLS_DIR, 'replace-me', 'ui.md')),
      fs.readdirSync(path.join(SKILLS_DIR, 'replace-me')).join(','));
  }

  // ---- 16. a symlink never leads out of the skills folder ----------------------
  {
    // A skill folder that is a symlink to a folder outside data/skills.
    const outside = path.join(TMP, 'outside-skill');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: linked-skill\ndescription: OUTSIDE SKILL\n---\n\nSECRET OUTSIDE CONTENT\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET OUTSIDE CONTENT');
    const linkDir = path.join(SKILLS_DIR, 'linked-skill');
    try { fs.unlinkSync(linkDir); } catch { /* not there */ }
    fs.symlinkSync(outside, linkDir, 'dir');
    const l = (await call('GET', '/api/skills')).json || {};
    ok('a skill that is a symlink is not in the list', !(l.skills || []).some((s) => s.name === 'linked-skill'),
      JSON.stringify((l.skills || []).map((s) => s.name)));
    const useLink = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: 'linked-skill' } });
    ok('a skill that is a symlink cannot be used', useLink.json && useLink.json.isError === true && !/SECRET OUTSIDE/.test(useLink.json.text || ''),
      useLink.text.slice(0, 200));
    const readLink = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: 'linked-skill', path: 'secret.txt' } });
    ok('a file of a symlinked skill cannot be read', readLink.json && readLink.json.isError === true && !/SECRET OUTSIDE/.test(readLink.json.text || ''),
      readLink.text.slice(0, 200));

    // A symlinked folder inside a skill: a write, a delete and a read through it.
    const target = path.join(TMP, 'outside-dir');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'DO NOT TOUCH');
    const sub = path.join(SKILLS_DIR, 'replace-me', 'sub');
    try { fs.unlinkSync(sub); } catch { /* not there */ }
    fs.symlinkSync(target, sub, 'dir');
    const addSub = await call('POST', '/api/skills/replace-me/files', { path: 'sub/evil.md', data: Buffer.from('gotcha').toString('base64') });
    ok('a write through a symlinked folder is refused', addSub.status === 400, addSub.text.slice(0, 200));
    ok('nothing was written through the symlink', !fs.existsSync(path.join(target, 'evil.md')));
    const delSub = await call('DELETE', '/api/skills/replace-me/files?path=' + encodeURIComponent('sub/keep.txt'));
    ok('a delete through a symlinked folder is refused', delSub.status === 400, delSub.text.slice(0, 200));
    ok('the file outside was not deleted', fs.existsSync(path.join(target, 'keep.txt')));
    const readSub = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: 'replace-me', path: 'sub/keep.txt' } });
    ok('a read through a symlinked folder is refused', readSub.json && readSub.json.isError === true && !/DO NOT TOUCH/.test(readSub.json.text || ''),
      readSub.text.slice(0, 200));
  }

  // ---- 17. read_skill_file returns at most 1 MB --------------------------------
  {
    const created = await call('POST', '/api/skills', { name: 'bigread', content: '---\nname: bigread\ndescription: A file that is too big to read.\n---\n' });
    ok('the skill for the read limit exists', created.status === 200, created.text.slice(0, 160));
    // 1.5 MB of a three-byte character: half a million characters, but 1.5 MB of bytes.
    const cjk = Buffer.from('日'.repeat(500000), 'utf8');
    const add = await call('POST', '/api/skills/bigread/files', { path: 'cjk.txt', data: cjk.toString('base64') });
    ok('the big file can be added to the skill', add.status === 200, add.text.slice(0, 160));
    const rf = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'read_skill_file', arguments: { name: 'bigread', path: 'cjk.txt' } });
    const text = (rf.json || {}).text || '';
    ok('the big file is read', rf.json && rf.json.isError !== true && text.length > 0, rf.text.slice(0, 200));
    ok('the read is cut off at 1 MB of bytes', Buffer.byteLength(text, 'utf8') <= 1024 * 1024 + 64, String(Buffer.byteLength(text, 'utf8')));
    ok('the cut off says so', /truncat/i.test(text), text.slice(-60));
  }

  // ---- 18. no skill on, no skills server ----------------------------------------
  {
    const all = ((await call('GET', '/api/skills')).json || {}).skills || [];
    for (const s of all) await call('PUT', '/api/skills/' + encodeURIComponent(s.name), { enabled: false });
    const mcp2 = await call('GET', '/api/mcp');
    ok('the skills server is hidden when no skill is on', !((mcp2.json || [])).some((s) => s.id === 'skills'),
      JSON.stringify((mcp2.json || []).map((s) => s.id)));
    await ev(`loadMcp().then(() => 1)`);
    const tn = await ev(`JSON.stringify((buildTools() || { defs: [] }).defs.map((d) => d.function.name))`);
    ok('no skills tool is sent to the model', !/skills__/.test(tn), tn);
    await call('PUT', '/api/skills/explain', { enabled: true });
    const mcp3 = await call('GET', '/api/mcp');
    ok('the skills server is there again when a skill is on', ((mcp3.json || [])).some((s) => s.id === 'skills'),
      JSON.stringify((mcp3.json || []).map((s) => s.id)));
  }

  // ---- 19. the upload never writes outside the skills folder ---------------------
  {
    const before = fs.readdirSync(DATA_DIR).sort().join(',');
    const bundle = zip([
      { name: 'SKILL.md', data: '---\nname: staged\ndescription: A skill that is staged.\n---\n' },
      { name: 'notes.md', data: 'notes' },
    ]);
    const up = await call('POST', '/api/skills/upload', { name: 'staged', file: bundle.toString('base64') });
    ok('the zip is uploaded', up.status === 200, up.text.slice(0, 160));
    ok('nothing was written next to the skills folder', fs.readdirSync(DATA_DIR).sort().join(',') === before,
      fs.readdirSync(DATA_DIR).sort().join(','));
    ok('no staging folder is left in the skills folder',
      !fs.readdirSync(SKILLS_DIR).some((n) => n.startsWith('.staging-')), fs.readdirSync(SKILLS_DIR).join(','));
    const bad = zip([{ name: '../escape.md', data: 'gotcha' }, { name: 'SKILL.md', data: '---\nname: staged2\ndescription: bad\n---\n' }]);
    const badRes = await call('POST', '/api/skills/upload', { name: 'staged2', file: bad.toString('base64') });
    ok('the refused bundle is refused', badRes.status === 400, badRes.text.slice(0, 160));
    ok('nothing was written next to the skills folder after the refusal', fs.readdirSync(DATA_DIR).sort().join(',') === before,
      fs.readdirSync(DATA_DIR).sort().join(','));
    ok('no staging folder is left after the refusal', !fs.readdirSync(SKILLS_DIR).some((n) => n.startsWith('.staging-')),
      fs.readdirSync(SKILLS_DIR).join(','));
  }

  // ---- 20. a zip whose SKILL.md is in a folder of its own ------------------------
  {
    const bundle = zip([
      { name: 'inner-skill/SKILL.md', data: '---\nname: inner-skill\ndescription: A skill in a folder of its own.\n---\n\nINNER BODY\n' },
      { name: 'inner-skill/notes.md', data: 'INNER NOTES' },
    ]);
    const up = await call('POST', '/api/skills/upload', { name: 'inner-skill', file: bundle.toString('base64') });
    ok('a zip with the SKILL.md in a folder of its own is uploaded', up.status === 200 && up.json.name === 'inner-skill', up.text.slice(0, 200));
    ok('the folder of the bundle is unwrapped',
      fs.existsSync(path.join(SKILLS_DIR, 'inner-skill', 'SKILL.md')) && fs.existsSync(path.join(SKILLS_DIR, 'inner-skill', 'notes.md')),
      fs.existsSync(path.join(SKILLS_DIR, 'inner-skill')) ? fs.readdirSync(path.join(SKILLS_DIR, 'inner-skill')).join(',') : 'no folder');
    const useInner = await call('POST', '/api/mcp/call', { server: 'skills', tool: 'use_skill', arguments: { name: 'inner-skill' } });
    ok('the skill of the bundle can be used', useInner.json && useInner.json.isError !== true && /INNER BODY/.test(useInner.json.text || ''),
      useInner.text.slice(0, 200));
  }

  // ---- 21. the API through the browser's own fetch --------------------------------
  // The calls above come from Node, with the headers a browser sends. These come from
  // the page itself, so the browser adds its own Host, Origin and Sec-Fetch-Site
  // headers and the request goes through guard() the way a request of the user does.
  {
    const raw = await ev(`(async () => {
      const out = {};
      const j = async (p, o) => {
        const r = await fetch('/api' + p, { ...o, headers: { 'content-type': 'application/json' } });
        let body = null; try { body = await r.json(); } catch (e) { body = null; }
        return { status: r.status, body };
      };
      const list = await j('/skills');
      out.list = list.status;
      out.names = ((list.body && list.body.skills) || []).map(s => s.name);
      const made = await j('/skills', { method: 'POST', body: JSON.stringify({ name: 'browser-skill' }) });
      out.made = made.status;
      out.madeName = made.body && made.body.name;
      const off = await j('/skills/browser-skill', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
      out.off = off.status;
      out.offEnabled = off.body && off.body.enabled;
      const gone = await j('/skills/browser-skill', { method: 'DELETE' });
      out.gone = gone.status;
      // A body that is not JSON is refused by the guard, like a cross-site form post.
      const notJson = await fetch('/api/skills', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'name=evil' });
      out.notJson = notJson.status;
      return JSON.stringify(out);
    })()`);
    let b = {};
    try { b = JSON.parse(raw); } catch { /* the page threw */ }
    ok('the browser reaches the skills route', b.list === 200, String(raw).slice(0, 200));
    ok('the browser sees the skills that are there, and not the deleted one',
      Array.isArray(b.names) && b.names.includes('explain') && !b.names.includes('summarise'), JSON.stringify(b.names));
    ok('a skill can be created from the browser', b.made === 200 && b.madeName === 'browser-skill', String(b.made) + ' ' + String(b.madeName));
    ok('a skill can be switched off from the browser', b.off === 200 && b.offEnabled === false, String(b.off) + ' ' + String(b.offEnabled));
    ok('a skill can be deleted from the browser', b.gone === 200, String(b.gone));
    ok('a body that is not JSON is refused in the browser too', b.notJson === 415, String(b.notJson));
    ok('the skill of the browser is really gone', !fs.existsSync(path.join(SKILLS_DIR, 'browser-skill')));
  }

  h.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
