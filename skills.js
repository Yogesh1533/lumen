'use strict';
// Skills: a folder with a SKILL.md (YAML frontmatter with a name and a description) plus
// optional extra files. The folders live in <data>/skills/<name>/.
// The two built-in tools of Lumen only read: they never write, delete or run anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');

// The name of a skill becomes a folder name, so it is kept plain and short.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_BYTES = 30 * 1024 * 1024;   // 30 MB for the whole folder of one skill
const MAX_READ = 1024 * 1024;          // 1 MB that read_skill_file returns
const STARTER_DIR = path.join(__dirname, 'starter-skills');
// The limits of the zip reader for a skill bundle: the same 30 MB, measured on the bytes
// that come out of the inflation. The ratio limit of the general bundle reader (200) would
// refuse a file that is only zeroes, so here the byte limits do the work instead: a
// deflate stream can never expand more than about 1000:1, and 30 MB is the hard ceiling.
const ZIP_LIMITS = { maxTotalBytes: MAX_BYTES, maxFileBytes: MAX_BYTES, maxBundleBytes: MAX_BYTES, maxRatio: 2000 };

const validName = (name) => NAME_RE.test(String(name == null ? '' : name));
// The name is always handled as a string: it comes from a URL, from a form or from the model.
const asName = (name) => String(name == null ? '' : name);
const nameError = 'A skill name may only use a-z, 0-9, "-" and "_", and may be at most 40 characters long.';

// ---- the SKILL.md ---------------------------------------------------------------
// The frontmatter is a small block of "key: value" lines between two "---" lines.
function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const meta = {};
  let body = src;
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      meta[kv[1].toLowerCase()] = v;
    }
  }
  return { meta, body };
}
// The description is the one line of the frontmatter that goes into the system prompt.
function describe(text) {
  const { meta, body } = parseFrontmatter(text);
  let d = String(meta.description || '').split(/\r?\n/)[0].trim();
  if (!d) {
    // No description in the frontmatter: the first line of the body is used.
    for (const line of String(body).split(/\r?\n/)) {
      const t = line.replace(/^[#>\s*+-]+/, '').trim();
      if (t) { d = t; break; }
    }
  }
  return d.slice(0, 300);
}
const defaultSkillMd = (name) => [
  '---',
  'name: ' + name,
  'description: One line about what this skill is for.',
  '---',
  '',
  '# ' + name,
  '',
  'Write here what the model should do when this skill is used.',
  '',
].join('\n');

// ---- the files of a skill ----------------------------------------------------------
// Every file of the folder, with its size. A symlink is listed, but it is never read.
function walk(dir, rel) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names.sort()) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    const r = rel ? rel + '/' + n : n;
    if (st.isDirectory()) out.push(...walk(p, r));
    else out.push({ path: r, size: st.size, symlink: st.isSymbolicLink() });
  }
  return out;
}
const folderSize = (files) => files.reduce((n, f) => n + f.size, 0);
// A path inside a skill: no absolute path, no "..", no drive letter, no NUL.
function safeRel(p) {
  const raw = String(p == null ? '' : p);
  if (!raw || raw.includes('\0')) return null;
  const n = raw.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split('/').filter((x) => x && x !== '.');
  if (!parts.length) return null;
  for (const x of parts) if (x === '..') return null;
  return parts.join('/');
}

// ---- the skills themselves -----------------------------------------------------------
const skillDir = (root, name) => path.join(root, name);
const isEnabled = (settings, name) => {
  const rec = settings.skills && settings.skills[name];
  return !rec || rec.enabled !== false;
};
function setEnabled(settings, name, on) {
  if (!settings.skills || typeof settings.skills !== 'object') settings.skills = {};
  settings.skills[name] = { ...(settings.skills[name] || {}), enabled: !!on };
}

