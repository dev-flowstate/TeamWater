'use strict';
// Test harness: isolated temp database per test file + running server + authenticated clients.
//   const { startTestServer } = require('./helpers');
//   const t = await startTestServer();            // fresh DB, admin/editor/moderator accounts
//   const res = await t.fetch('/api/config');       // anonymous
//   const admin = await t.login('admin');           // { fetch(path, opts) } with cookie + CSRF header
//   await admin.fetch('/api/admin/plants', { method: 'POST', json: {...} });
//   await t.close();
// Seed data helpers: t.db (node:sqlite connection), t.insertPlant({...overrides}) for quick fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startTestServer({ env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-test-'));
  process.env.DATA_DIR = dir;
  process.env.PHONE_ENC_KEY = process.env.PHONE_ENC_KEY || 'a'.repeat(64);
  process.env.HMAC_KEY = process.env.HMAC_KEY || 'b'.repeat(64);
  process.env.GEOCODER_PROVIDER = env.GEOCODER_PROVIDER || 'none';
  process.env.ROUTING_PROVIDER = env.ROUTING_PROVIDER || 'none';
  process.env.SMS_PROVIDER = env.SMS_PROVIDER || 'console';
  Object.assign(process.env, env);
  // Fresh module graph so config picks up the env for this file.
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`) || k.includes(`${path.sep}scripts${path.sep}`)) delete require.cache[k];

  const { getDb, closeDb } = require('../server/lib/db');
  const { createApp } = require('../server/app');
  const { createAdmin } = require('../scripts/create-admin');
  const { nowIso } = require('../server/lib/time');
  const db = getDb();
  const passwords = {};
  for (const role of ['admin', 'editor', 'moderator']) passwords[role] = createAdmin(`test-${role}`, role, `pw-${role}-123456789`).password;

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const doFetch = (p, opts = {}, extraHeaders = {}) => {
    const headers = { ...extraHeaders, ...(opts.headers || {}) };
    let body = opts.body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
    return fetch(base + p, { ...opts, headers, body });
  };

  async function login(role) {
    const res = await doFetch('/api/admin/login', { method: 'POST', json: { username: `test-${role}`, password: passwords[role] } });
    if (res.status !== 200) throw new Error(`login ${role} failed: ${res.status} ${await res.text()}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await res.json();
    return { fetch: (p, opts = {}) => doFetch(p, opts, { Cookie: cookie, 'X-CSRF-Token': csrfToken }), cookie, csrfToken };
  }

  let seq = 0;
  function insertPlant(o = {}) {
    seq++;
    const now = nowIso();
    const row = {
      plant_code: `TEST-${String(seq).padStart(4, '0')}`, name: null, town: 'Test Town', area_raw: 'Test Area - Sector 1',
      area_name: 'Test Area', area_sector: 'Sector 1', latitude: null, longitude: null, coord_status: 'missing',
      technology_raw: 'Reverse Osmosis (RO)', treatment_stages_json: '["reverse_osmosis"]', capacity_raw: '1000 GPH',
      capacity_value: 1000, capacity_unit: 'gallons_per_hour', capacity_unit_label: 'GPH', status: 'operational',
      status_raw: 'Fully Functional', status_source: 'spreadsheet', is_demo: 0, created_at: now, updated_at: now, ...o,
    };
    const cols = Object.keys(row);
    const r = db.prepare(`INSERT INTO plants (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    return { id: Number(r.lastInsertRowid), ...row };
  }

  return {
    base, db, fetch: doFetch, login, insertPlant, passwords,
    close: async () => { await new Promise((r) => server.close(r)); closeDb(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { startTestServer };
