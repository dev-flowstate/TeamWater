'use strict';
// Privacy primitives.
//   normalizePhone('0300-1234567') -> '+923001234567' (Pakistani mobile/landline) or null
//   hashPhone(e164)    -> keyed HMAC for lookups (stable)
//   encryptPhone(e164) / decryptPhone(ciphertext)  -> AES-256-GCM, only admins may decrypt (audited)
//   maskPhone(e164)    -> '+92 3•• ••• ••67'
//   hashSubject(str)   -> keyed hash for rate-limit subjects (IPs etc.), rotates daily
//   randomToken(bytes), sha256(str), reference(prefix) -> 'TW-8K2M-4QXZ'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let keys = null;
function loadKeys() {
  if (keys) return keys;
  let enc = config.phoneEncKey;
  let hmac = config.hmacKey;
  if (!enc || !hmac) {
    if (config.isProduction) {
      throw new Error('PHONE_ENC_KEY and HMAC_KEY (64 hex chars each) are required in production.');
    }
    // Development only: generate once and persist next to the dev database.
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(config.secretsFile, 'utf8')); } catch { /* first run */ }
    if (!stored.phoneEncKey || !stored.hmacKey) {
      stored = { phoneEncKey: crypto.randomBytes(32).toString('hex'), hmacKey: crypto.randomBytes(32).toString('hex') };
      fs.mkdirSync(path.dirname(config.secretsFile), { recursive: true });
      fs.writeFileSync(config.secretsFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
      console.warn('[crypto] Generated development secrets in', config.secretsFile, '— set PHONE_ENC_KEY/HMAC_KEY for production.');
    }
    enc = enc || stored.phoneEncKey;
    hmac = hmac || stored.hmacKey;
  }
  // 64 hex chars are used as-is; any other secret of 32+ characters (e.g. a host-generated
  // base64 value) is stretched to 32 bytes with SHA-256.
  const toKey = (v, name) => {
    if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
    if (String(v).length >= 32) return crypto.createHash('sha256').update(String(v)).digest();
    throw new Error(`${name} must be 64 hex characters or a random secret of at least 32 characters.`);
  };
  keys = { enc: toKey(enc, 'PHONE_ENC_KEY'), hmac: toKey(hmac, 'HMAC_KEY') };
  return keys;
}

/** Accepts common Pakistani formats: 03001234567, 0300-1234567, +92 300 1234567, 923001234567, 0092... */
function normalizePhone(input) {
  if (input === undefined || input === null) return null;
  let d = String(input).replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (!/^\d+$/.test(d)) return null;
  if (d.startsWith('0')) d = '92' + d.slice(1);
  if (!d.startsWith('92')) return null;
  const national = d.slice(2);
  // Mobile: 3XXXXXXXXX (10 digits). Landline: area code + number, 9–10 digits, not starting with 0.
  if (/^3\d{9}$/.test(national) || /^[1-9]\d{8,9}$/.test(national)) return '+92' + national;
  return null;
}

const hmacHex = (value, salt = '') =>
  crypto.createHmac('sha256', loadKeys().hmac).update(salt + '|' + value).digest('hex');

const hashPhone = (e164) => hmacHex(e164, 'phone');

function encryptPhone(e164) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKeys().enc, iv);
  const ct = Buffer.concat([cipher.update(e164, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decryptPhone(payload) {
  if (!payload) return null;
  const [v, iv, tag, ct] = payload.split(':');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKeys().enc, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

function maskPhone(e164OrLast4) {
  if (!e164OrLast4) return null;
  const last2 = String(e164OrLast4).slice(-2);
  return `+92 3•• ••• ••${last2}`;
}

/** Keyed hash for rate-limit subjects (IP addresses etc). Salt rotates daily so hashes can't be linked long-term. */
function hashSubject(value, { rotateDaily = true } = {}) {
  const day = rotateDaily ? new Date().toISOString().slice(0, 10) : '';
  return hmacHex(String(value || 'unknown'), 'subject:' + day).slice(0, 32);
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L
function reference(prefix = 'TW') {
  const pick = () => REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `${prefix}-${block()}-${block()}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(password, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = {
  loadKeys, normalizePhone, hashPhone, encryptPhone, decryptPhone, maskPhone, hashSubject,
  randomToken, sha256, reference, hashPassword, verifyPassword,
};