// Every skill that is on the disk.
function list(root, settings) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { names = []; }
  for (const name of names.sort()) {
    if (!validName(name)) continue;
    const dir = skillDir(root, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let content = '';
    try { content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { content = ''; }
    const files = walk(dir);
    out.push({
      name,
      description: describe(content),
      enabled: isEnabled(settings, name),
      files,
      size: folderSize(files),
      starter: fs.existsSync(path.join(STARTER_DIR, name)),
    });
  }
  return out;
}
// One skill with everything the browser needs.
function read(root, settings, name) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const dir = skillDir(root, name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('There is no skill called "' + name + '"');
  const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const files = walk(dir);
  return {
    name, description: describe(content), content, files,
    size: folderSize(files), enabled: isEnabled(settings, name),
  };
}
// A new skill: a folder with a SKILL.md.
function create(root, settings, body) {
  const name = asName(body && body.name).trim();
  if (!validName(name)) throw new Error(nameError);
  const dir = skillDir(root, name);
  if (fs.existsSync(dir)) throw new Error('There is already a skill called "' + name + '"');
  const content = typeof (body && body.content) === 'string' ? body.content : defaultSkillMd(name);
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('The SKILL.md is bigger than the limit of 30 MB (' + MAX_BYTES + ' bytes)');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, { mode: 0o600 });
  setEnabled(settings, name, true);
  return read(root, settings, name);
}
// Edit the SKILL.md of a skill and switch it on or off.
function update(root, settings, name, body) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const dir = skillDir(root, name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('There is no skill called "' + name + '"');
  if (body && typeof body.content === 'string') {
    const others = walk(dir).filter((f) => f.path !== 'SKILL.md');
    const size = Buffer.byteLength(body.content);
    if (folderSize(others) + size > MAX_BYTES) throw new Error('The skill would be bigger than the limit of 30 MB (' + MAX_BYTES + ' bytes)');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body.content, { mode: 0o600 });
  }
  if (body && typeof body.enabled === 'boolean') setEnabled(settings, name, body.enabled);
  return read(root, settings, name);
}
// Remove a skill and its folder.
function remove(root, settings, name) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const dir = skillDir(root, name);
  if (!fs.existsSync(dir)) throw new Error('There is no skill called "' + name + '"');
  fs.rmSync(dir, { recursive: true, force: true });
  if (settings.skills) delete settings.skills[name];
  return { ok: true };
}
// One more file in the folder of a skill.
function addFile(root, settings, name, relPath, buf) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const dir = skillDir(root, name);
  if (!fs.existsSync(dir)) throw new Error('There is no skill called "' + name + '"');
  const rel = safeRel(relPath);
  if (!rel) throw new Error('That is not a valid path inside a skill');
  const base = path.resolve(dir), target = path.resolve(base, ...rel.split('/'));
  if (!target.startsWith(base + path.sep)) throw new Error('That path would leave the folder of the skill');
  const current = folderSize(walk(dir));
  if (current + buf.length > MAX_BYTES) throw new Error('The skill would be bigger than the limit of 30 MB (' + MAX_BYTES + ' bytes)');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf, { mode: 0o600 });
  return { path: rel, size: buf.length };
}
// Remove one file of a skill.
function removeFile(root, settings, name, relPath) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const dir = skillDir(root, name);
  if (!fs.existsSync(dir)) throw new Error('There is no skill called "' + name + '"');
  const rel = safeRel(relPath);
  if (!rel) throw new Error('That is not a valid path inside a skill');
  const base = path.resolve(dir), target = path.resolve(base, ...rel.split('/'));
  if (!target.startsWith(base + path.sep)) throw new Error('That path would leave the folder of the skill');
  if (!fs.existsSync(target)) throw new Error('There is no file called "' + rel + '" in this skill');
  fs.rmSync(target, { recursive: true, force: true });
  return { ok: true };
}
// Unpack a zip into the folder of a skill. The bundle is unpacked into a folder of its own
// first: a bundle that is refused leaves nothing behind, and the skill of the user is only
// replaced when the bundle is good.
function extract(root, settings, name, buf) {
  name = asName(name).trim();
  if (!validName(name)) throw new Error(nameError);
  const staging = path.join(path.dirname(root), '.skills-upload-' + crypto.randomUUID());
  let inner = null;
  try {
    zip.extract(buf, staging, ZIP_LIMITS);
    // A bundle may hold the skill in a folder of its own: the SKILL.md is looked for.
    const files = walk(staging).map((f) => f.path);
    let src = staging;
    if (!files.includes('SKILL.md')) {
      const dirs = new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]));
      if (dirs.size === 1) {
        const d = [...dirs][0];
        if (files.includes(d + '/SKILL.md')) {
          inner = path.join(path.dirname(staging), path.basename(staging) + '-inner');
          fs.mkdirSync(inner, { recursive: true });
          for (const n of fs.readdirSync(path.join(staging, d))) fs.renameSync(path.join(staging, d, n), path.join(inner, n));
          fs.rmSync(staging, { recursive: true, force: true });
          src = inner;
        }
      }
    }
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('The bundle has no SKILL.md');
    const size = folderSize(walk(src));
    if (size > MAX_BYTES) throw new Error('The skill would be bigger than the limit of 30 MB (' + MAX_BYTES + ' bytes)');
    const dir = skillDir(root, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(src, dir);
  } finally {
    // Nothing of a refused bundle stays on the disk.
    for (const dir of [staging, inner]) {
      if (!dir) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    }
  }
  setEnabled(settings, name, isEnabled(settings, name));
  return read(root, settings, name);
}
// The starter skills: they are copied into the data folder once, and never overwritten.
function ensureStarters(root) {
  let names = [];
  try { names = fs.readdirSync(STARTER_DIR); } catch { return; }
  for (const name of names) {
    if (!validName(name)) continue;
    const src = path.join(STARTER_DIR, name), dir = skillDir(root, name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) continue; // the user may have edited it
    fs.mkdirSync(dir, { recursive: true });
    for (const f of walk(src)) {
      const target = path.join(dir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(src, ...f.path.split('/')), target);
    }
  }
}

