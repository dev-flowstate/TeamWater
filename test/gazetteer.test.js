'use strict';
// Geo workstream: area gazetteer data file + server/lib/gazetteer.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startTestServer } = require('./helpers');

const GAZ_FILE = path.join(__dirname, '..', 'data', 'gazetteer', 'faisalabad.json');
const DATA = JSON.parse(fs.readFileSync(GAZ_FILE, 'utf8'));

// The 39 base areas of the source spreadsheet and the town each one belongs to (docs/ARCHITECTURE.md §1).
const SPREADSHEET_AREAS = {
  'Aminpur Bangla': 'Lyallpur Town', 'Canal Road': 'Madina Town', 'Chak 185 RB': 'Chak Jhumra', 'Chak 190 RB': 'Chak Jhumra',
  'Chak 236 GB': 'Jaranwala', 'Chak 398 GB': 'Tandlianwala', 'Chak 412 GB': 'Tandlianwala', 'Chak 467 GB': 'Samundri',
  'Chak 474 GB': 'Samundri', 'Chak 65 GB': 'Jaranwala', 'Chak Jhumra City': 'Chak Jhumra', 'Chalk 224 RB': 'Jinnah Town',
  'D-Type Colony': 'Jinnah Town', 'Factory Area': 'Iqbal Town', 'Gatwala': 'Madina Town', 'Ghulam Muhammad Abad': 'Lyallpur Town',
  'Gulberg': 'Jinnah Town', 'Gulfishan Colony': 'Iqbal Town', 'Jaranwala City': 'Jaranwala', 'Jhang Road': 'Jinnah Town',
  'Kachi Abadi': 'Iqbal Town', 'Kohinoor City': 'Madina Town', 'Madina Town': 'Madina Town', 'Manawala': 'Madina Town',
  'Millat Town': 'Lyallpur Town', 'Model Town': 'Jinnah Town', 'Nishatabad': 'Lyallpur Town', 'Noor Pur': 'Lyallpur Town',
  'Novelty Bridge': 'Iqbal Town', 'Saline Zone-A': 'Chak Jhumra', 'Saline Zone-B': 'Jaranwala', 'Saline Zone-C': 'Samundri',
  'Saline Zone-D': 'Tandlianwala', 'Samanabad': 'Jinnah Town', 'Samundri City': 'Samundri', 'Samundri Road': 'Iqbal Town',
  'Sargodha Road': 'Lyallpur Town', 'Susan Road': 'Madina Town', 'Tandlianwala City': 'Tandlianwala',
};
const TOWNS = ['Faisalabad', 'Jaranwala', 'Chak Jhumra', 'Iqbal Town', 'Jinnah Town', 'Lyallpur Town', 'Samundri', 'Madina Town', 'Tandlianwala'];

let t, gaz, db;

test.before(async () => {
  t = await startTestServer();
  db = t.db;
  gaz = require('../server/lib/gazetteer'); // after startTestServer: fresh module graph bound to the temp DB
});
test.after(async () => { await t.close(); });

const names = (results) => results.map((r) => r.name);
const areaRow = (name, town) => db.prepare('SELECT * FROM areas WHERE name = ? AND town IS ?').get(name, town ?? null);

// ───────────── data file ─────────────

test('gazetteer file: every spreadsheet area and town is present with its town', () => {
  const areas = DATA.entries.filter((e) => e.kind === 'area');
  assert.equal(areas.length, 39);
  for (const [name, town] of Object.entries(SPREADSHEET_AREAS)) {
    const e = areas.find((a) => a.name === name);
    assert.ok(e, `missing area ${name}`);
    assert.equal(e.town, town, `town of ${name}`);
  }
  for (const name of TOWNS) assert.ok(DATA.entries.some((e) => e.kind === 'town' && e.name === name), `missing town ${name}`);
});

