'use strict';
// Report photo handling: type detection by magic bytes, metadata stripping, storage.
//
//   const img = processPhoto(buffer)        // → { buffer, mime, ext, sha256, sizeBytes, removed: ['APP1', ...] }
//   const { storagePath } = storePhoto(img) // writes <uploadDir>/photos/<random>.<ext>
//   readStoredFile(storagePath) / deleteStoredFile(storagePath)
//
// Pure JavaScript, no image library. We never decode or re-encode pixels; we walk the container
// format and copy every segment except the ones that can carry metadata:
//   JPEG: APP1 (EXIF incl. GPS, XMP), APP12, APP13 (IPTC/Photoshop), COM. Also APP0 "JFXX" (an
//         extension thumbnail that may show the uncropped original) and APP2 "MPF" (multi-picture index
//         pointing at secondary images after EOI, which we drop). Anything after EOI is discarded.
//   PNG:  eXIf, tEXt, zTXt, iTXt, tIME. Anything after IEND is discarded. CRCs are verified.
//   WebP: EXIF and "XMP " chunks; the VP8X EXIF/XMP flags are cleared and the RIFF size rewritten.
//         Anything after the RIFF payload is discarded.
// Structurally broken files are rejected with a clear error instead of being stored.
//
// PRIVACY LIMITATION: there is no automatic face, licence-plate or phone-number detection — that would
// need an ML/OCR library we do not ship. Photos are therefore NEVER public by default: a moderator must
// approve each one and explicitly mark it public after looking for identifiable faces, phone numbers or
// other private details (POST /api/admin/photos/:id/moderate).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const config = require('../config');
const { HttpError } = require('./http');

const TYPES = {
  'image/jpeg': { ext: '.jpg', label: 'JPEG' },
  'image/png': { ext: '.png', label: 'PNG' },
  'image/webp': { ext: '.webp', label: 'WebP' },
};

function detectType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const corrupt = (label, why) =>
  new HttpError(400, 'corrupt_file', `The ${label} photo appears to be damaged or incomplete (${why}). Please choose another photo.`, { field: 'photos' });

// ───────────────────────── JPEG ─────────────────────────
const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
const JPEG_NAMES = { 0xe1: 'APP1', 0xec: 'APP12', 0xed: 'APP13', 0xfe: 'COM', 0xe0: 'APP0-JFXX', 0xe2: 'APP2-MPF' };

function jpegDrop(marker, payload) {
  if (marker === 0xe1 || marker === 0xec || marker === 0xed || marker === 0xfe) return true;
  if (marker === 0xe0 && payload.toString('latin1', 0, 5) === 'JFXX\0') return true;
  if (marker === 0xe2 && payload.toString('latin1', 0, 4) === 'MPF\0') return true;
  return false;
}

function stripJpeg(buf) {
  const L = 'JPEG';
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw corrupt(L, 'missing start marker');
  const out = [Buffer.from([0xff, 0xd8])];
  const removed = [];
  let i = 2;
  let sawSof = false, sawSos = false, sawEoi = false;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw corrupt(L, 'unexpected bytes between segments');
    let j = i;
    while (j < buf.length && buf[j] === 0xff) j++; // fill bytes
    if (j >= buf.length) throw corrupt(L, 'truncated marker');
    const marker = buf[j];
    i = j + 1;
    if (marker === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); sawEoi = true; break; }
    if (marker === 0x00 || marker === 0xd8) throw corrupt(L, 'invalid marker');
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(Buffer.from([0xff, marker])); continue; }
    if (i + 2 > buf.length) throw corrupt(L, 'truncated segment');
    const len = buf.readUInt16BE(i);
    const segEnd = i + len;
    if (len < 2 || segEnd > buf.length) throw corrupt(L, 'segment runs past end of file');
    const payload = buf.subarray(i + 2, segEnd);
    if (jpegDrop(marker, payload)) removed.push(JPEG_NAMES[marker] || `APP${marker - 0xe0}`);
    else out.push(Buffer.from([0xff, marker]), buf.subarray(i, segEnd));
    if (isSof(marker)) sawSof = true;
    i = segEnd;
    if (marker === 0xda) {
      if (!sawSof) throw corrupt(L, 'scan before frame header');
      sawSos = true;
      // Entropy-coded data runs until the next marker that is not byte stuffing (FF00) or a restart (FFD0–D7).
      let k = i;
      while (k < buf.length) {
        if (buf[k] === 0xff && k + 1 < buf.length) {
          const n = buf[k + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { k += 2; continue; }
          if (n === 0xff) { k += 1; continue; }
          break;
        }
        k++;
      }
      if (k >= buf.length - 1) throw corrupt(L, 'image data is truncated');
      out.push(buf.subarray(i, k));
      i = k;
    }
  }
  if (!sawSof || !sawSos || !sawEoi) throw corrupt(L, 'incomplete image');
  return { buffer: Buffer.concat(out), removed };
}

// ───────────────────────── PNG ─────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

