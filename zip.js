'use strict';
// Reading .zip bundles (.mcpb / .dxt) without a dependency: the central directory is parsed
// by hand and the entries are inflated with Node's zlib.
// A bundle comes from outside, so every entry is treated as hostile input.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Limits for one bundle (documented in docs/ROADMAP.md).
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

// The central directory: one record per file, with the sizes and the local header offset.
function readDirectory(buf) {
  const eocd = findEOCD(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total > LIMITS.maxEntries) throw new Error(`The bundle has ${total} files (the limit is ${LIMITS.maxEntries})`);
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
    if ((madeBy >> 8) === 3 && ((external >>> 16) & 0xf000) === 0xa000) throw new Error(`The bundle contains a symlink (${name})`);
    if (size > LIMITS.maxFileBytes) throw new Error(`"${name}" is bigger than the file limit (${LIMITS.maxFileBytes} bytes)`);
    if (compSize > 0 && size / compSize > LIMITS.maxRatio) throw new Error(`"${name}" expands too much — refusing a zip bomb`);
    totalSize += size;
    if (totalSize > LIMITS.maxTotalBytes) throw new Error(`The bundle is bigger than the size limit (${LIMITS.maxTotalBytes} bytes)`);
    entries.push({ name, size, compSize, method, localOff });
  }
  return entries;
}

function readData(buf, e) {
  if (e.localOff + 30 > buf.length || buf.readUInt32LE(e.localOff) !== LOC_SIG) throw new Error('The zip file is broken');
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const end = start + e.compSize;
  if (end > buf.length) throw new Error('The zip file is broken');
  const raw = buf.subarray(start, end);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported compression method ${e.method}`);
}

// Every file of the bundle, with its content. Throws on anything suspicious.
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length > LIMITS.maxBundleBytes) throw new Error('The bundle is bigger than the size limit');
  const out = [];
  for (const e of readDirectory(buf)) {
    if (e.name.endsWith('/')) continue; // directory entry
    const name = safeName(e.name);
    if (!name) throw new Error(`The bundle contains an unsafe path ("${e.name}")`);
    out.push({ name, data: readData(buf, e) });
  }
  return out;
}

// Unpack a bundle into a folder. The folder is emptied first, so a bundle can never
// leave a file behind that it did not bring itself.
function extract(buf, destDir) {
  const files = readZip(buf);
  const root = path.resolve(destDir);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const f of files) {
    const target = path.resolve(root, f.name);
    if (!target.startsWith(root + path.sep)) throw new Error(`The bundle tried to write outside its folder ("${f.name}")`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data, { mode: 0o600, flag: 'wx' });
  }
  return files.map((f) => f.name);
}

module.exports = { readZip, extract, safeName, LIMITS };
