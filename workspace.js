// The workspace of the user: trusted folders on this computer that the model may read
// and — with the user's approval — change, plus a shell that runs inside them.
//
// THIS IS NOT A SANDBOX. A command that the user approves runs with the user's own
// permissions. What this module does is keep the model inside the folders the user
// trusted: every path is resolved with realpath and must stay inside the folder of the
// chat (no "..", no symlink out, no absolute path elsewhere), the shell runs with a
// scrubbed environment, a timeout and an output cap, and every write and every command
// needs an approval token that is bound to exactly what the user saw.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const Diff = require('diff');

const LIMITS = {
  folders: 20,
  readBytes: 256 * 1024,      // fs_read returns at most this much text
  writeBytes: 1024 * 1024,    // fs_write / fs_edit write at most this much
  listEntries: 500,
  treeEntries: 1000,
  searchMatches: 200,
  searchFileBytes: 1024 * 1024,
  shellOutput: 100 * 1024,    // the output of a command is cut here
  shellTimeoutSec: 120,
  tokenMs: 10 * 60 * 1000,    // an approval is good for ten minutes, once
};
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', '.DS_Store']);

// ---- protected locations ---------------------------------------------------
// A folder that is, or is inside, one of these is never trusted. The home folder
// itself, the folder of all homes and the root are refused as they are (a folder
// inside the home is fine, a folder that holds the whole home is not).
function protectedRules(home) {
  const h = home.replace(/\/+$/, '');
  return {
    exact: new Set(['/', '/Users', '/home', '/var', '/private', '/private/var', '/opt', '/tmp', '/private/tmp', '/Volumes', '/mnt', '/media', h]),
    subtree: [
      '/System', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/Library', '/Applications', '/dev', '/proc', '/sys',
      '/boot', '/root', '/var/root', '/private/var/root', '/var/db', '/private/var/db', '/cores', '/Network',
      path.join(h, 'Library'), path.join(h, '.ssh'), path.join(h, '.config'), path.join(h, '.gnupg'),
      path.join(h, '.aws'), path.join(h, '.kube'), path.join(h, '.docker'), path.join(h, '.npmrc'),
    ],
  };
}
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');