test('gazetteer file: provenance, bounds and status rules', () => {
  const [[s, w], [n, e]] = [[30.75, 72.6], [31.85, 73.65]];
  assert.ok(Array.isArray(DATA.sources) && DATA.sources.length > 0);
  assert.equal(DATA.generatedAt, '2026-09-25');
  for (const x of DATA.entries) {
    assert.ok(['matched', 'ambiguous', 'not_found', 'not_geocodable'].includes(x.geocodeStatus), x.name);
    assert.ok(typeof x.geocodeNote === 'string' && x.geocodeNote.length > 20, `note for ${x.name}`);
    assert.ok(x.nameUr && /[؀-ۿ]/.test(x.nameUr), `Urdu name for ${x.name}`);
    assert.ok(['osm', 'wikipedia', 'transliteration', 'wof'].includes(x.nameUrSource), `nameUrSource for ${x.name}`);
    if (x.lat !== null) {
      assert.ok(x.lat >= s && x.lat <= n && x.lng >= w && x.lng <= e, `${x.name} inside bounds`);
    }
    if (x.geocodeStatus === 'matched') {
      assert.ok(x.lat !== null && x.geocodeSource && x.geocodeRef && x.radiusM > 0, `matched ${x.name} has position + source`);
    }
    if (x.geocodeStatus === 'not_found' || x.geocodeStatus === 'not_geocodable') assert.equal(x.lat, null, x.name);
  }
  for (const generic of ['Saline Zone-A', 'Saline Zone-B', 'Saline Zone-C', 'Saline Zone-D', 'Kachi Abadi', 'Factory Area']) {
    assert.equal(DATA.entries.find((x) => x.name === generic).geocodeStatus, 'not_geocodable', generic);
  }
  for (const road of ['Canal Road', 'Jhang Road', 'Susan Road', 'Sargodha Road', 'Samundri Road']) {
    assert.notEqual(DATA.entries.find((x) => x.name === road).geocodeStatus, 'matched', `${road} must not be a single matched point`);
  }
  const typo = DATA.entries.find((x) => x.name === 'Chalk 224 RB');
  assert.ok(typo.aliases.includes('Chak 224 RB'), 'typo keeps original name and gets the corrected alias');
});

// ───────────── sync ─────────────

test('syncAreasToDb inserts every entry once and is idempotent', () => {
  const first = gaz.syncAreasToDb();
  assert.equal(first.inserted, DATA.entries.length);
  assert.equal(first.skippedManual, 0);
  const second = gaz.syncAreasToDb();
  assert.deepEqual({ ...second }, { inserted: 0, updated: 0, unchanged: DATA.entries.length, skippedManual: 0, total: DATA.entries.length });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM areas').get().n, DATA.entries.length);

  const model = areaRow('Model Town', 'Jinnah Town');
  assert.equal(model.area_key, 'model-town|jinnah-town');
  assert.equal(model.geocode_status, 'not_found');
  assert.ok(JSON.parse(model.aliases_json).includes('Modal Town'));
  assert.equal(areaRow('Jaranwala', null).area_key, 'town:jaranwala');
  assert.ok(db.prepare("SELECT 1 FROM areas WHERE area_key = 'landmark:faisalabad-international-airport' AND kind = 'landmark'").get());
});

test('syncAreasToDb never overwrites administrator edits (manual status or reviewed_at)', () => {
  gaz.syncAreasToDb();
  const now = new Date().toISOString();
  const model = areaRow('Model Town', 'Jinnah Town');
  db.prepare("UPDATE areas SET geocode_status = 'manual', latitude = 31.41, longitude = 73.1, radius_m = 900, updated_at = ? WHERE id = ?").run(now, model.id);
  const gatwala = areaRow('Gatwala', 'Madina Town');
  db.prepare("UPDATE areas SET reviewed_at = ?, geocode_note = 'reviewed by admin', updated_at = ? WHERE id = ?").run(now, now, gatwala.id);

  // A changed gazetteer file must update normal rows but leave the two edited rows alone.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-gaz-')), 'faisalabad.json');
  const changed = JSON.parse(JSON.stringify(DATA));
  for (const e of changed.entries) {
    if (['Model Town', 'Gatwala', 'Gulberg'].includes(e.name)) e.aliases = [...e.aliases, 'Test Alias'];
  }
  fs.writeFileSync(tmp, JSON.stringify(changed));
  const res = gaz.syncAreasToDb({ file: tmp });
  assert.equal(res.skippedManual, 2);
  assert.equal(res.updated, 1);

  const m2 = areaRow('Model Town', 'Jinnah Town');
  assert.equal(m2.geocode_status, 'manual');
  assert.equal(m2.latitude, 31.41);
  assert.equal(m2.radius_m, 900);
  assert.ok(!JSON.parse(m2.aliases_json).includes('Test Alias'));
  const g2 = areaRow('Gatwala', 'Madina Town');
  assert.equal(g2.geocode_note, 'reviewed by admin');
  assert.ok(JSON.parse(areaRow('Gulberg', 'Jinnah Town').aliases_json).includes('Test Alias'));

  // Manual rows are usable: search exposes the admin position and nearestArea can return it.
  const hit = gaz.search('model town')[0];
  assert.equal(hit.geocodeStatus, 'manual');
  assert.equal(hit.lat, 31.41);
  assert.equal(gaz.nearestArea(31.4101, 73.1001, { kinds: ['area'] }).name, 'Model Town');

  // restore the canonical data for the following tests
  db.prepare("UPDATE areas SET geocode_status = 'not_found', latitude = NULL, longitude = NULL, radius_m = NULL, reviewed_at = NULL, updated_at = ? WHERE id IN (?, ?)").run(new Date().toISOString(), model.id, gatwala.id);
  gaz.syncAreasToDb();
  assert.equal(areaRow('Model Town', 'Jinnah Town').geocode_status, 'not_found');
});

