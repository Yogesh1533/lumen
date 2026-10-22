'use strict';
// Reading .zip bundles (.mcpb / .dxt) without a dependency: the central directory is parsed
// by hand and the entries are inflated with Node's zlib.
// A bundle comes from outside, so every entry is treated as hostile input.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Limits for one bundle (documented in docs/ROADMAP.md).
// They are checked on the bytes that are really produced, not on the numbers the
// bundle claims: the sizes in the central directory are only a first filter.
const LIMITS = {
  maxEntries: 2000,                  // files in one bundle
  maxTotalBytes: 50 * 1024 * 1024,   // 50 MB uncompressed in total
  maxFileBytes: 20 * 1024 * 1024,    // 20 MB per file
  maxRatio: 200,                     // uncompressed / compressed — a zip bomb
  maxBundleBytes: 20 * 1024 * 1024,  // 20 MB for the uploaded file itself
};

const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50, LOC_SIG = 0x04034b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  throw new Error('Not a zip file (no end-of-directory record)');
}

// A name that stays inside the extraction folder: no absolute paths, no "..", no drive letters.
function safeName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.includes('\0')) return null;
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null; // absolute path
  const parts = n.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  for (const p of parts) if (p === '..') return null; // path traversal
  return parts.join('/');
}

// The name of an entry goes into an error message. It comes from an outside file, so the
// control characters are removed and the name is shortened.
function safeLabel(name) {
  const n = String(name == null ? '' : name).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return n.length > 80 ? n.slice(0, 80) + '…' : (n || 'the file');
}

// The central directory: one record per file, with the sizes and the local header offset.
function readDirectory(buf, lim) {
  const eocd = findEOCD(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total > lim.maxEntries) throw new Error(`The bundle has ${total} files (the limit is ${lim.maxEntries})`);
  if (cdOff + cdSize > buf.length) throw new Error('The zip directory is broken');
  const entries = [];
  let p = cdOff, totalSize = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('The zip directory is broken');
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new Error('Encrypted zip entries are not supported');
    if (size === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) throw new Error('Zip64 bundles are not supported');
    // A symlink (unix mode in the high 16 bits) could point outside the folder.
    if ((madeBy >> 8) === 3 && ((external >>> 16) & 0xf000) === 0xa000) throw new Error(`The bundle contains a symlink (${safeLabel(name)})`);
    if (size > lim.maxFileBytes) throw new Error(`"${safeLabel(name)}" is bigger than the file limit (${lim.maxFileBytes} bytes)`);
    if (compSize > 0 && size / compSize > lim.maxRatio) throw new Error(`"${safeLabel(name)}" expands too much — refusing a zip bomb`);
    totalSize += size;
    if (totalSize > lim.maxTotalBytes) throw new Error(`The bundle is bigger than the size limit (${lim.maxTotalBytes} bytes)`);
    entries.push({ name, size, compSize, method, localOff });
  }
  return entries;
}

// The content of one entry. The inflation is bounded: a bundle that claims a small
// file but produces a huge one is stopped here, before the bytes exist.
function readData(buf, e, lim) {
  if (e.localOff + 30 > buf.length || buf.readUInt32LE(e.localOff) !== LOC_SIG) throw new Error('The zip file is broken');
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const end = start + e.compSize;
  if (end > buf.length) throw new Error('The zip file is broken');
  const raw = buf.subarray(start, end);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) {
    try { return zlib.inflateRawSync(raw, { maxOutputLength: lim.maxFileBytes }); }
    catch (err) {
      // A stream that grows past the limit is a size problem. A broken stream is not:
      // that error belongs to the bundle, and it is passed on as it is.
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`"${safeLabel(e.name)}" is bigger than the file limit (${lim.maxFileBytes} bytes)`);
      }
      throw err;
    }
  }
  throw new Error(`Unsupported compression method ${e.method}`);
}

// Every file of the bundle, with its content. Throws on anything suspicious.
// The sizes are measured on the bytes that come out of the inflation, so a bundle
// that lies in its directory cannot get past the limits.
function readZip(buf, limits) {
  // The limits of the general bundle reader, with the ones of the caller on top.
  const lim = { ...LIMITS, ...(limits || {}) };
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length > lim.maxBundleBytes) throw new Error(`The bundle is bigger than the upload limit (${lim.maxBundleBytes} bytes)`);
  const out = [];
  let total = 0;
  for (const e of readDirectory(buf, lim)) {
    if (e.name.endsWith('/')) continue; // directory entry
    const name = safeName(e.name);
    if (!name) throw new Error(`The bundle contains an unsafe path ("${safeLabel(e.name)}")`);
    const data = readData(buf, e, lim);
    if (data.length > lim.maxFileBytes) throw new Error(`"${safeLabel(e.name)}" is bigger than the file limit (${lim.maxFileBytes} bytes)`);
    if (e.compSize > 0 && data.length / e.compSize > lim.maxRatio) throw new Error(`"${safeLabel(e.name)}" expands too much — refusing a zip bomb`);
    total += data.length;
    if (total > lim.maxTotalBytes) throw new Error(`The bundle is bigger than the size limit (${lim.maxTotalBytes} bytes)`);
    out.push({ name, data });
  }
  return out;
}

// Unpack a bundle into a folder. The folder is emptied first, so a bundle can never
// leave a file behind that it did not bring itself.
function extract(buf, destDir, limits) {
  const lim = { ...LIMITS, ...(limits || {}) };
  const files = readZip(buf, limits);
  const root = path.resolve(destDir);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const f of files) {
    const target = path.resolve(root, f.name);
    if (!target.startsWith(root + path.sep)) throw new Error(`The bundle tried to write outside its folder ("${f.name}")`);
    written += f.data.length;
    if (written > lim.maxTotalBytes) throw new Error(`The bundle is bigger than the size limit (${lim.maxTotalBytes} bytes)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data, { mode: 0o600, flag: 'wx' });
  }
  return files.map((f) => f.name);
}

module.exports = { readZip, extract, safeName, LIMITS };