let crcTable = null;
function crc32(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let n = 0; n < data.length; n++) c = crcTable[(c ^ data[n]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function stripPng(buf) {
  const L = 'PNG';
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw corrupt(L, 'missing signature');
  const out = [PNG_SIG];
  const removed = [];
  let i = 8;
  let first = true, sawIdat = false, sawIend = false;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw corrupt(L, 'truncated chunk');
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw corrupt(L, 'invalid chunk type');
    if (len > 0x7fffffff || i + 12 + len > buf.length) throw corrupt(L, 'chunk runs past end of file');
    const end = i + 12 + len;
    if (crc32(buf.subarray(i + 4, i + 8 + len)) !== buf.readUInt32BE(i + 8 + len)) throw corrupt(L, 'checksum mismatch');
    if (first && type !== 'IHDR') throw corrupt(L, 'header chunk missing');
    first = false;
    if (type === 'IDAT') sawIdat = true;
    if (PNG_DROP.has(type)) removed.push(type);
    else out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIdat || !sawIend) throw corrupt(L, 'incomplete image');
  return { buffer: Buffer.concat(out), removed };
}

// ───────────────────────── WebP ─────────────────────────
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_XMP = 0x04;

function stripWebp(buf) {
  const L = 'WebP';
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw corrupt(L, 'missing RIFF header');
  const riffEnd = 8 + buf.readUInt32LE(4);
  if (riffEnd > buf.length || riffEnd < 20) throw corrupt(L, 'RIFF size does not match file');
  const chunks = [];
  const removed = [];
  let i = 12;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) throw corrupt(L, 'truncated chunk');
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    let end = i + 8 + size + (size & 1);
    if (end > riffEnd) {
      if (i + 8 + size === riffEnd) end = riffEnd; // tolerate a missing final pad byte
      else throw corrupt(L, 'chunk runs past end of file');
    }
    if (fourcc === 'EXIF' || fourcc === 'XMP ') removed.push(fourcc.trim());
    else {
      let chunk = buf.subarray(i, end);
      if (fourcc === 'VP8X') {
        if (size < 10) throw corrupt(L, 'invalid extended header');
        chunk = Buffer.from(chunk); // copy before mutating flags
        chunk[8] &= ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP) & 0xff;
      }
      if (chunk.length % 2) chunk = Buffer.concat([chunk, Buffer.alloc(1)]);
      chunks.push({ fourcc, chunk });
    }
    i = end;
  }
  if (!chunks.length || !['VP8 ', 'VP8L', 'VP8X'].includes(chunks[0].fourcc)) throw corrupt(L, 'image header missing');
  if (!chunks.some((c) => ['VP8 ', 'VP8L', 'ANMF'].includes(c.fourcc))) throw corrupt(L, 'image data missing');
  const body = Buffer.concat(chunks.map((c) => c.chunk));
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return { buffer: Buffer.concat([header, body]), removed };
}

const STRIPPERS = { 'image/jpeg': stripJpeg, 'image/png': stripPng, 'image/webp': stripWebp };

/** Metadata segments present in an image (empty array = clean). Throws on unsupported/corrupt input. */
function listMetadata(buf) {
  const mime = detectType(buf);
  if (!mime) throw new HttpError(400, 'invalid_file_type', 'Not a JPEG, PNG or WebP image.', { field: 'photos' });
  return STRIPPERS[mime](buf).removed;
}

/** Validate by magic bytes, strip metadata, hash the stripped bytes. Client-declared MIME types are ignored. */
function processPhoto(buf, { index = 0 } = {}) {
  const mime = detectType(buf);
  if (!mime) {
    throw new HttpError(400, 'invalid_file_type', 'Photos must be JPEG, PNG or WebP images.', { field: 'photos', index });
  }
  let result;
  try {
    result = STRIPPERS[mime](buf);
  } catch (err) {
    if (err instanceof HttpError) { err.details = { ...(err.details || {}), index }; throw err; }
    throw corrupt(TYPES[mime].label, 'could not be read');
  }
  // Defence in depth: the output must parse cleanly and contain no metadata segments.
  if (STRIPPERS[mime](result.buffer).removed.length) throw corrupt(TYPES[mime].label, 'metadata could not be removed');
  return {
    buffer: result.buffer,
    mime,
    ext: TYPES[mime].ext,
    sha256: crypto.createHash('sha256').update(result.buffer).digest('hex'),
    sizeBytes: result.buffer.length,
    removed: result.removed,
  };
}

const PHOTO_DIR = 'photos';

function absolutePath(storagePath) {
  const root = path.resolve(config.uploadDir);
  const abs = path.resolve(root, storagePath);
  if (!abs.startsWith(root + path.sep)) throw new Error('Refusing to access a file outside the upload directory');
  return abs;
}

/** Write processed bytes under <uploadDir>/photos/ with a random, meaningless name. */
function storePhoto(img) {
  const dir = path.join(config.uploadDir, PHOTO_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex') + img.ext;
  const storagePath = `${PHOTO_DIR}/${name}`;
  fs.writeFileSync(absolutePath(storagePath), img.buffer, { mode: 0o600, flag: 'wx' });
  return { storagePath };
}

function readStoredFile(storagePath) {
  try { return fs.readFileSync(absolutePath(storagePath)); } catch { return null; }
}

function deleteStoredFile(storagePath) {
  try { fs.unlinkSync(absolutePath(storagePath)); return true; } catch { return false; }
}

module.exports = {
  TYPES, detectType, stripJpeg, stripPng, stripWebp, listMetadata, processPhoto,
  storePhoto, readStoredFile, deleteStoredFile, absolutePath, crc32,
};