// ───────────── search ─────────────

test('search: English names', () => {
  gaz.syncAreasToDb();
  const r = gaz.search('Model Town');
  assert.equal(r[0].name, 'Model Town');
  assert.equal(r[0].kind, 'area');
  assert.equal(r[0].town, 'Jinnah Town');
  assert.equal(r[0].matchedAlias, null);
  assert.equal(r[0].geocodeStatus, 'not_found');
  assert.equal(r[0].lat, null, 'no position is invented');
  assert.equal(r[0].usable, false);
  for (const k of ['id', 'kind', 'name', 'town', 'nameUr', 'lat', 'lng', 'radiusM', 'geocodeStatus', 'matchedAlias', 'score', 'plantCount']) assert.ok(k in r[0], k);

  const jar = gaz.search('jaranwala');
  assert.deepEqual(names(jar).slice(0, 2), ['Jaranwala', 'Jaranwala City']);
  assert.equal(jar[0].kind, 'town');
  assert.ok(jar[0].lat > 31 && jar[0].lng > 73, 'matched town has a position');
  assert.equal(gaz.search('faisalabad')[0].name, 'Faisalabad');
});

test('search: Roman Urdu spellings', () => {
  const cases = {
    gulbarg: 'Gulberg', 'madina taun': 'Madina Town', 'jhang rd': 'Jhang Road', samundari: 'Samundri',
    tandliawala: 'Tandlianwala', jarranwala: 'Jaranwala', lyallpur: 'Faisalabad', 'nishat abad': 'Nishatabad',
    'ghulam mohammad abad': 'Ghulam Muhammad Abad', noorpur: 'Noor Pur',
  };
  for (const [q, want] of Object.entries(cases)) assert.equal(gaz.search(q)[0].name, want, q);
});

test('search: Urdu script', () => {
  const model = gaz.search('ماڈل ٹاؤن')[0];
  assert.equal(model.name, 'Model Town');
  assert.equal(model.matchedAlias, 'ماڈل ٹاؤن');
  assert.equal(gaz.search('فیصل آباد')[0].name, 'Faisalabad');
  assert.equal(gaz.search('لائل پور')[0].name, 'Faisalabad');
  assert.equal(gaz.search('سمندری')[0].name, 'Samundri');
  assert.equal(gaz.search('چک ۲۲۴')[0].name, 'Chalk 224 RB', 'Urdu digits');
});

test('search: chak numbers and the "Chalk 224 RB" typo alias', () => {
  for (const q of ['Chak 224 RB', 'chak 224', '224', '224rb', '224 r.b', 'Chak No. 224 R.B.', 'chak no 224 rb', 'Chalk 224']) {
    const r = gaz.search(q);
    assert.equal(r[0] && r[0].name, 'Chalk 224 RB', q);
  }
  const hit = gaz.search('chak 224 rb')[0];
  assert.equal(hit.matchedAlias, 'Chak 224 RB');
  assert.equal(hit.geocodeStatus, 'matched');
  assert.ok(hit.lat !== null && hit.radiusM > 0);
  assert.ok(!names(gaz.search('chak 24')).includes('Chalk 224 RB'), 'numbers never match fuzzily');
  assert.equal(gaz.search('185')[0].name, 'Chak 185 RB');
  assert.equal(gaz.search('65 gb')[0].name, 'Chak 65 GB');
});

test('search: light fuzzy matching and determinism', () => {
  assert.equal(gaz.search('nishatabd')[0].name, 'Nishatabad');
  assert.equal(gaz.search('gulbeg')[0].name, 'Gulberg');
  assert.equal(gaz.search('samanabd')[0].name, 'Samanabad');
  assert.equal(gaz.search('tandlianwalla')[0].name, 'Tandlianwala');
  assert.deepEqual(names(gaz.search('saline zone a')), ['Saline Zone-A'], 'one-letter zone difference is meaningful');
  assert.deepEqual(gaz.search('xyzzy qqq'), []);
  assert.deepEqual(gaz.search('   '), []);

  const a = gaz.search('chak', { limit: 20 });
  const b = gaz.search('chak', { limit: 20 });
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].score >= a[i].score, 'sorted by score');
  assert.equal(gaz.search('chak', { limit: 3 }).length, 3);
});

test('search: ambiguous and unusable rows never expose a position', () => {
  const r = gaz.search('chak 190 rb')[0];
  assert.equal(r.name, 'Chak 190 RB');
  assert.equal(r.geocodeStatus, 'ambiguous');
  assert.equal(r.lat, null);
  assert.equal(r.lng, null);
  assert.equal(r.usable, false);
  assert.notEqual(areaRow('Chak 190 RB', 'Chak Jhumra').latitude, null, 'candidate kept in the DB for admin review');
});

