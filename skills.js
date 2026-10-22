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
// The real path of the root of the skills. Every path of a skill must stay inside it:
// a skill folder that is a symlink to a folder outside is not a skill.
const realRoot = (root) => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };
// Is this path inside the real root of the skills?
const insideRoot = (root, p) => {
  const rr = realRoot(root);
  return !!p && (p === rr || p.startsWith(rr + path.sep));
};
// The path of a file inside a skill. Every segment of the path is checked: a symlink in
// the way is refused, and the real path of the target must stay inside the real root of
// the skills — not inside the folder of the skill, which may itself be a symlink.
function safeInside(root, dir, rel) {
  const base = path.resolve(dir);
  // The folder of the skill is a segment of the path too: a symlink in the way is
  // refused, never followed.
  let bst = null;
  try { bst = fs.lstatSync(base); } catch { bst = null; }
  if (bst && bst.isSymbolicLink()) throw new Error('A symlink is not used');
  let realBase = null;
  try { realBase = fs.realpathSync(base); } catch { realBase = null; }
  if (!realBase) throw new Error('There is no skill called "' + path.basename(base) + '"');
  if (!insideRoot(root, realBase)) throw new Error('That path would leave the folder of the skills');
  let cur = base;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st = null;
    try { st = fs.lstatSync(cur); } catch { st = null; } // the last part may be new
    if (st && st.isSymbolicLink()) throw new Error('A symlink is not used');
    // A folder on the way that is not a folder: the path cannot be the path of a
    // file. It is refused here, and not by a crash of the file system further on.
    if (st && i < parts.length - 1 && !st.isDirectory()) throw new Error('That path is not a folder');
  }
  let real = null;
  try { real = fs.realpathSync(cur); } catch { real = null; }
  if (real && !insideRoot(root, real)) throw new Error('That path would leave the folder of the skills');
  return { base, target: cur };
}
// The folder of a skill. The folder is a path too: it must be a real folder inside the
// real root of the skills. A symlink in the way is refused, and the real path of the
// folder must stay inside the real root of the skills. A folder that is not there yet
// is not trusted because it does not exist: the parent is proved instead, and the name
// itself is refused when it is a symlink.
function skillFolder(root, name, opts) {
  opts = opts || {};
  const dir = skillDir(root, name);
  let st = null;
  try { st = fs.lstatSync(dir); } catch { st = null; }
  // A symlink in the way is never used, not even when it points inside the skills.
  if (st && st.isSymbolicLink()) throw new Error('A symlink is not used');
  if (!st) {
    if (!opts.create) throw new Error('There is no skill called "' + name + '"');
    // The folder of the skills is Lumen's own: it is made when it is not there yet.
    try { fs.mkdirSync(root, { recursive: true }); } catch { /* the folder cannot be made */ }
    // The folder is not there yet: the parent is proved, so that a folder that is made
    // later cannot land outside the real root.
    const parent = path.dirname(dir);
    let pst = null;
    try { pst = fs.statSync(parent); } catch { pst = null; }
    if (!pst || !pst.isDirectory()) throw new Error('There is no folder of skills');
    let realParent = null;
    try { realParent = fs.realpathSync(parent); } catch { realParent = null; }
    if (!realParent || !insideRoot(root, realParent)) throw new Error('That path would leave the folder of the skills');
    return { dir, exists: false };
  }
  if (!st.isDirectory()) {
    throw new Error(opts.create ? 'There is already a skill called "' + name + '"' : 'There is no skill called "' + name + '"');
  }
  // The real path of the folder must be inside the real root of the skills.
  let real = null;
  try { real = fs.realpathSync(dir); } catch { real = null; }
  if (!real || !insideRoot(root, real)) throw new Error('That path would leave the folder of the skills');
  return { dir, exists: true };
}
// The SKILL.md of a skill. A SKILL.md that is a symlink is never written: the write
// would follow it out of the folder of the skill.
function skillMdPath(root, dir) {
  const p = path.join(dir, 'SKILL.md');
  let st = null;
  try { st = fs.lstatSync(p); } catch { st = null; }
  if (st && st.isSymbolicLink()) throw new Error('A symlink is not used');
  return p;
}
// The SKILL.md of a skill. A symlink is never read.
function readSkillMd(root, dir) {
  const p = path.join(dir, 'SKILL.md');
  let st = null;
  try { st = fs.lstatSync(p); } catch { st = null; }
  if (!st || st.isSymbolicLink()) return '';
  let real = null;
  try { real = fs.realpathSync(p); } catch { real = null; }
  if (!real || !insideRoot(root, real)) return '';
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
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
// A skill that the user deleted keeps a tombstone, so it is never copied over again.
const isRemoved = (settings, name) => !!(settings.skills && settings.skills[name] && settings.skills[name].removed);
function setEnabled(settings, name, on) {
  if (!settings.skills || typeof settings.skills !== 'object') settings.skills = {};
  settings.skills[name] = { ...(settings.skills[name] || {}), enabled: !!on };
}
// The name stays in the settings as deleted: the starter skills are not installed again.
function markRemoved(settings, name) {
  if (!settings.skills || typeof settings.skills !== 'object') settings.skills = {};
  settings.skills[name] = { ...(settings.skills[name] || {}), enabled: false, removed: true };
}

// Every skill that is on the disk.
function list(root, settings) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { names = []; }
  for (const name of names.sort()) {
    if (!validName(name)) continue;
    if (isRemoved(settings, name)) continue; // a deleted skill stays deleted
    const dir = skillDir(root, name);
    let st;
    try { st = fs.lstatSync(dir); } catch { continue; }
    // A symlink is never a skill, not even when it points inside the skills.
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    // A skill folder that is a symlink to a folder outside the skills is not a skill.
    let realDir = null;
    try { realDir = fs.realpathSync(dir); } catch { realDir = null; }
    if (!realDir || !insideRoot(root, realDir)) continue;
    const content = readSkillMd(root, dir);
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
// Is there a skill that the model may use? Without one the skills tools are not offered.
function anyEnabled(root, settings) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return false; }
  for (const name of names) {
    if (!validName(name)) continue;
    if (isRemoved(settings, name)) continue;
    if (!isEnabled(settings, name)) continue;
    const dir = skillDir(root, name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    // A symlink is never a skill, not even when it points inside the skills.
    let ast = null;
    try { ast = fs.lstatSync(dir); } catch { ast = null; }
    if (!ast || !ast.isDirectory() || ast.isSymbolicLink()) continue;
    // A skill folder that is a symlink to a folder outside the skills is not a skill.
    let realDir = null;
    try { realDir = fs.realpathSync(dir); } catch { realDir = null; }
    if (!realDir || !insideRoot(root, realDir)) continue;
    return true;
  }
  return false;
}
// One skill with everything the browser needs.
function read(root, settings, name) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  // The folder of the skill is a path too: a skill folder that is a symlink is not a
  // skill, and the file names of the folder outside are never given.
  const { dir } = skillFolder(root, name);
  const md = skillMdPath(root, dir);
  if (!fs.existsSync(md)) throw new Error('There is no skill called "' + name + '"');
  const content = readSkillMd(root, dir);
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
  // The name is proved before anything is written: a name that is a symlink is refused,
  // and a name that is not there is not trusted because it does not exist.
  const { dir } = skillFolder(root, name, { create: true });
  if (fs.existsSync(dir)) throw new Error('There is already a skill called "' + name + '"');
  const content = typeof (body && body.content) === 'string' ? body.content : defaultSkillMd(name);
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('The SKILL.md is bigger than the limit of 30 MB (' + MAX_BYTES + ' bytes)');
  fs.mkdirSync(dir, { recursive: true });
  // The folder that was made is proved again: only then is the SKILL.md written.
  skillFolder(root, name);
  fs.writeFileSync(skillMdPath(root, dir), content, { mode: 0o600 });
  // A name that was deleted before is a new skill now: the tombstone goes.
  if (!settings.skills || typeof settings.skills !== 'object') settings.skills = {};
  settings.skills[name] = { enabled: true };
  return read(root, settings, name);
}
// Edit the SKILL.md of a skill and switch it on or off.
function update(root, settings, name, body) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const { dir } = skillFolder(root, name);
  // A SKILL.md that is a symlink is never written: the write would follow it out of
  // the folder of the skill.
  const md = skillMdPath(root, dir);
  if (!fs.existsSync(md)) throw new Error('There is no skill called "' + name + '"');
  if (body && typeof body.content === 'string') {
    const others = walk(dir).filter((f) => f.path !== 'SKILL.md');
    const size = Buffer.byteLength(body.content);
    if (folderSize(others) + size > MAX_BYTES) throw new Error('The skill would be bigger than the limit of 30 MB (' + MAX_BYTES + ' bytes)');
    fs.writeFileSync(md, body.content, { mode: 0o600 });
  }
  if (body && typeof body.enabled === 'boolean') setEnabled(settings, name, body.enabled);
  return read(root, settings, name);
}
// Remove a skill and its folder. The name keeps a tombstone, so a starter skill that
// the user deleted is not installed again at the next start.
function remove(root, settings, name) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const { dir } = skillFolder(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  markRemoved(settings, name);
  return { ok: true };
}
// One more file in the folder of a skill.
function addFile(root, settings, name, relPath, buf) {
  name = asName(name);
  if (!validName(name)) throw new Error(nameError);
  const { dir } = skillFolder(root, name);
  const rel = safeRel(relPath);
  if (!rel) throw new Error('That is not a valid path inside a skill');
  const { target } = safeInside(root, dir, rel);
  // A folder is not a file: the write is refused here, and not by a crash of the
  // file system further on.
  let tst = null;
  try { tst = fs.lstatSync(target); } catch { tst = null; }
  if (tst && tst.isDirectory()) throw new Error('That path is a folder, not a file');
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
  const { dir } = skillFolder(root, name);
  const rel = safeRel(relPath);
  if (!rel) throw new Error('That is not a valid path inside a skill');
  const { target } = safeInside(root, dir, rel);
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
  // The bundle is unpacked inside the folder of the skills: Lumen never writes next to
  // it. The name of the folder is not a skill name, so it is never listed.
  const staging = path.join(root, '.staging-' + crypto.randomUUID());
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
          inner = path.join(root, '.staging-' + crypto.randomUUID() + '-inner');
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
    // A skill folder that is a symlink is not a skill: a bundle never replaces it, and
    // the folder outside is never touched.
    let dst = null;
    try { dst = fs.lstatSync(dir); } catch { dst = null; }
    if (dst && dst.isSymbolicLink()) throw new Error('A symlink is not used');
    // The old folder is moved aside first and only deleted when the new one is in
    // place: a bundle that fails on the way leaves the skill of the user untouched.
    const backup = dir + '.old-' + crypto.randomUUID();
    let hadOld = false;
    if (dst) { fs.renameSync(dir, backup); hadOld = true; }
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(src, dir);
    } catch (e) {
      if (hadOld) { try { fs.renameSync(backup, dir); } catch { /* the old folder stays where it is */ } }
      throw e;
    }
    // The new folder is proved before the old one is deleted: it must be a real folder
    // inside the real root of the skills.
    skillFolder(root, name);
    if (hadOld) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* nothing to clean */ } }
  } finally {
    // Nothing of a refused bundle stays on the disk.
    for (const dir of [staging, inner]) {
      if (!dir) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    }
  }
  if (isRemoved(settings, name)) {
    // The user uploads this name again: the skill is a new one, so it is on.
    if (!settings.skills || typeof settings.skills !== 'object') settings.skills = {};
    settings.skills[name] = { enabled: true };
  } else {
    setEnabled(settings, name, isEnabled(settings, name));
  }
  return read(root, settings, name);
}
// The starter skills: they are copied into the data folder once, and never overwritten.
// A starter that the user deleted stays deleted (the name keeps a tombstone).
function ensureStarters(root, settings) {
  let names = [];
  try { names = fs.readdirSync(STARTER_DIR); } catch { return; }
  for (const name of names) {
    if (!validName(name)) continue;
    if (settings && isRemoved(settings, name)) continue;
    const src = path.join(STARTER_DIR, name);
    // The folder of the starter is a path too: a starter folder that is a symlink is
    // not written into, and the folder outside is never touched.
    let dir;
    try { dir = skillFolder(root, name, { create: true }).dir; } catch { continue; }
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) continue; // the user may have edited it
    fs.mkdirSync(dir, { recursive: true });
    // The folder that was made is proved again before the starter is copied into it.
    try { skillFolder(root, name); } catch { continue; }
    // The source of the copy is ours; the target is not. It is proved like every
    // other write of a skill: a symlink in the way is refused, and the real path of
    // the target must stay inside the real root of the skills. The SKILL.md decides:
    // when its target cannot be proved the whole starter is refused, because a
    // folder without a SKILL.md is not a skill. Every other file is refused on its
    // own, and the rest of the starter is installed.
    let mdTarget;
    try { mdTarget = safeInside(root, dir, 'SKILL.md').target; }
    catch { continue; }
    try {
      fs.mkdirSync(path.dirname(mdTarget), { recursive: true });
      fs.copyFileSync(path.join(src, 'SKILL.md'), mdTarget);
    } catch { continue; }
    for (const f of walk(src)) {
      if (f.path === 'SKILL.md') continue;
      let target;
      try { target = safeInside(root, dir, f.path).target; }
      catch { continue; }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(src, ...f.path.split('/')), target);
      } catch { /* the file could not be written; the rest of the starter is installed */ }
    }
  }
}
// A leftover of the disk is removed. A symlink is removed as a link: the folder it
// points at is never touched.
function removeLeftover(p) {
  let st = null;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) {
    try { fs.unlinkSync(p); } catch { /* nothing to clean */ }
    return;
  }
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* nothing to clean */ }
}
// The leftovers of an upload that a crash left behind are swept away at the start: the
// staging folder of a bundle, and the backup folder of a skill that was replaced. If
// the skill is there, the backup is a leftover and goes; if the skill is not there,
// the backup is the skill, and it is put back.
function sweepStaging(root, settings) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names) {
    if (n.startsWith('.staging-')) {
      removeLeftover(path.join(root, n));
      continue;
    }
    // The backup of a replaced skill: "<name>.old-<uuid>".
    const m = n.match(/^([a-z0-9][a-z0-9_-]{0,39})\.old-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    if (!m) continue;
    const name = m[1];
    const dir = path.join(root, name);
    const backup = path.join(root, n);
    let st = null;
    try { st = fs.lstatSync(dir); } catch { st = null; }
    if (st || (settings && isRemoved(settings, name))) {
      // The skill is there (or the user deleted it): the backup is a leftover and goes.
      removeLeftover(backup);
    } else {
      // The skill is not there: the backup is the skill, and it is put back. A backup
      // that is a symlink is not a skill: it is not put back under a skill name, and
      // the folder outside is never touched. The link itself is removed.
      let bst = null;
      try { bst = fs.lstatSync(backup); } catch { bst = null; }
      if (!bst || bst.isSymbolicLink() || !bst.isDirectory()) {
        removeLeftover(backup);
        continue;
      }
      try { fs.renameSync(backup, dir); } catch { continue; }
      // The folder that was put back is proved like every other folder of a skill:
      // it must be a real folder inside the real root of the skills. If it is not,
      // the backup goes back to where it was.
      try { skillFolder(root, name); }
      catch { try { fs.renameSync(dir, backup); } catch { /* it stays where it is */ } }
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
  // The folder of the skill must be a real folder inside the skills: a skill folder that
  // is a symlink to a folder outside is not a skill of the user.
  const { dir } = skillFolder(root, name);
  const md = skillMdPath(root, dir);
  if (!fs.existsSync(md)) throw new Error('There is no skill called "' + name + '"');
  if (!isEnabled(settings, name)) throw new Error('The skill "' + name + '" is switched off in Lumen');
  const content = readSkillMd(root, dir);
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
  // Every segment of the path is checked: a symlink in the way is refused, and the real
  // path must stay inside the real root of the skills.
  const { target } = safeInside(root, sk.dir, rel);
  let st;
  try { st = fs.lstatSync(target); } catch { throw new Error('There is no file called "' + rel + '" in this skill'); }
  if (st.isSymbolicLink()) throw new Error('A symlink is not read');
  if (st.isDirectory()) throw new Error('"' + rel + '" is a folder, not a file');
  // The cap is counted in bytes, and a file that is too big is cut off on the disk: it
  // is never read whole.
  let buf;
  if (st.size > MAX_READ) {
    const fd = fs.openSync(target, 'r');
    try { buf = Buffer.alloc(MAX_READ); fs.readSync(fd, buf, 0, MAX_READ, 0); }
    finally { fs.closeSync(fd); }
  } else {
    buf = fs.readFileSync(target);
  }
  if (buf.includes(0)) throw new Error('"' + rel + '" is not a text file');
  let text = buf.toString('utf8');
  if (st.size > MAX_READ) text += '\n…[truncated]';
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
  sweepStaging, anyEnabled, isRemoved,
  tools, call, useSkill, readSkillFile,
};
