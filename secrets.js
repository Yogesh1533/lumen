// The secrets of Lumen: API keys of the providers, the Brave key, the env values of the
// MCP servers and the sensitive settings of extensions. They are kept out of
// settings.json — the file only holds a reference ({"$secret": "<name>"}) — and live in
//   - the macOS Keychain (the `security` tool), or
//   - the Secret Service on Linux (the `secret-tool` tool), or
//   - an encrypted file data/secrets.enc whose key is data/.key (mode 600). That last one
//     only protects against a casual look at the files: the key lies next to them.
// A secret is never put on a command line (other users could see it in `ps`): it goes to
// the tools on their standard input.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const which = (bin) => {
  for (const d of (process.env.PATH || '').split(path.delimiter)) { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return path.join(d, bin); } catch { /* next */ } }
  return null;
};

// ---- the macOS Keychain -----------------------------------------------------------------
// `security -i` reads its commands from stdin, so the secret is not in the argv of any
// process. A value is quoted for its little shell-like parser.
const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function keychain(service) {
  const bin = '/usr/bin/security';
  const run = (args, input) => spawnSync(bin, args, { input, encoding: 'utf8', timeout: 10000 });
  return {
    kind: 'keychain', label: 'macOS Keychain', warning: '',
    set(name, value) {
      // Base64 keeps any byte safe through the parser and through `-w`, which prints a
      // password that is not plain ASCII as hex.
      const b64 = 'b64:' + Buffer.from(String(value), 'utf8').toString('base64');
      const r = run(['-i'], `add-generic-password -U -a ${q(name)} -s ${q(service)} -l ${q(service + ' ' + name)} -w ${q(b64)}\n`);
      if (r.status !== 0 || /error|could not/i.test(r.stderr || '')) throw new Error('The Keychain refused the secret: ' + String(r.stderr || '').trim().slice(0, 200));
    },
    get(name) {
      const r = run(['find-generic-password', '-a', name, '-s', service, '-w']);
      if (r.status !== 0) return null;
      const out = String(r.stdout).replace(/\n$/, '');
      return out.startsWith('b64:') ? Buffer.from(out.slice(4), 'base64').toString('utf8') : out;
    },
    del(name) { run(['delete-generic-password', '-a', name, '-s', service]); },
  };
}

// ---- the Secret Service (Linux) ------------------------------------------------------------
function secretTool(service) {
  const bin = which('secret-tool');
  const run = (args, input) => spawnSync(bin, args, { input, encoding: 'utf8', timeout: 10000 });
  return {
    kind: 'secret-tool', label: 'Secret Service (secret-tool)', warning: '',
    set(name, value) {
      const r = run(['store', '--label', `${service} ${name}`, 'service', service, 'account', name], String(value));
      if (r.status !== 0) throw new Error('secret-tool refused the secret: ' + String(r.stderr || '').trim().slice(0, 200));
    },
    get(name) { const r = run(['lookup', 'service', service, 'account', name]); return r.status === 0 ? String(r.stdout) : null; },
    del(name) { run(['clear', 'service', service, 'account', name]); },
  };
}

// ---- the encrypted file ---------------------------------------------------------------------
function fileVault(dir) {
  const keyFile = path.join(dir, '.key'), dataFile = path.join(dir, 'secrets.enc');
  const key = () => {
    try { const k = fs.readFileSync(keyFile); if (k.length === 32) return k; } catch { /* make one */ }
    fs.mkdirSync(dir, { recursive: true });
    const k = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, k, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    return k;
  };
  const load = () => {
    let raw;
    try { raw = fs.readFileSync(dataFile); } catch { return {}; }
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
  };
  const store = (obj) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
    fs.renameSync(tmp, dataFile);
  };
  return {
    kind: 'file', label: 'Encrypted file (data/secrets.enc)',
    warning: 'No system keychain was found: the secrets are encrypted with a key that is stored next to them (data/.key, readable only by you). That keeps them out of settings.json and away from a casual look, not from someone who can read your files.',
    set(name, value) { const o = load(); o[name] = String(value); store(o); },
    get(name) { const o = load(); return Object.prototype.hasOwnProperty.call(o, name) ? o[name] : null; },
    del(name) { const o = load(); if (name in o) { delete o[name]; store(o); } },
  };
}