// ---- the tools of the model -----------------------------------------------------
function tools() {
  return [
    {
      name: 'use_skill',
      description: 'Load a skill: returns the full text of its SKILL.md and the list of the files in it. Call it before you follow a skill.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The name of the skill, e.g. "summarise"' } }, required: ['name'] },
    },
    {
      name: 'read_skill_file',
      description: 'Read one file of a skill. The path is relative to the folder of the skill (e.g. "checklist.md").',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The name of the skill' }, path: { type: 'string', description: 'The path of the file inside the skill' } },
        required: ['name', 'path'],
      },
    },
  ];
}
// The skill must exist, and it must be switched on: a skill that is off is not in the
// system prompt and cannot be used.
function mustExist(root, settings, name) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const dir = skillDir(root, name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('There is no skill called "' + name + '"');
  if (!isEnabled(settings, name)) throw new Error('The skill "' + name + '" is switched off in Lumen');
  const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  return { name, dir, content, description: describe(content) };
}
// use_skill: the body of the SKILL.md and the list of the files.
function useSkill(root, settings, name) {
  const sk = mustExist(root, settings, name);
  const { body } = parseFrontmatter(sk.content);
  const files = walk(sk.dir);
  return [
    'Skill: ' + sk.name,
    'Description: ' + (sk.description || '(none)'),
    '',
    body.trim(),
    '',
    'Files in this skill (use read_skill_file to read one):',
    files.map((f) => '- ' + f.path + ' (' + f.size + ' bytes)').join('\n'),
  ].join('\n');
}
// read_skill_file: one file of a skill. The path must stay inside the folder of the skill.
function readSkillFile(root, settings, name, relPath) {
  const sk = mustExist(root, settings, name);
  const rel = safeRel(relPath);
  if (!rel) throw new Error('That is not a valid path inside a skill');
  const base = path.resolve(sk.dir), target = path.resolve(base, ...rel.split('/'));
  if (!target.startsWith(base + path.sep)) throw new Error('That path would leave the folder of the skill');
  let st;
  try { st = fs.lstatSync(target); } catch { throw new Error('There is no file called "' + rel + '" in this skill'); }
  if (st.isSymbolicLink()) throw new Error('A symlink is not read');
  if (st.isDirectory()) throw new Error('"' + rel + '" is a folder, not a file');
  // A symlink further up the path must not lead out of the folder either.
  const real = fs.realpathSync(target);
  let realBase;
  try { realBase = fs.realpathSync(base); } catch { realBase = base; }
  if (!real.startsWith(realBase + path.sep)) throw new Error('That path would leave the folder of the skill');
  const buf = fs.readFileSync(real);
  if (buf.includes(0)) throw new Error('"' + rel + '" is not a text file');
  let text = buf.toString('utf8');
  if (text.length > MAX_READ) text = text.slice(0, MAX_READ) + '\n…[truncated]';
  return text;
}
// The call of a tool of the skills server. Nothing is ever written here.
async function call(tool, args, ctx) {
  const root = ctx.root, settings = ctx.settings;
  try {
    if (tool === 'use_skill') return { isError: false, text: useSkill(root, settings, args && args.name) };
    if (tool === 'read_skill_file') return { isError: false, text: readSkillFile(root, settings, args && args.name, args && args.path) };
    return { isError: true, text: 'Unknown tool: ' + tool };
  } catch (e) {
    return { isError: true, text: String(e.message || e).slice(0, 500) };
  }
}

module.exports = {
  NAME_RE, MAX_BYTES, MAX_READ, validName, parseFrontmatter, describe,
  list, read, create, update, remove, addFile, removeFile, extract, ensureStarters,
  tools, call, useSkill, readSkillFile,
};
