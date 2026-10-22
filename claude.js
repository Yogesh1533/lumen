'use strict';
// Claude Desktop's configuration and extensions — read-only.
// Nothing in this file ever writes to Claude's folders.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Where Claude Desktop keeps its data, per OS.
function claudeDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}
// The tests point these at a fixture folder, so the real files are never touched.
const configPath = () => process.env.LUMEN_CLAUDE_CONFIG || path.join(claudeDir(), 'claude_desktop_config.json');
const extensionsDir = () => process.env.LUMEN_CLAUDE_EXTENSIONS || path.join(claudeDir(), 'Claude Extensions');

// Claude Desktop expands ${VAR} in the config from its own environment.
function expandVars(text) {
  return String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => (process.env[k] !== undefined ? process.env[k] : m));
}

// The MCP servers of Claude Desktop's config. The env values are the real ones — the caller
// must mask them before they go anywhere near the browser.
function readConfig() {
  const file = configPath();
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no config, or unreadable */ }
  const servers = [];
  const list = (raw && typeof raw.mcpServers === 'object' && raw.mcpServers && !Array.isArray(raw.mcpServers)) ? raw.mcpServers : {};
  for (const [name, s] of Object.entries(list)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const env = {};
    const rawEnv = (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) ? s.env : {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      env[k] = expandVars(String(v));
    }
    const url = typeof s.url === 'string' ? s.url.trim() : '';
    const command = typeof s.command === 'string' ? s.command.trim() : '';
    const args = Array.isArray(s.args) ? s.args.map((x) => String(x)).slice(0, 50) : [];
    servers.push({ key: name, name, transport: url && !command ? 'http' : 'stdio', command, args, env, url });
  }
  return { path: file, exists: !!raw, servers };
}

// The manifest of an extension (format v0.3). null when it is missing or another version.
function readManifest(dir) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (String(raw.manifest_version) !== '0.3') return null;
  if (!raw.server || typeof raw.server !== 'object') return null;
  return raw;
}

const CONFIG_TYPES = ['directory', 'file', 'string', 'number', 'boolean'];
// The user_config of a manifest, cleaned up: only the known types, only the known flags.
function userConfigSchema(manifest) {
  const src = (manifest && manifest.user_config && typeof manifest.user_config === 'object') ? manifest.user_config : {};
  const out = {};
  for (const [key, def] of Object.entries(src)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !def || typeof def !== 'object') continue;
    const type = CONFIG_TYPES.includes(def.type) ? def.type : 'string';
    out[key] = {
      type,
      title: String(def.title || key).slice(0, 80),
      description: String(def.description || '').slice(0, 400),
      required: !!def.required,
      multiple: !!def.multiple,
      sensitive: !!def.sensitive,
      default: def.default === undefined ? undefined : (Array.isArray(def.default) ? def.default.map(String) : String(def.default)),
    };
  }
  return out;
}

// The extensions Claude Desktop has installed. They are read, never copied or edited.
function listExtensions() {
  const dir = extensionsDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no extensions folder */ }
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    const manifest = readManifest(p);
    if (!manifest) continue;
    out.push({ id: n, name: String(manifest.name || n).slice(0, 80), version: String(manifest.version || ''), path: p, manifest });
  }
  return { dir, installed: out };
}

// The command of an extension, with the placeholders filled in.
//   ${__dirname}        the folder of the extension
//   ${HOME}             the home folder of the user
//   ${user_config.key}  the value the user typed; an array becomes several arguments
function buildCommand(manifest, userConfig, dir) {
  const server = (manifest && manifest.server) || {};
  const cfg = (server.mcp_config && typeof server.mcp_config === 'object') ? server.mcp_config : {};
  const home = os.homedir();
  const subs = (text) => String(text)
    .replace(/\$\{__dirname\}/g, dir)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$\{user_config\.([A-Za-z0-9_]*)\}/g, (m, key) => {
      const v = userConfig[key];
      if (v === undefined || v === null) return '';
      return Array.isArray(v) ? v.join(', ') : String(v);
    });
  // A whole argument that stands for a list becomes one argument per value.
  const expandArg = (arg) => {
    const m = /^\$\{user_config\.([A-Za-z0-9_]*)\}$/.exec(String(arg).trim());
    if (m) {
      const v = userConfig[m[1]];
      if (Array.isArray(v)) return v.map((x) => String(x));
    }
    return [subs(arg)];
  };
  let command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
  let args = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
  if (!command) {
    // No mcp_config: run the entry point with the interpreter of its type.
    const entry = String(server.entry_point || '').trim();
    const type = String(server.type || 'node').toLowerCase();
    if (type === 'python' || type === 'python3') { command = 'python3'; args = entry ? [entry] : []; }
    // A binary runs itself: it must not be its own first argument.
    else if (type === 'binary') { command = entry; args = []; }
    else { command = 'node'; args = entry ? [entry] : []; }
  }
  const env = {};
  const cfgEnv = (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) ? cfg.env : {};
  for (const [k, v] of Object.entries(cfgEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    env[k] = Array.isArray(v) ? v.map((x) => subs(x)).join(', ') : subs(String(v));
  }
  return { command: subs(command), args: args.flatMap(expandArg).map((a) => String(a)), env };
}

// The values of a user_config, cleaned up: the declared types, the declared flags.
function cleanUserConfig(schema, values) {
  const out = {};
  const v = (values && typeof values === 'object') ? values : {};
  for (const [key, def] of Object.entries(schema)) {
    let val = v[key];
    if (val === undefined || val === null || val === '') val = def.default;
    if (val === undefined || val === null || val === '') {
      if (def.required) throw new Error(`"${def.title || key}" is required`);
      continue;
    }
    if (def.type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) throw new Error(`"${def.title || key}" must be a number`);
      val = n;
    } else if (def.type === 'boolean') {
      val = val === true || val === 'true' || val === '1' || val === 1;
    } else if (!Array.isArray(val)) val = String(val); // a list keeps its values
    if (def.multiple) out[key] = (Array.isArray(val) ? val : [val]).map((x) => String(x)).slice(0, 100);
    else out[key] = Array.isArray(val) ? val.map(String).join(', ') : String(val);
  }
  return out;
}

module.exports = { claudeDir, configPath, extensionsDir, readConfig, readManifest, userConfigSchema, listExtensions, buildCommand, cleanUserConfig, expandVars };
