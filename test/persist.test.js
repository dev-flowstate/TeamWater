'use strict';
// Firebase persistence for Vercel (server/lib/persist.js + api/index.js) against a fake Realtime Database and a fake
// Google token endpoint that checks the service-account JWT signature.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function fakeFirebase() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const store = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/token') {
        const [h, p, sig] = new URLSearchParams(body).get('assertion').split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'));
        return ok ? send(200, { access_token: 'tok', expires_in: 3600 }) : send(401, {});
      }
      if (url.searchParams.get('access_token') !== 'tok') return send(401, {});
      const key = url.pathname.replace(/^\/teamwater\//, '').replace(/\.json$/, '');
      if (req.method === 'PUT') { store.set(key, JSON.parse(body)); return send(200, JSON.parse(body)); }
      if (req.method === 'DELETE') { store.delete(key); return send(200, null); }
      if (key === 'files') {
        const files = Object.fromEntries([...store].filter(([k]) => k.startsWith('files/')).map(([k, v]) => [k.slice(6), v]));
        return send(200, Object.keys(files).length ? files : null);
      }
      return send(200, store.has(key) ? store.get(key) : null);
    });
  }).listen(0);
  return { server, store, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

async function startInstance(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-persist-'));
  Object.assign(process.env, env, { DATA_DIR: dir });
  for (const k of Object.keys(require.cache)) if (/[\\/](server|scripts|api)[\\/]/.test(k)) delete require.cache[k];
  const handler = require('../api/index.js');
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise((r) => server.close(r));
    require('../server/lib/db').closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, dir, close };
}

test('firebase persistence: save, cross-instance sync, restore on a fresh instance, file deletion', async (t) => {
  const fb = fakeFirebase();
  await new Promise((r) => fb.server.once('listening', r));
  t.after(() => fb.server.close());
  const port = fb.server.address().port;
  const env = {
    PHONE_ENC_KEY: 'a'.repeat(64), HMAC_KEY: 'b'.repeat(64), GEOCODER_PROVIDER: 'none', ROUTING_PROVIDER: 'none',
    ADMIN_PASSWORD: 'persist-test-password-1', FIREBASE_DATABASE_URL: `http://127.0.0.1:${port}`,
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@test', private_key: fb.privateKey, token_uri: `http://127.0.0.1:${port}/token` }),
  };

  // First instance: nothing saved yet → setup runs and the result is saved.
  let a = await startInstance(env);
  assert.equal((await fetch(`${a.base}/api/config`)).status, 200);
  assert.ok(fb.store.get('db')?.data && fb.store.get('version'));

  // A change (sign-in creates a session) is saved before the response.
  const v0 = fb.store.get('version');
  const login = await fetch(`${a.base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: env.ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await login.json();
  assert.notEqual(fb.store.get('version'), v0);
  const afterLogin = { db: fb.store.get('db'), version: fb.store.get('version') };

  // Rename a plant, then pretend another instance saved an older state: the next synced request reloads it.
  const code = 'PSPA-R053';
  const admin = (p, opts = {}) => fetch(`${a.base}${p}`, { ...opts, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  assert.equal((await admin(`/api/admin/plants/${code}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed for test', reason: 'persistence test' }) })).status, 200);
  fb.store.set('db', afterLogin.db);
  fb.store.set('version', 'from-another-instance');
  const detail = await (await admin(`/api/admin/plants/${code}`)).json();
  assert.notEqual(detail.name, 'Renamed for test', 'the newer save from another instance was loaded');

  // Upload files follow the database, including deletions.
  const persist = require('../server/lib/persist');
  const photo = path.join(a.dir, 'uploads', 'photos', 'p1.jpg');
  fs.mkdirSync(path.dirname(photo), { recursive: true });
  fs.writeFileSync(photo, 'jpeg-bytes');
  await persist.save();
  assert.ok([...fb.store.keys()].some((k) => k.startsWith('files/') && fb.store.get(k).path === 'photos/p1.jpg'));
  fs.rmSync(photo);
  await persist.save();
  assert.ok(![...fb.store.values()].some((v) => v && v.path === 'photos/p1.jpg'), 'deleted files are deleted in Firebase too');
  await a.close();

  // A fresh instance (empty /tmp) restores everything, including the admin session.
  a = await startInstance(env);
  t.after(() => a.close());
  const me = await fetch(`${a.base}/api/admin/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
});