// The mount points of network file systems (smb, nfs, afp, webdav, sshfs …).
const NET_FS = /\b(smbfs|nfs|nfs4|afpfs|webdav|cifs|sshfs|fuse\.sshfs|ftp|davfs|9p)\b/i;
function networkMounts() {
  try {
    const out = execFileSync('mount', [], { encoding: 'utf8', timeout: 3000 });
    const mounts = [];
    for (const line of out.split('\n')) {
      // macOS: "//u@host/share on /Volumes/share (smbfs, nodev, …)"
      // Linux: "host:/x on /mnt/x type nfs4 (rw, …)"
      const mm = line.match(/ on (.+?) (?:\(|type )/);
      if (mm && NET_FS.test(line)) mounts.push(mm[1]);
    }
    return mounts;
  } catch { return []; }
}

// Check a folder the user wants to trust. Returns the resolved path or throws with a
// reason the user can read. `opts.dataDir` is the data folder of Lumen: a folder that
// holds it (or is inside it) would let the model rewrite the settings of Lumen itself.
function validateFolder(input, opts = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Type the absolute path of a folder');
  if (raw.includes('\0')) throw new Error('That is not a valid path');
  if (/^(\\\\|\/\/)/.test(raw)) throw new Error('Network paths cannot be trusted');
  const home = opts.home || os.homedir();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new Error('The path must be absolute (it starts with /)');
  let real;
  try { real = fs.realpathSync(expanded); } catch { throw new Error('That folder does not exist'); }
  let st;
  try { st = fs.statSync(real); } catch { throw new Error('That folder does not exist'); }
  if (!st.isDirectory()) throw new Error('That is a file, not a folder');
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch { /* keep the given home */ }
  const rules = protectedRules(realHome);
  if (rules.exact.has(real) || rules.exact.has(expanded.replace(/\/+$/, ''))) throw new Error('That location is protected: choose a folder inside it');
  for (const p of rules.subtree) if (inside(real, p)) throw new Error('That location is protected (' + p + ')');
  // A folder that holds the home folder (or all homes) gives the whole home away.
  if (inside(realHome, real)) throw new Error('That folder holds your home folder: choose a folder inside it');
  // The home folders of the other users.
  const homesRoot = path.dirname(realHome);
  if (inside(real, homesRoot) && !inside(real, realHome)) throw new Error('That folder belongs to another user');
  for (const root of ['/Users', '/home']) {
    if (inside(real, root) && real !== root && !inside(real, realHome)) throw new Error('That folder belongs to another user');
  }
  if (opts.dataDir) {
    let d = opts.dataDir;
    try { d = fs.realpathSync(opts.dataDir); } catch { /* not made yet */ }
    if (inside(real, d) || inside(d, real)) throw new Error('That folder holds the data of Lumen itself');
  }
  for (const m of (opts.mounts || networkMounts())) if (inside(real, m)) throw new Error('Network folders cannot be trusted');
  return real;
}

// ---- containment -----------------------------------------------------------
// Resolve a path the model gave against the folder of the chat. The result is the real
// path (symlinks followed) and it must be inside the real path of the folder. A path
// that does not exist yet (a new file) is checked through the nearest parent that does.
function resolveIn(root, p, { mustExist = true } = {}) {
  if (typeof p !== 'string') p = p == null ? '.' : String(p);
  if (p.includes('\0')) throw new Error('That is not a valid path');
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, p || '.');
  // The lexical path must already be inside: this blocks "../x" and "/etc/passwd"
  // before anything on the disk is looked at.
  if (!inside(abs, realRoot)) throw new Error(`"${p}" is outside the workspace folder`);
  let real;
  try { real = fs.realpathSync(abs); } catch (e) {
    if (e.code !== 'ENOENT' || mustExist) throw new Error(`"${p}" does not exist`);
    // Walk up to the nearest parent that exists and check that one.
    let dir = path.dirname(abs);
    const rest = [path.basename(abs)];
    for (;;) {
      try { const rd = fs.realpathSync(dir); real = path.join(rd, ...rest); break; } catch (e2) {
        if (e2.code !== 'ENOENT' || dir === path.dirname(dir)) throw new Error(`"${p}" is not reachable`);
        rest.unshift(path.basename(dir)); dir = path.dirname(dir);
      }
    }
  }
  if (!inside(real, realRoot)) throw new Error(`"${p}" leads outside the workspace folder (a symbolic link)`);
  return { abs: real, rel: path.relative(realRoot, real) || '.', root: realRoot };
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
function readMaybe(file) { try { return fs.readFileSync(file); } catch { return null; } }

// ---- the tools -------------------------------------------------------------
const WRITE_TOOLS = new Set(['fs_write', 'fs_edit']);
const tools = () => [
  { name: 'fs_list', description: 'List the files and folders of a folder of the workspace. Paths are relative to the workspace folder.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Folder, default "."' } } } },
  { name: 'fs_tree', description: 'Show the tree of a folder of the workspace (folders like .git and node_modules are skipped).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number', description: '1 to 6, default 3' } } } },
  { name: 'fs_read', description: 'Read a text file of the workspace. Optional offset (first line, 1-based) and limit (number of lines).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] } },
  { name: 'fs_search', description: 'Search the text files of the workspace for a string (or a regular expression when regex is true).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' } }, required: ['query'] } },
  { name: 'fs_write', description: 'Create or overwrite a text file of the workspace with the given content. Needs the approval of the user unless the chat is in auto-edit mode.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'fs_edit', description: 'Replace old_string with new_string in a text file of the workspace. old_string must occur exactly once unless replace_all is true. Needs the approval of the user unless the chat is in auto-edit mode.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'shell', description: 'Run a shell command (sh -c) in the workspace folder. Always needs the approval of the user. No interactive input. Optional timeout_seconds (1 to 120).',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Folder inside the workspace, default "."' }, timeout_seconds: { type: 'number' } }, required: ['command'] } },
];
const TOOL_NAMES = new Set(tools().map((t) => t.name));
const needsApproval = (tool, mode) => tool === 'shell' || (WRITE_TOOLS.has(tool) && mode !== 'auto-edit');