// Choose the store: LUMEN_SECRETS=keychain|secret-tool|file forces one; otherwise the
// system store is used when it works (it is probed once) and the file when it does not.
function open({ dataDir, service = process.env.LUMEN_SECRETS_SERVICE || 'Lumen', prefer = process.env.LUMEN_SECRETS || 'auto' } = {}) {
  const probe = (v) => {
    const name = '__lumen_probe_' + crypto.randomBytes(4).toString('hex');
    try { v.set(name, 'probe'); const ok = v.get(name) === 'probe'; v.del(name); return ok; } catch { try { v.del(name); } catch { /* gone */ } return false; }
  };
  if (prefer === 'file') return fileVault(dataDir);
  if (prefer === 'keychain') return keychain(service);
  if (prefer === 'secret-tool') return secretTool(service);
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/security')) { const v = keychain(service); if (probe(v)) return v; }
  if (process.platform === 'linux' && which('secret-tool')) { const v = secretTool(service); if (probe(v)) return v; }
  return fileVault(dataDir);
}

// ---- settings.json without the secrets ---------------------------------------------------
// The places in the settings that hold a secret. Each yields [name, get, set] for every
// value: the name is the key of the secret in the store.
function* secretSlots(s) {
  if (s.web) yield ['web/brave', () => s.web.braveKey, (v) => { s.web.braveKey = v; }];
  for (const p of s.providers || []) yield [`provider/${p.id}/key`, () => p.apiKey, (v) => { p.apiKey = v; }];
  for (const c of s.mcpServers || []) {
    for (const k of Object.keys(c.env || {})) yield [`mcp/${c.id}/env/${k}`, () => c.env[k], (v) => { c.env[k] = v; }];
    const def = c.extension && s.extensions && s.extensions[c.extension.id];
    const uc = def && def.manifest && def.manifest.user_config;
    for (const k of Object.keys(c.userConfig || {})) {
      if (!(uc && uc[k] && uc[k].sensitive)) continue;
      yield [`mcp/${c.id}/config/${k}`, () => c.userConfig[k], (v) => { c.userConfig[k] = v; }];
    }
  }
}
const isRef = (v) => !!(v && typeof v === 'object' && typeof v.$secret === 'string');

// The copy of the settings that goes to the disk: every secret is put into the store and
// replaced by a reference. `cache` remembers what the store already holds (a hash per
// name), so an unchanged secret is not written again. Secrets that are gone (a removed
// server, a cleared key) are removed from the store.
function sanitize(settings, vault, cache) {
  const copy = JSON.parse(JSON.stringify(settings));
  const names = new Set();
  for (const [name, get, set] of secretSlots(copy)) {
    const v = get();
    if (v === undefined || v === null || v === '' || isRef(v)) continue;
    const json = typeof v !== 'string';
    const text = json ? JSON.stringify(v) : v;
    const h = crypto.createHash('sha256').update(text).digest('hex');
    if (cache.get(name) !== h) { vault.set(name, text); cache.set(name, h); }
    names.add(name);
    set(json ? { $secret: name, json: true } : { $secret: name });
  }
  for (const name of [...cache.keys()]) if (!names.has(name)) { try { vault.del(name); } catch { /* gone */ } cache.delete(name); }
  copy.secretRefs = [...names].sort();
  return copy;
}

// The settings that were read from the disk get their secrets back from the store. A
// secret that is still plain in the file (an older Lumen wrote it) stays as it is here —
// the next save moves it into the store.
function resolve(settings, vault, cache) {
  const missing = [];
  for (const [name, get, set] of secretSlots(settings)) {
    const v = get();
    if (!isRef(v)) continue;
    const text = vault.get(v.$secret);
    if (text == null) { missing.push(name); set(''); continue; }
    let val = text;
    if (v.json) { try { val = JSON.parse(text); } catch { val = text; } }
    set(val);
    cache.set(name, crypto.createHash('sha256').update(text).digest('hex'));
  }
  // The names the file says the store holds: a name that no slot uses any more is
  // still in the cache, so the next save removes it from the store.
  for (const name of settings.secretRefs || []) if (!cache.has(name) && !missing.includes(name)) cache.set(name, '');
  delete settings.secretRefs;
  return missing;
}

module.exports = { open, sanitize, resolve, secretSlots, fileVault, keychain, secretTool };