test('search: plantCount counts plants linked by area_id (towns by plants.town)', () => {
  const area = areaRow('Model Town', 'Jinnah Town');
  t.insertPlant({ area_id: area.id, town: 'Jinnah Town', area_raw: 'Model Town - Sector 1', area_name: 'Model Town' });
  t.insertPlant({ area_id: area.id, town: 'Jinnah Town', area_raw: 'Model Town - Sector 2', area_name: 'Model Town' });
  assert.equal(gaz.search('model town')[0].plantCount, 2);
  assert.equal(gaz.search('jinnah town').find((x) => x.kind === 'town').plantCount, 2);
  assert.equal(gaz.search('gulberg')[0].plantCount, 0);
});

// ───────────── ensureArea / nearestArea / isUsable ─────────────

test('ensureArea returns existing rows and creates missing ones as not_attempted', () => {
  const existing = areaRow('Chalk 224 RB', 'Jinnah Town');
  assert.equal(gaz.ensureArea('Chalk 224 RB', 'Jinnah Town'), existing.id);
  assert.equal(gaz.ensureArea('  chalk 224  rb ', 'JINNAH TOWN'), existing.id, 'same area_key after normalisation');

  const id = gaz.ensureArea('Peoples Colony', 'Madina Town');
  const row = db.prepare('SELECT * FROM areas WHERE id = ?').get(id);
  assert.equal(row.kind, 'area');
  assert.equal(row.geocode_status, 'not_attempted');
  assert.equal(row.area_key, 'peoples-colony|madina-town');
  assert.equal(row.latitude, null);
  assert.equal(gaz.ensureArea('Peoples Colony', 'Madina Town'), id, 'idempotent');
  assert.equal(gaz.search('peoples colony')[0].id, id, 'search cache sees the new row');
  assert.throws(() => gaz.ensureArea('  ', 'Madina Town'));

  const before = gaz.syncAreasToDb();
  assert.equal(before.inserted, 0, 'sync leaves importer-created rows alone');
  assert.ok(db.prepare('SELECT 1 FROM areas WHERE id = ?').get(id));
});

test('nearestArea uses only matched/manual rows within maxKm', () => {
  const typo = areaRow('Chalk 224 RB', 'Jinnah Town');
  const near = gaz.nearestArea(typo.latitude + 0.001, typo.longitude, { kinds: ['area'] });
  assert.equal(near.name, 'Chalk 224 RB');
  assert.ok(near.distanceM > 50 && near.distanceM < 200);
  assert.equal(near.withinRadius, true);

  // Standing exactly on the ambiguous Chak 190 RB candidate must not return it.
  const amb = areaRow('Chak 190 RB', 'Chak Jhumra');
  const r = gaz.nearestArea(amb.latitude, amb.longitude, { maxKm: 5 });
  assert.ok(!r || r.name !== 'Chak 190 RB');

  assert.equal(gaz.nearestArea(30.2, 70.5), null, 'nothing within 5 km');
  assert.equal(gaz.nearestArea(typo.latitude + 0.05, typo.longitude, { maxKm: 1, kinds: ['area'] }), null);
  assert.equal(gaz.nearestArea('x', 73), null);
});

test('isUsable and invalidate', () => {
  assert.equal(gaz.isUsable({ geocode_status: 'matched', latitude: 31.4, longitude: 73.1 }), true);
  assert.equal(gaz.isUsable({ geocode_status: 'manual', latitude: 31.4, longitude: 73.1 }), true);
  assert.equal(gaz.isUsable({ geocodeStatus: 'matched', lat: 31.4, lng: 73.1 }), true);
  assert.equal(gaz.isUsable({ geocode_status: 'ambiguous', latitude: 31.4, longitude: 73.1 }), false);
  assert.equal(gaz.isUsable({ geocode_status: 'matched', latitude: null, longitude: null }), false);
  assert.equal(gaz.isUsable(null), false);

  // A direct edit that does not touch updated_at is picked up after invalidate().
  const row = areaRow('Kohinoor City', 'Madina Town');
  const before = db.prepare('SELECT updated_at FROM areas WHERE id = ?').get(row.id).updated_at;
  db.prepare('UPDATE areas SET aliases_json = ? WHERE id = ?').run(JSON.stringify(['Zebra Crossing Town']), row.id);
  assert.equal(db.prepare('SELECT updated_at FROM areas WHERE id = ?').get(row.id).updated_at, before);
  gaz.invalidate();
  assert.equal(gaz.search('zebra crossing town')[0].name, 'Kohinoor City');
});