function listDir(root, p) {
  const r = resolveIn(root, p || '.');
  if (!fs.statSync(r.abs).isDirectory()) throw new Error(`"${p}" is not a folder`);
  const names = fs.readdirSync(r.abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [];
  for (const d of names.slice(0, LIMITS.listEntries)) {
    let size = '';
    if (d.isFile()) { try { size = ' (' + fs.statSync(path.join(r.abs, d.name)).size + ' bytes)'; } catch { /* gone */ } }
    lines.push((d.isDirectory() ? '[dir]  ' : d.isSymbolicLink() ? '[link] ' : '[file] ') + d.name + size);
  }
  if (names.length > LIMITS.listEntries) lines.push(`… ${names.length - LIMITS.listEntries} more entries`);
  return (r.rel === '.' ? '(workspace folder)' : r.rel) + '\n' + (lines.join('\n') || '(empty)');
}

function tree(root, p, depth) {
  const r = resolveIn(root, p || '.');
  const max = Math.max(1, Math.min(6, Math.round(Number(depth) || 3)));
  const out = [];
  let n = 0;
  const walk = (dir, prefix, level) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const d of ents) {
      if (n >= LIMITS.treeEntries) return;
      n++;
      out.push(prefix + d.name + (d.isDirectory() ? '/' : ''));
      // A symbolic link is shown, never followed.
      if (d.isDirectory() && !SKIP_DIRS.has(d.name) && level < max) walk(path.join(dir, d.name), prefix + '  ', level + 1);
    }
  };
  walk(r.abs, '', 1);
  if (n >= LIMITS.treeEntries) out.push(`… cut at ${LIMITS.treeEntries} entries`);
  return out.join('\n') || '(empty)';
}

