'use strict';
// Durable storage for hosts whose disk is temporary (Vercel's /tmp is wiped whenever a new instance starts).
// The SQLite database and uploaded files are saved to a Firebase Realtime Database after every change and
// restored when an instance starts or finds that another instance saved something newer.
//
//   FIREBASE_DATABASE_URL      e.g. https://team-water-default-rtdb.firebaseio.com
//   FIREBASE_SERVICE_ACCOUNT   the service-account key JSON (or the same JSON base64-encoded)
// Unset = off: local development and hosts with a persistent disk do not need it.
//
// Layout under /teamwater: version (random id of the latest save), db { savedAt, data: gzip+base64 of the database },
// files/<base64url(relative path)> { path, data: gzip+base64 }. Files deleted locally (photo removal, deletion
// requests) are deleted there too.
// Limit: if two instances save at the same moment, the later save wins. Fine for demo traffic.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('../config');
const { getDb, closeDb } = require('./db');

const enabled = () => !!(config.firebase.databaseUrl && config.firebase.serviceAccount);

let serviceAccount = null;
function account() {
  if (!serviceAccount) {
    const raw = config.firebase.serviceAccount.trim();
    serviceAccount = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  }
  return serviceAccount;
}

// OAuth access token from the service account (signed JWT → Google token endpoint), cached until near expiry.
let token = null;
async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60e3) return token.value;
  const sa = account();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, aud: sa.token_uri, iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch(sa.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Firebase sign-in failed (${res.status})`);
  const j = await res.json();
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function rtdb(method, key, body) {
  const url = `${config.firebase.databaseUrl.replace(/\/+$/, '')}/teamwater/${key}.json?access_token=${encodeURIComponent(await accessToken())}`;
  const res = await fetch(url, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Firebase ${method} ${key} failed (${res.status})`);
  return res.json();
}

const pack = (buf) => zlib.gzipSync(buf).toString('base64');
const unpack = (text) => zlib.gunzipSync(Buffer.from(text, 'base64'));
const fileKey = (rel) => Buffer.from(rel).toString('base64url');

function listFiles(root, dir = root) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(listFiles(root, abs));
    else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out;
}

let currentVersion = null; // version of the snapshot this instance's database matches
const synced = new Set(); // upload files known to be in Firebase

/** Replace the local database and uploads with the saved snapshot. Returns false when nothing is saved yet. */
async function restore() {
  const [version, snap] = [await rtdb('GET', 'version'), await rtdb('GET', 'db')];
  if (!snap || !snap.data) return false;
  closeDb();
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  for (const suffix of ['-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
  fs.writeFileSync(config.dbPath, unpack(snap.data));
  const root = path.resolve(config.uploadDir);
  synced.clear();
  for (const f of Object.values((await rtdb('GET', 'files')) || {})) {
    const abs = path.resolve(root, f.path);
    if (!abs.startsWith(root + path.sep)) continue; // never write outside the upload folder
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, unpack(f.data), { mode: 0o600 });
    synced.add(f.path);
  }
  currentVersion = version;
  getDb(); // reopen (runs migrations for a snapshot saved by older code)
  return true;
}

/** Reload when another instance has saved since this one last restored or saved. */
async function sync() {
  const remote = await rtdb('GET', 'version');
  if (remote && remote !== currentVersion) await restore();
}

/** Save the database and upload changes. */
async function save() {
  const tmp = path.join(path.dirname(config.dbPath), `snapshot-${process.pid}.db`);
  fs.rmSync(tmp, { force: true });
  getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const data = pack(fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  const root = path.resolve(config.uploadDir);
  const local = new Set(listFiles(root));
  for (const rel of local) {
    if (synced.has(rel)) continue;
    await rtdb('PUT', `files/${fileKey(rel)}`, { path: rel, data: pack(fs.readFileSync(path.join(root, rel))) });
    synced.add(rel);
  }
  for (const rel of [...synced]) {
    if (local.has(rel)) continue;
    await rtdb('DELETE', `files/${fileKey(rel)}`);
    synced.delete(rel);
  }
  await rtdb('PUT', 'db', { savedAt: new Date().toISOString(), data });
  const version = crypto.randomBytes(9).toString('base64url');
  await rtdb('PUT', 'version', version);
  currentVersion = version;
}

// One request at a time per instance while syncing, so a restore never swaps the database mid-request.
let queue = Promise.resolve();
function lock() {
  let release;
  const next = new Promise((r) => { release = r; });
  const acquired = queue.then(() => release);
  queue = queue.then(() => next);
  return acquired;
}

module.exports = { enabled, restore, sync, save, lock };
