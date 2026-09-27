'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

test('foundation: auth, roles, CSRF, crypto', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test('anonymous /me is 401', async () => {
    assert.equal((await s.fetch('/api/admin/me')).status, 401);
  });
  await t.test('login works and returns csrf', async () => {
    const admin = await s.login('admin');
    const me = await (await admin.fetch('/api/admin/me')).json();
    assert.equal(me.user.role, 'admin');
    assert.ok(me.csrfToken);
  });
  await t.test('wrong password rejected', async () => {
    const r = await s.fetch('/api/admin/login', { method: 'POST', json: { username: 'test-admin', password: 'nope-nope-nope' } });
    assert.equal(r.status, 401);
  });
  await t.test('logout requires CSRF', async () => {
    const admin = await s.login('editor');
    const r = await s.fetch('/api/admin/logout', { method: 'POST', headers: { Cookie: admin.cookie } });
    assert.equal(r.status, 403);
    assert.equal((await admin.fetch('/api/admin/logout', { method: 'POST' })).status, 200);
  });
  await t.test('phone crypto roundtrip + normalization', () => {
    const c = require('../server/lib/crypto');
    assert.equal(c.normalizePhone('0300-1234567'), '+923001234567');
    assert.equal(c.normalizePhone('+92 300 1234567'), '+923001234567');
    assert.equal(c.normalizePhone('12345'), null);
    const enc = c.encryptPhone('+923001234567');
    assert.notEqual(enc, '+923001234567');
    assert.equal(c.decryptPhone(enc), '+923001234567');
    assert.equal(c.hashPhone('+923001234567'), c.hashPhone('+923001234567'));
    assert.match(c.reference(), /^TW-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  });
  await t.test('security headers present', async () => {
    const r = await s.fetch('/api/admin/me');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
  await t.test('owner confirmation in setup never overrides an administrator status', () => {
    const { applyOwnerConfirmation } = require('../scripts/setup');
    const file = 'owner-confirmed.xlsx';
    const listed = s.insertPlant({ source_file: file, latitude: 31.4, longitude: 73.1, coord_status: 'source' });
    const closed = s.insertPlant({ source_file: file, status: 'temporarily_closed', status_source: 'admin', status_updated_at: '2026-09-27T10:00:00.000Z', status_note: 'Pump broken' });
    const cfg = { status: 'operational', verifiedAt: '2026-09-26', note: 'Owner confirmed.' };
    const get = (id) => s.db.prepare('SELECT status, status_source, status_note, last_verified_at, coord_status FROM plants WHERE id = ?').get(id);

    assert.deepEqual(applyOwnerConfirmation(s.db, file, cfg), { updated: 1 });
    assert.equal(get(listed.id).status_source, 'admin_verified');
    assert.equal(get(listed.id).coord_status, 'verified');
    assert.deepEqual({ ...get(closed.id) }, { status: 'temporarily_closed', status_source: 'admin', status_note: 'Pump broken', last_verified_at: null, coord_status: 'missing' });
    // Setup runs on every start: a second run changes nothing.
    assert.deepEqual(applyOwnerConfirmation(s.db, file, cfg), { updated: 0 });
  });
});

test('setup never calls the external geocoder (it runs inside every Vercel cold start)', async (t) => {
  const http = require('node:http');
  let calls = 0;
  const fake = http.createServer((req, res) => { calls++; res.setHeader('Content-Type', 'application/json'); res.end('[]'); }).listen(0);
  await new Promise((r) => fake.once('listening', r));
  const s = await startTestServer({ env: { GEOCODER_PROVIDER: 'nominatim', NOMINATIM_URL: `http://127.0.0.1:${fake.address().port}` } });
  t.after(async () => { await s.close(); fake.close(); });

  await require('../scripts/setup').runSetup({ quiet: true });
  assert.equal(calls, 0);
  assert.ok(s.db.prepare("SELECT COUNT(*) AS n FROM plants WHERE address IS NOT NULL AND latitude IS NULL").get().n > 0, 'fixture: some plants have an address but no coordinates');
});

test('enrichment: plus codes decode, and setup only fills blanks', async (t) => {
  const { recoverPlusCode, nearLandmark } = require('../scripts/enrich-locations');
  const p = recoverPlusCode('24HJ+V9P', 31.418, 73.079); // Mumtazabad, Tandlianwala (checked against Google's open-location-code)
  assert.ok(Math.abs(p.lat - 31.029712) < 1e-5 && Math.abs(p.lng - 73.130953) < 1e-5);
  assert.equal(nearLandmark('RO Plant Near Government MC Primary School Ameen Abad'), 'Government MC Primary School Ameen Abad');
  assert.equal(nearLandmark('NEAR FAZL HAQ ROAD , DIJKOT'), 'FAZL HAQ ROAD');
  const { hitMatches } = require('../scripts/enrich-locations');
  assert.equal(hitMatches({ display_name: 'Chak 234 GB, Jaranwala Tehsil' }, 'GOVT HIGH SCHOOL 224 RB D TYPE SAMUNDRI ROAD'), false);
  assert.equal(hitMatches({ display_name: 'Pandianwala, Jaranwala Tehsil' }, '104 RB JARRAN WALA'), false);
  assert.equal(hitMatches({ display_name: 'Lathianwala, Faisalabad Saddar Tehsil' }, '200 RB LATHIAN WALA'), true);
  assert.equal(hitMatches({ display_name: 'Chak 76 GB, Faisalabad Saddar Tehsil' }, '076 GB AISHA COLLEGE'), true);
  assert.equal(hitMatches({ display_name: 'Tariq Abad, Gojra Tehsil, Toba Tek Singh District' }, 'TARIQ ABAD'), false);
  const { curatedHitMatches } = require('../scripts/enrich-locations');
  assert.equal(curatedHitMatches({ display_name: 'Peoples Colony No.01, Faisalabad District' }, 'Peoples Colony No 2 Faisalabad', ''), false);
  assert.equal(curatedHitMatches({ display_name: 'Qasim CNG, Lahore Road, Faisalabad District' }, 'Qasim Abad Faisalabad', ''), false);
  assert.equal(curatedHitMatches({ display_name: 'Peoples Colony No.01, Faisalabad District' }, 'Peoples Colony No 1 Faisalabad', ''), true);
  assert.equal(curatedHitMatches({ display_name: 'Tehsil Chowk, Chiniot, Chiniot District' }, 'Tehsil Chowk Chiniot', ''), true);

  const s = await startTestServer();
  t.after(() => s.close());
  const fs = require('node:fs');
  const path = require('node:path');
  const blank = s.insertPlant();
  const pinned = s.insertPlant({ latitude: 31.5, longitude: 73.2, coord_status: 'verified', landmark: 'Admin landmark' });
  const file = path.join(process.env.DATA_DIR, 'enrichment.json');
  const entry = { lat: 31.4, lng: 73.1, approximate: true, coordSource: 'search', landmark: 'Found landmark' };
  fs.writeFileSync(file, JSON.stringify({ plants: { [blank.plant_code]: entry, [pinned.plant_code]: entry } }));
  const { applyEnrichment } = require('../scripts/setup');
  assert.deepEqual(applyEnrichment(s.db, file), { coords: 1, landmarks: 1 });
  const get = (id) => ({ ...s.db.prepare('SELECT latitude, coord_status, coord_approximate, landmark FROM plants WHERE id = ?').get(id) });
  assert.deepEqual(get(blank.id), { latitude: 31.4, coord_status: 'source', coord_approximate: 1, landmark: 'Found landmark' });
  assert.deepEqual(get(pinned.id), { latitude: 31.5, coord_status: 'verified', coord_approximate: 0, landmark: 'Admin landmark' });
  assert.deepEqual(applyEnrichment(s.db, file), { coords: 0, landmarks: 0 });
});