function readFile(root, a) {
  const r = resolveIn(root, a.path);
  const st = fs.statSync(r.abs);
  if (st.isDirectory()) throw new Error(`"${a.path}" is a folder: use fs_list`);
  const fd = fs.openSync(r.abs, 'r');
  let buf;
  try { buf = Buffer.alloc(Math.min(st.size, LIMITS.readBytes * 4)); fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  if (isBinary(buf)) throw new Error(`"${a.path}" is a binary file`);
  let lines = buf.toString('utf8').split('\n');
  const off = Math.max(1, Math.round(Number(a.offset) || 1));
  const lim = a.limit ? Math.max(1, Math.round(Number(a.limit))) : lines.length;
  lines = lines.slice(off - 1, off - 1 + lim);
  let text = lines.join('\n');
  let note = '';
  if (Buffer.byteLength(text) > LIMITS.readBytes) { text = Buffer.from(text).subarray(0, LIMITS.readBytes).toString('utf8'); note = `\n… cut at ${LIMITS.readBytes} bytes; use offset and limit`; }
  else if (st.size > buf.length) note = `\n… the file is longer (${st.size} bytes); use offset and limit`;
  return text + note;
}

function search(root, a) {
  const q = String(a.query || '');
  if (!q) throw new Error('Give a query');
  let re = null;
  if (a.regex) { try { re = new RegExp(q, 'i'); } catch (e) { throw new Error('That is not a valid regular expression'); } }
  const r = resolveIn(root, a.path || '.');
  const hits = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (hits.length >= LIMITS.searchMatches) return;
      const f = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(f); continue; }
      if (!d.isFile()) continue;
      let buf;
      try { if (fs.statSync(f).size > LIMITS.searchFileBytes) continue; buf = fs.readFileSync(f); } catch { continue; }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < LIMITS.searchMatches; i++) {
        const ok = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(q.toLowerCase());
        if (ok) hits.push(`${path.relative(r.root, f)}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    }
  };
  if (fs.statSync(r.abs).isDirectory()) walk(r.abs);
  else { const d = path.dirname(r.abs); walk(d); }
  if (!hits.length) return 'No matches';
  return hits.join('\n') + (hits.length >= LIMITS.searchMatches ? `\n… cut at ${LIMITS.searchMatches} matches` : '');
}

// What a write or an edit would do: the new content of the file, the old content and
// the unified diff. Nothing is written here. Used by the preview (the approval card)
// and by the call itself, so the two can never disagree.
function planWrite(root, tool, a) {
  if (tool === 'fs_write') {
    const content = typeof a.content === 'string' ? a.content : '';
    if (Buffer.byteLength(content) > LIMITS.writeBytes) throw new Error(`The content is larger than ${LIMITS.writeBytes} bytes`);
    const r = resolveIn(root, a.path, { mustExist: false });
    let old = null;
    if (fs.existsSync(r.abs)) {
      const st = fs.statSync(r.abs);
      if (st.isDirectory()) throw new Error(`"${a.path}" is a folder`);
      old = fs.readFileSync(r.abs);
      if (isBinary(old)) throw new Error(`"${a.path}" is a binary file`);
    }
    const oldText = old ? old.toString('utf8') : '';
    return { r, old, next: content, diff: unified(r.rel, oldText, content, !old) };
  }
  const r = resolveIn(root, a.path);
  if (fs.statSync(r.abs).isDirectory()) throw new Error(`"${a.path}" is a folder`);
  const old = fs.readFileSync(r.abs);
  if (isBinary(old)) throw new Error(`"${a.path}" is a binary file`);
  const text = old.toString('utf8');
  const from = String(a.old_string == null ? '' : a.old_string), to = String(a.new_string == null ? '' : a.new_string);
  if (!from) throw new Error('old_string is empty');
  const count = text.split(from).length - 1;
  if (!count) throw new Error('old_string was not found in the file');
  if (count > 1 && !a.replace_all) throw new Error(`old_string occurs ${count} times: make it unique or set replace_all`);
  const next = a.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
  if (Buffer.byteLength(next) > LIMITS.writeBytes) throw new Error(`The file would be larger than ${LIMITS.writeBytes} bytes`);
  return { r, old, next, diff: unified(r.rel, text, next, false) };
}
const unified = (rel, a, b, isNew) => Diff.createTwoFilesPatch(isNew ? '/dev/null' : 'a/' + rel, 'b/' + rel, a, b, '', '', { context: 3 });

// ---- the workspace of a server ---------------------------------------------
// One instance per server. `dataDir` holds the snapshots (data/changes/<session>/).
class Workspace {
  constructor({ dataDir, getConfig }) {
    this.dataDir = dataDir;
    this.changesDir = path.join(dataDir, 'changes');
    this.getConfig = getConfig;   // (session) => { folder, mode } | null
    this.tokens = new Map();      // token -> { session, tool, argsHash, fileHash, exp }
    this.runs = new Map();        // run id -> a shell run
  }

  // ---- approvals ----
  // The preview of a call that needs approval: the diff of a write or the exact command
  // of the shell, plus a token. The call only runs with that token, once, for exactly
  // these arguments, and a write only when the file is still what the preview saw.
  preview(session, tool, args) {
    const cfg = this.cfg(session);
    if (!TOOL_NAMES.has(tool)) throw new Error('Unknown workspace tool');
    const a = args && typeof args === 'object' ? args : {};
    let kind, text, fileHash = null;
    if (WRITE_TOOLS.has(tool)) {
      const plan = planWrite(cfg.folder, tool, a);
      kind = 'diff'; text = plan.diff; fileHash = plan.old ? sha(plan.old) : 'none';
    } else if (tool === 'shell') {
      const cmd = String(a.command || '');
      if (!cmd.trim()) throw new Error('The command is empty');
      const cwd = resolveIn(cfg.folder, a.cwd || '.');
      kind = 'command'; text = `$ ${cmd}\n(in ${cwd.abs}, timeout ${this.timeoutOf(a)} s)`;
    } else return { needed: false };
    this.sweepTokens();
    const token = crypto.randomBytes(18).toString('hex');
    this.tokens.set(token, { session, tool, argsHash: sha(JSON.stringify(a)), fileHash, exp: Date.now() + LIMITS.tokenMs });
    return { needed: needsApproval(tool, cfg.mode), token, kind, text, mode: cfg.mode };
  }
  sweepTokens() { const now = Date.now(); for (const [k, v] of this.tokens) if (v.exp < now) this.tokens.delete(k); }
  takeToken(token, session, tool, args) {
    const t = token && this.tokens.get(token);
    if (!t) return null;
    this.tokens.delete(token);   // once
    if (t.exp < Date.now() || t.session !== session || t.tool !== tool || t.argsHash !== sha(JSON.stringify(args || {}))) return null;
    return t;
  }

  cfg(session) {
    const c = this.getConfig(session);
    if (!c || !c.folder) throw new Error('This chat has no workspace folder. Choose one in the workspace bar.');
    return c;
  }
  timeoutOf(a) { return Math.max(1, Math.min(LIMITS.shellTimeoutSec, Math.round(Number(a.timeout_seconds) || LIMITS.shellTimeoutSec))); }

  // ---- the call ----
  async call(tool, args, { session, approval, headless = false } = {}) {
    try {
      if (!validSession(session)) throw new Error('A workspace call needs a session');
      if (!TOOL_NAMES.has(tool)) throw new Error('Unknown workspace tool');
      const cfg = this.cfg(session);
      const a = args && typeof args === 'object' ? args : {};
      if (headless && (tool === 'shell' || WRITE_TOOLS.has(tool))) throw new Error('A scheduled task may not change files or run commands');
      let tok = null;
      if (needsApproval(tool, cfg.mode) || approval) {
        tok = this.takeToken(approval, session, tool, a);
        if (needsApproval(tool, cfg.mode) && !tok) throw new Error('This call needs the approval of the user (no valid approval for exactly these arguments)');
      }
      switch (tool) {
        case 'fs_list': return ok(listDir(cfg.folder, a.path));
        case 'fs_tree': return ok(tree(cfg.folder, a.path, a.depth));
        case 'fs_read': return ok(readFile(cfg.folder, a));
        case 'fs_search': return ok(search(cfg.folder, a));
        case 'fs_write': case 'fs_edit': {
          const plan = planWrite(cfg.folder, tool, a);
          if (tok && tok.fileHash !== (plan.old ? sha(plan.old) : 'none')) throw new Error('The file changed after you approved the change; nothing was written');
          this.snapshot(session, plan.r.abs, plan.old);
          writeContained(cfg.folder, plan.r.abs, plan.next);
          const stat = plan.diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
          return ok(`${plan.old ? 'Changed' : 'Created'} ${plan.r.rel} (+${stat.filter((l) => l[0] === '+').length} −${stat.filter((l) => l[0] === '-').length} lines)\n\n${plan.diff}`);
        }
        case 'shell': return await this.shell(session, cfg, a);
      }
    } catch (e) { return { isError: true, text: String(e.message || e) }; }
  }

  // ---- the changes ----
  // Before the first write to a file in a session the original is kept (or the fact
  // that the file did not exist), so the change can be shown as a diff and reverted.
  index(session) {
    const f = path.join(this.changesDir, session, 'index.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { files: [] }; }
  }
  saveIndex(session, idx) {
    const d = path.join(this.changesDir, session);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(idx, null, 2));
  }
  snapshot(session, abs, old) {
    const idx = this.index(session);
    if (idx.files.some((f) => f.path === abs)) return;   // the first original wins
    const snap = old ? crypto.randomBytes(8).toString('hex') + '.orig' : null;
    if (snap) {
      fs.mkdirSync(path.join(this.changesDir, session), { recursive: true });
      fs.writeFileSync(path.join(this.changesDir, session, snap), old);
    }
    idx.files.push({ path: abs, existed: !!old, snap, t: Date.now() });
    this.saveIndex(session, idx);
  }
  changes(session) {
    if (!validSession(session)) throw new Error('Bad session');
    const idx = this.index(session);
    return idx.files.map((f) => {
      const orig = f.snap ? readMaybe(path.join(this.changesDir, session, f.snap)) : null;
      const cur = readMaybe(f.path);
      const a = orig ? orig.toString('utf8') : '', b = cur ? cur.toString('utf8') : '';
      const changed = !(f.existed ? cur && orig && cur.equals(orig) : !cur);
      const rel = this.relOf(session, f.path);
      return { path: f.path, rel, existed: f.existed, exists: !!cur, changed,
        diff: changed ? Diff.createTwoFilesPatch(f.existed ? 'a/' + rel : '/dev/null', cur ? 'b/' + rel : '/dev/null', a, b, '', '', { context: 3 }) : '' };
    });
  }
  relOf(session, abs) {
    const c = this.getConfig(session);
    if (c && c.folder) { try { const r = fs.realpathSync(c.folder); if (inside(abs, r)) return path.relative(r, abs); } catch { /* gone */ } }
    return abs;
  }
  // Put the original back (or remove the file that did not exist). The file must still
  // be inside a trusted folder and must not have become a symbolic link.
  revert(session, abs, trusted) {
    if (!validSession(session)) throw new Error('Bad session');
    const idx = this.index(session);
    const todo = abs ? idx.files.filter((f) => f.path === abs) : idx.files.slice();
    if (abs && !todo.length) throw new Error('That file has no recorded change');
    const done = [];
    for (const f of todo) {
      const root = (trusted || []).find((t) => { try { return inside(f.path, fs.realpathSync(t)); } catch { return false; } });
      if (!root) throw new Error(`${f.path} is not inside a trusted folder any more`);
      let lst = null;
      try { lst = fs.lstatSync(f.path); } catch { /* gone */ }
      if (lst && lst.isSymbolicLink()) throw new Error(`${f.path} is a symbolic link now; it was not touched`);
      if (f.existed) {
        const orig = fs.readFileSync(path.join(this.changesDir, session, f.snap));
        writeContained(root, f.path, orig);
      } else if (lst) fs.unlinkSync(f.path);
      done.push(f.path);
    }
    idx.files = idx.files.filter((f) => !done.includes(f.path));
    this.saveIndex(session, idx);
    if (!idx.files.length) fs.rmSync(path.join(this.changesDir, session), { recursive: true, force: true });
    return done;
  }

  // ---- the shell ----
  shell(session, cfg, a) {
    const command = String(a.command || '');
    if (!command.trim()) return Promise.resolve({ isError: true, text: 'The command is empty' });
    const cwd = resolveIn(cfg.folder, a.cwd || '.').abs;
    const timeout = this.timeoutOf(a);
    const id = crypto.randomUUID();
    const run = { id, session, command, cwd, started: Date.now(), ended: null, status: 'running', code: null, signal: null, output: '', truncated: false, killedBy: null };
    this.runs.set(id, run);
    this.trimRuns();
    return new Promise((resolve) => {
      // detached: the command gets a process group of its own, so the whole group can
      // be stopped (a command that starts children must not leave them running).
      const child = spawn('/bin/sh', ['-c', command], { cwd, env: scrubEnv(process.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      run.pid = child.pid;
      run.child = child;
      const add = (buf) => {
        if (run.truncated) return;
        const room = LIMITS.shellOutput - Buffer.byteLength(run.output);
        const s = buf.toString('utf8');
        if (Buffer.byteLength(s) > room) { run.output += Buffer.from(s).subarray(0, Math.max(0, room)).toString('utf8'); run.truncated = true; }
        else run.output += s;
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const timer = setTimeout(() => { run.killedBy = 'timeout'; this.killGroup(run); }, timeout * 1000);
      const finish = (code, signal) => {
        clearTimeout(timer);
        if (run.ended) return;
        run.ended = Date.now(); run.code = code; run.signal = signal;
        run.status = run.killedBy ? 'killed' : code === 0 ? 'done' : 'failed';
        delete run.child;
        let text = run.output;
        if (run.truncated) text += `\n[output cut at ${LIMITS.shellOutput / 1024} KB]`;
        if (run.killedBy === 'timeout') text += `\n[stopped: the command ran longer than ${timeout} s]`;
        else if (run.killedBy === 'user') text += '\n[stopped by the user]';
        text += `\n[exit ${code == null ? signal : code}]`;
        resolve({ isError: run.status !== 'done', text: text.replace(/^\n/, '') });
      };
      child.on('error', (e) => { run.output += String(e.message || e); finish(null, 'error'); });
      child.on('close', finish);
    });
  }
  killGroup(run) {
    if (!run || run.ended || !run.pid) return false;
    try { process.kill(-run.pid, 'SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { if (!run.ended) { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ } } }, 2000).unref();
    return true;
  }
  kill(id) { const r = this.runs.get(id); if (!r) return false; if (!r.killedBy) r.killedBy = 'user'; return this.killGroup(r); }
  killSession(session) { let n = 0; for (const r of this.runs.values()) if (r.session === session && !r.ended && this.kill(r.id)) n++; return n; }
  listRuns(session) {
    return [...this.runs.values()].filter((r) => r.session === session)
      .map(({ child, pid, ...r }) => r);
  }
  trimRuns() { const all = [...this.runs.values()].filter((r) => r.ended); while (this.runs.size > 50 && all.length) this.runs.delete(all.shift().id); }
  killAll() { for (const r of this.runs.values()) this.killGroup(r); }
}

// Write a file that is inside the folder. The parent folders that are missing are made
// first; the target is checked again just before the write (the folder may have
// changed since the path was resolved), and an existing symbolic link is never written
// through.
function writeContained(root, abs, data) {
  const realRoot = fs.realpathSync(root);
  if (!inside(abs, realRoot)) throw new Error('The file is outside the workspace folder');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const parent = fs.realpathSync(path.dirname(abs));
  if (!inside(parent, realRoot)) throw new Error('The folder of the file leads outside the workspace folder');
  let lst = null;
  try { lst = fs.lstatSync(abs); } catch { /* new file */ }
  if (lst && lst.isSymbolicLink()) throw new Error('The file is a symbolic link; it is not written through');
  fs.writeFileSync(path.join(parent, path.basename(abs)), data);
}

// The environment of a command: the secrets of the user stay out (API keys, tokens,
// passwords, the SSH and GPG agents, the variables of Lumen itself).
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
const SECRET_PREFIX = /^(ANTHROPIC_|OPENAI_|AWS_|AZURE_|GOOGLE_|GCP_|GH_|GITHUB_|GITLAB_|HF_|HUGGING|NPM_|LUMEN_|OLLAMA_|SSH_|GPG_|DOCKER_|KUBE)/i;
function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (SECRET_NAME.test(k) || SECRET_PREFIX.test(k)) continue;
    out[k] = v;
  }
  out.TERM = 'dumb';
  out.PAGER = 'cat';
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

const ok = (text) => ({ isError: false, text });
const validSession = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);

module.exports = { Workspace, validateFolder, resolveIn, scrubEnv, tools, needsApproval, LIMITS, validSession, inside, WRITE_TOOLS };
