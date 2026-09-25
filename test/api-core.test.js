'use strict';
// Core API tests: search ranking, plant views, geocoding/routing providers (stubbed fetch), admin plants/system.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

// Origin used for searches (central Faisalabad). 0.009° latitude ≈ 1.0 km.
const O = { lat: 31.418, lng: 73.079 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

test('core api', async (t) => {
  const s = await startTestServer();
  const config = require('../server/config');
  const providers = require('../server/lib/providers');
  const realFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = realFetch; await s.close(); });

  let extCalls = [];
  function stubFetch(handler) {
    extCalls = [];
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).startsWith(s.base)) return realFetch(url, opts);
      extCalls.push({ url: String(url), opts });
      return handler(String(url), opts);
    };
  }
  function restore() {
    globalThis.fetch = realFetch;
    providers.resetAll();
    config.geocoder.provider = 'none';
    config.routing.provider = 'none';
    config.routing.osrmUrl = 'https://router.project-osrm.org';
    config.googleServerKey = '';
    config.map.provider = 'osm';
    config.demoData = false;
  }
  const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const clearRate = () => s.db.prepare('DELETE FROM rate_events').run();
  const get = async (p, client = s) => { const r = await client.fetch(p); return { status: r.status, body: await r.json(), headers: r.headers }; };
  const search = (qs = '') => get(`/api/search?lat=${O.lat}&lng=${O.lng}${qs}`);
  const codes = (list) => list.map((p) => p.code);

  // ── Fixtures ──
  const now = new Date().toISOString();
  function insertArea({ name, town = 'Jinnah Town', lat = null, lng = null, status = 'matched', radius = 1500, nameUr = null, aliases = [], kind = 'area' }) {
    const r = s.db.prepare(`INSERT INTO areas (area_key, kind, name, town, name_ur, aliases_json, latitude, longitude, radius_m, geocode_status, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`${name.toLowerCase().replace(/\W+/g, '-')}|${town.toLowerCase().replace(/\W+/g, '-')}`, kind, name, town, nameUr, JSON.stringify(aliases), lat, lng, radius, status, now);
    return Number(r.lastInsertRowid);
  }
  const exactAt = (code, dLatKm, o = {}) => s.insertPlant({
    plant_code: code, latitude: O.lat + dLatKm * 0.009, longitude: O.lng, coord_status: 'source', coord_source: 'spreadsheet', ...o,
  });

  const A1 = insertArea({ name: 'Model Town', lat: 31.43, lng: 73.09, nameUr: 'ماڈل ٹاؤن', aliases: ['model taun'] });
  const A2 = insertArea({ name: 'Saline Zone-A', town: 'Iqbal Town', status: 'not_geocodable' });
  const A3 = insertArea({ name: 'Peoples Colony', town: 'Madina Town', lat: 31.4, lng: 73.1, status: 'manual' });

  const E1 = exactAt('CORE-E001', 1, { review_reasons_json: '["status_undated","capacity_gallon_type_unspecified"]', source_file: 'Filter.xlsx', source_sheet: 'Sheet1', source_row: 7, source_values_json: '{"Plant ID":"CORE-E001"}', area_id: A1 });
  const E2 = exactAt('CORE-E002', 2);
  const E3 = exactAt('CORE-E003', 3, { status: 'temporarily_closed', status_source: 'admin' });
  exactAt('CORE-E004', 0.5, { status: 'permanently_closed', status_source: 'admin' });
  exactAt('CORE-E005', 30.5); // beyond the 30 km radius
  const T2 = exactAt('CORE-T002', 4);
  const T1 = exactAt('CORE-T001', 4);
  s.insertPlant({ plant_code: 'CORE-P001', latitude: O.lat + 0.001, longitude: O.lng, coord_status: 'geocoded_pending' }); // not public
  const A001 = s.insertPlant({ plant_code: 'CORE-A001', area_id: A1, area_raw: 'Model Town - Sector 2', area_name: 'Model Town', town: 'Jinnah Town' });
  s.insertPlant({ plant_code: 'CORE-A002', area_id: A3, area_raw: 'Peoples Colony - Sector 1', area_name: 'Peoples Colony', town: 'Madina Town' });
  s.insertPlant({ plant_code: 'CORE-A003', area_id: A1, status: 'permanently_closed', status_source: 'admin' });
  s.insertPlant({ plant_code: 'CORE-N001', area_id: A2 });
  const N2 = s.insertPlant({ plant_code: 'CORE-N002', name: '=HYPERLINK("http://evil")' });
  const EXCLUDED_NO_LOCATION = 3; // P001 (pending coords are not public), N001 (area without position), N002

  await t.test('geo helpers', () => {
    const geo = require('../server/lib/geo');
    assert.deepEqual(geo.parseLatLng('31.4,73.07'), { lat: 31.4, lng: 73.07 });
    assert.deepEqual(geo.parseLatLng(' -1.5 , 2 '), { lat: -1.5, lng: 2 });
    for (const bad of ['', 'abc', '31.4', '91,0', '0,181', '1e2,3', '31.4,73.0,1', '0x1,2']) assert.equal(geo.parseLatLng(bad), null, bad);
    const d = geo.haversineM(31.418, 73.079, 31.427, 73.079);
    assert.ok(Math.abs(d - 1000.8) < 2, `haversine ${d}`);
    assert.ok(geo.inBounds(31.418, 73.079));
    assert.ok(!geo.inBounds(24.86, 67.0));
  });

  await t.test('opening hours: overnight ranges, unknown days, Asia/Karachi', () => {
    const { openNow, validateHours } = require('../server/lib/hours');
    const { karachiParts } = require('../server/lib/time');
    const at = (iso) => new Date(iso);
    assert.equal(karachiParts(at('2026-09-21T17:00:00Z')).weekday, 'mon'); // 22:00 PKT (UTC+5)
    const h = { mon: [['20:00', '02:00']], tue: [['09:00', '17:00']] };
    assert.equal(openNow(h, at('2026-09-21T17:00:00Z')), true); // Mon 22:00
    assert.equal(openNow(h, at('2026-09-21T20:30:00Z')), true); // Tue 01:30 (Monday's overnight range)
    assert.equal(openNow(h, at('2026-09-21T22:30:00Z')), false); // Tue 03:30
    assert.equal(openNow(h, at('2026-09-22T05:00:00Z')), true); // Tue 10:00
    assert.equal(openNow(h, at('2026-09-23T05:00:00Z')), null); // Wed unknown
    assert.equal(openNow({ tue: [], wed: [['00:00', '24:00']] }, at('2026-09-23T18:59:00Z')), true); // Wed 23:59
    assert.equal(openNow({ tue: [], wed: [] }, at('2026-09-23T05:00:00Z')), false);
    assert.throws(() => validateHours({ mon: [['8:00', '20:00']] }));
    assert.throws(() => validateHours({ funday: [] }));
    assert.throws(() => validateHours({ mon: [['10:00', '10:00']] }));
    assert.deepEqual(validateHours('{"sun":[]}'), { sun: [] });
  });

  await t.test('nearest: exact group ordering, determinism, exclusions, straight-line label', async () => {
    const r1 = await search();
    assert.equal(r1.status, 200);
    const b = r1.body;
    assert.deepEqual(codes(b.exact), ['CORE-E001', 'CORE-E002', 'CORE-E003', 'CORE-T001', 'CORE-T002']);
    assert.deepEqual(b.origin, O);
    assert.equal(b.sort, 'nearest');
    assert.equal(b.distance.method, 'straight_line');
    assert.equal(b.distance.label, 'Approximate straight-line distance');
    assert.equal(b.distance.routingAvailable, false);
    assert.equal(b.distance.routingReason, 'disabled');
    assert.deepEqual(b.excluded, { closedPermanently: 2, noLocation: EXCLUDED_NO_LOCATION });
    assert.equal(b.notice, null);
    const first = b.exact[0];
    assert.equal(first.rank, 1);
    assert.equal(first.distanceMethod, 'straight_line');
    assert.ok(Math.abs(first.distanceM - 1001) <= 2);
    assert.equal(first.durationS, null);
    assert.equal(first.recommendation, null);
    assert.equal(first.location.precision, 'exact');
    assert.equal(first.location.lat, E1.latitude); // never rounded
    assert.equal(first.location.lng, E1.longitude);
    assert.equal(first.status.raw, 'Fully Functional');
    assert.equal(first.status.verified, false);
    const r2 = await search();
    assert.deepEqual(r2.body, b, 'same inputs give identical output');
    // the pending (unreviewed geocoder) coordinate never appears
    assert.ok(![...b.exact, ...b.area].some((p) => p.code === 'CORE-P001'));
  });

  await t.test('area group: area-centre distance, no plant position, capped at limit', async () => {
    const { body } = await search();
    assert.deepEqual(codes(body.area), ['CORE-A001', 'CORE-A002']);
    const a = body.area[0];
    assert.equal(a.distanceMethod, 'area_centre');
    assert.equal(a.location.precision, 'area');
    assert.equal(a.location.lat, null);
    assert.equal(a.location.lng, null);
    assert.deepEqual(a.location.area, { id: A1, name: 'Model Town', lat: 31.43, lng: 73.09, radiusM: 1500 });
    assert.equal(body.distance.areaMethod, 'area_centre');
    assert.match(body.distance.areaLabel, /centre of the listed area — the plant's exact site is not recorded/);
    const capped = await search('&limit=1');
    assert.equal(capped.body.area.length, 1);
    assert.equal(capped.body.exact.length, 1);
  });

  await t.test('closed plants excluded; temporary closure flagged or hidden; filters', async () => {
    const { body } = await search();
    const all = [...body.exact, ...body.area].map((p) => p.code);
    assert.ok(!all.includes('CORE-E004') && !all.includes('CORE-A003'));
    const e3 = body.exact.find((p) => p.code === 'CORE-E003');
    assert.equal(e3.status.code, 'temporarily_closed');
    const hidden = await search('&hideTemporarilyClosed=1');
    assert.ok(!hidden.body.exact.some((p) => p.code === 'CORE-E003'));
    const tech = await search(`&technology=${encodeURIComponent('Ultrafiltration (UF)')}`);
    assert.equal(tech.body.exact.length, 0);
    assert.equal(tech.body.excluded.noLocation, 0);
  });

  await t.test('search input validation', async () => {
    assert.equal((await get('/api/search?lat=31.4')).status, 400);
    assert.equal((await get('/api/search?lat=abc&lng=73')).status, 400);
    assert.equal((await search('&limit=500')).status, 400);
    assert.equal((await search('&sort=best')).status, 400);
    assert.equal((await search('&mode=teleport')).status, 400);
    assert.equal((await get('/api/search?lat=24.86&lng=67.0')).body.notice, 'origin_outside_coverage');
  });

  await t.test('recommended: reasons, plain text, never "safe" without tests, ratings separate', async () => {
    // 5 accepted 5-star ratings for E2 (and one pending that must not count)
    for (let i = 0; i < 5; i++) s.db.prepare("INSERT INTO ratings (plant_id, stars, status, created_at) VALUES (?, 5, 'accepted', ?)").run(E2.id, now);
    s.db.prepare("INSERT INTO ratings (plant_id, stars, status, created_at) VALUES (?, 1, 'pending', ?)").run(E2.id, now);
    // recent published met_limits test for T1
    const sample = new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10);
    const tid = s.db.prepare(`INSERT INTO water_tests (plant_id, sample_date, laboratory, standard_name, outcome, published, created_at)
                              VALUES (?, ?, 'Lab X', 'Std Y', 'met_limits', 1, ?)`).run(T1.id, sample, now).lastInsertRowid;
    s.db.prepare("INSERT INTO water_test_results (test_id, parameter, value_text, within_limit) VALUES (?, 'pH', '7.1', 1)").run(tid);

    const { body } = await search('&sort=recommended');
    assert.equal(body.sort, 'recommended');
    const byCode = Object.fromEntries([...body.exact, ...body.area].map((p) => [p.code, p]));
    const e1 = byCode['CORE-E001'].recommendation;
    assert.ok(e1.score > 0 && e1.score <= 1);
    assert.equal(e1.text, 'Nearby; listed as operational in the source spreadsheet (not verified); no verified water-test data.');
    for (const code of ['nearby', 'status_listed_unverified', 'no_test_data', 'hours_unknown', 'few_ratings', 'not_verified']) assert.ok(e1.reasons.includes(code), code);

    const e2 = byCode['CORE-E002'];
    assert.deepEqual(e2.rating, { average: 5, adjusted: 4, count: 5 }); // (5·3 + 25) / (5 + 5)
    assert.ok(e2.recommendation.reasons.includes('well_rated'));
    assert.ok(e2.recommendation.reasons.includes('no_test_data'), 'ratings never stand in for test evidence');
    assert.equal(e2.waterQuality.state, 'unknown');

    assert.ok(byCode['CORE-T001'].recommendation.reasons.includes('recent_test_met_limits'));
    assert.equal(byCode['CORE-T001'].waterQuality.state, 'met_limits');
    assert.ok(byCode['CORE-E003'].recommendation.reasons.includes('temporarily_closed'));
    assert.ok(byCode['CORE-A001'].recommendation.reasons.includes('location_approximate'));

    for (const p of Object.values(byCode)) {
      const r = p.recommendation;
      assert.ok(r && Array.isArray(r.reasons) && typeof r.text === 'string');
      if (p.waterQuality.state !== 'met_limits') {
        assert.ok(!/\bsafe\b|\bsafer\b|clean/i.test(r.text), `no safety claim: ${r.text}`);
        assert.ok(!r.reasons.includes('recent_test_met_limits'));
      }
    }
    // sorted by score (desc) within each group
    for (const group of [body.exact, body.area]) {
      for (let i = 1; i < group.length; i++) assert.ok(group[i - 1].recommendation.score >= group[i].recommendation.score);
    }
  });

  await t.test('plant detail: capacity without litres when gallon type unspecified, computed fields', async () => {
    const { status, body } = await get('/api/plants/CORE-E001');
    assert.equal(status, 200);
    assert.deepEqual(body.capacity, {
      raw: '1000 GPH', value: 1000, unit: 'gallons_per_hour', unitLabel: 'GPH', gallonType: 'unspecified', basis: null, litresPerHour: null, litresPerDay: null,
    });
    assert.equal(body.rank, undefined, 'no ranking fields in detail');
    assert.deepEqual(body.dataIssues, ['status_undated', 'capacity_gallon_type_unspecified']);
    assert.deepEqual(body.missingFields, ['name', 'address', 'openingHours', 'collectionLimit', 'contact', 'accessibility', 'waterTests']);
    assert.deepEqual(body.traceability, { sourceFile: 'Filter.xlsx', sheet: 'Sheet1', row: 7, importedAt: null });
    assert.deepEqual(body.sourceValues, { 'Plant ID': 'CORE-E001' });
    assert.deepEqual(body.waterQuality, { state: 'unknown', latestSampleDate: null, testCount: 0 });
    assert.deepEqual(body.reportsSummary, { unverifiedOpen: 0, underReview: 0, confirmedOpenIssues: [], resolvedLast90d: 0 });
    for (const k of ['operatorName', 'neighborhood', 'publicPhone', 'publicContactNote', 'accessibility', 'waterTests', 'sources']) assert.ok(k in body, k);

    const us = s.insertPlant({ plant_code: 'CORE-G001', capacity_gallon_type: 'us' });
    assert.equal((await get('/api/plants/CORE-G001')).body.capacity.litresPerHour, 3785);
    s.db.prepare("UPDATE plants SET capacity_gallon_type = 'imperial' WHERE id = ?").run(us.id);
    assert.equal((await get('/api/plants/CORE-G001')).body.capacity.litresPerHour, 4546);
    s.db.prepare('DELETE FROM plants WHERE id = ?').run(us.id);

    assert.equal((await get('/api/plants/NOPE-0001')).status, 404);
    assert.equal((await get('/api/plants/..%2Fetc')).status, 404);
  });

  await t.test('text list: by area / town / q, ordered by code', async () => {
    const byArea = await get(`/api/plants?area=${A1}`);
    assert.deepEqual(codes(byArea.body.items), ['CORE-A001', 'CORE-E001']);
    assert.equal(byArea.body.items[0].rank, undefined);
    const byTown = await get('/api/plants?town=Madina%20Town');
    assert.deepEqual(codes(byTown.body.items), ['CORE-A002']);
    const q = await get('/api/plants?q=CORE-N');
    assert.deepEqual(codes(q.body.items), ['CORE-N001', 'CORE-N002']);
    assert.equal(q.body.items[1].location.precision, 'none');
    const paged = await get('/api/plants?pageSize=2&page=2');
    assert.equal(paged.body.items.length, 2);
    assert.equal(paged.body.page, 2);
  });

  await t.test('route: stored coordinates only; area plants → no_exact_location; provider states', async () => {
    clearRate();
    assert.deepEqual((await get('/api/route?from=31.418,73.079&to=CORE-A001')).body, { available: false, reason: 'no_exact_location' });
    assert.deepEqual((await get('/api/route?from=31.418,73.079&to=CORE-E001')).body, { available: false, reason: 'disabled' });
    assert.equal((await get('/api/route?from=abc&to=CORE-E001')).status, 400);
    assert.equal((await get('/api/route?from=31.4,73.0&to=NOPE-1')).status, 404);

    config.routing.provider = 'osrm';
    config.routing.osrmUrl = 'http://osrm.test';
    stubFetch(async (url) => {
      assert.match(url, /^http:\/\/osrm\.test\/route\/v1\/driving\//);
      return jsonRes({ code: 'Ok', routes: [{ distance: 1234.5, duration: 321.9, geometry: { type: 'LineString', coordinates: [[73.079, 31.418], [73.079, 31.427]] } }] });
    });
    try {
      const r = await get('/api/route?from=31.418,73.079&to=CORE-E001&toLat=0&toLng=0');
      assert.equal(r.body.available, true);
      assert.equal(r.body.provider, 'osrm');
      assert.equal(r.body.distanceM, 1234.5);
      assert.equal(r.body.geometry.type, 'LineString');
      const u = new URL(extCalls[0].url);
      assert.ok(u.pathname.endsWith(`/73.079,31.418;${E1.longitude},${E1.latitude}`), 'destination = stored plant coordinates');
      assert.equal(u.searchParams.get('overview'), 'full');
      assert.equal(u.searchParams.get('geometries'), 'geojson');
      assert.deepEqual((await get('/api/route?from=31.418,73.079&to=CORE-E001&mode=walking')).body, { available: false, reason: 'mode_unsupported' });
    } finally { restore(); }
  });

  await t.test('OSRM table re-ranks the top candidates by duration; failures degrade explicitly', async () => {
    config.routing.provider = 'osrm';
    config.routing.osrmUrl = 'http://osrm.test';
    // destination order (straight line): E001, E002, E003, T001, T002
    const durations = [600, 120, 900, 300, 300];
    stubFetch(async (url) => {
      const u = new URL(url);
      assert.match(u.pathname, /^\/table\/v1\/driving\//);
      assert.equal(u.searchParams.get('sources'), '0');
      assert.equal(u.searchParams.get('annotations'), 'duration,distance');
      assert.equal(u.searchParams.get('destinations'), '1;2;3;4;5');
      return jsonRes({ code: 'Ok', durations: [durations], distances: [durations.map((d) => d * 10)] });
    });
    try {
      const { body } = await search();
      assert.equal(body.distance.method, 'route');
      assert.equal(body.distance.routingAvailable, true);
      assert.equal(body.distance.routingReason, null);
      assert.deepEqual(codes(body.exact), ['CORE-E002', 'CORE-T001', 'CORE-T002', 'CORE-E001', 'CORE-E003']);
      assert.equal(body.exact[0].durationS, 120);
      assert.equal(body.exact[0].distanceM, 1200);
      assert.equal(body.exact[0].distanceMethod, 'route');
      assert.equal(body.area[0].distanceMethod, 'area_centre');
      assert.equal(extCalls.length, 1);

      const walk = await search('&mode=walking');
      assert.equal(walk.body.distance.routingReason, 'mode_unsupported');
      assert.equal(walk.body.distance.method, 'straight_line');

      stubFetch(async () => { throw new TypeError('fetch failed'); });
      const down = await search();
      assert.equal(down.body.distance.method, 'straight_line');
      assert.equal(down.body.distance.routingAvailable, false);
      assert.equal(down.body.distance.routingReason, 'provider_unavailable');
      assert.deepEqual(codes(down.body.exact), ['CORE-E001', 'CORE-E002', 'CORE-E003', 'CORE-T001', 'CORE-T002']);
      const again = await search();
      assert.equal(again.body.distance.routingReason, 'provider_unavailable');
      assert.equal(extCalls.length, 1, 'circuit breaker skips the provider after a failure');
    } finally { restore(); }
  });

  await t.test('geocode: gazetteer results with the external provider unavailable / disabled', async () => {
    clearRate();
    const gaz = require('../server/lib/gazetteer');
    if (typeof gaz.invalidate === 'function') gaz.invalidate();
    const none = await get('/api/geocode?q=model%20town');
    assert.equal(none.status, 200);
    assert.equal(none.body.providers.external, 'disabled');
    assert.ok(none.body.results.some((r) => r.label === 'Model Town' && r.source === 'gazetteer'));

    config.geocoder.provider = 'nominatim';
    stubFetch(async () => { throw new TypeError('fetch failed'); });
    try {
      const typed = await get('/api/geocode?q=model%20town');
      assert.equal(typed.body.providers.external, 'skipped', 'as-you-type queries never reach the provider');
      assert.equal(extCalls.length, 0);
      const r = await get('/api/geocode?q=model%20town&submit=1');
      assert.equal(extCalls.length, 1);
      assert.equal(r.body.providers.external, 'unavailable');
      assert.equal(r.body.providers.gazetteer, 'ok');
      const hit = r.body.results.find((x) => x.label === 'Model Town');
      assert.ok(hit && hit.source === 'gazetteer' && hit.kind === 'area');
      assert.deepEqual(Object.keys(hit).sort(), ['areaId', 'bbox', 'id', 'kind', 'label', 'lat', 'lng', 'matchedAlias', 'plantCount', 'precision', 'source', 'sublabel']);
      assert.equal(hit.id, `area:${A1}`);
      assert.equal(hit.areaId, A1);
      assert.equal(hit.lat, 31.43);
      assert.equal(hit.precision, 'area');
      assert.equal(hit.plantCount, 2, 'open plants only, same rule as /api/plants?area=');
      const unlocated = (await get('/api/geocode?q=saline%20zone')).body.results.find((x) => x.areaId === A2);
      assert.ok(unlocated && unlocated.lat === null && unlocated.lng === null);
      assert.equal((await get('/api/geocode?q=m')).status, 400);
    } finally { restore(); }

    // SQL fallback (used when the gazetteer module lacks search): aliases, Urdu, positionless areas
    const geocoder = require('../server/lib/geocoder');
    const counts = { byArea: new Map([[A1, 2]]), byTown: new Map() };
    const [urdu] = geocoder.sqlGazetteerSearch('ماڈل ٹاؤن', 5, counts);
    assert.equal(urdu.areaId, A1);
    assert.equal(urdu.matchedAlias, 'ماڈل ٹاؤن');
    assert.equal(urdu.lat, 31.43);
    assert.equal(urdu.plantCount, 2);
    assert.equal(geocoder.sqlGazetteerSearch('model taun', 5, counts)[0].areaId, A1);
    const saline = geocoder.sqlGazetteerSearch('saline', 5, counts)[0];
    assert.equal(saline.areaId, A2);
    assert.equal(saline.lat, null);
    assert.equal(saline.precision, 'unknown');
  });

  await t.test('nominatim provider: bounded params, UA, 30-day forward cache, reverse not cached, breaker', async () => {
    clearRate();
    config.geocoder.provider = 'nominatim';
    config.geocoder.email = 'ops@example.org';
    providers.nominatim._test.queue.minIntervalMs = 0;
    stubFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === '/reverse') return jsonRes({ osm_type: 'way', osm_id: 5, address: { road: 'Jail Road', suburb: 'Civil Lines', city: 'Faisalabad' } });
      return jsonRes([
        { osm_type: 'node', osm_id: 1, lat: '31.4187', lon: '73.0791', category: 'tourism', type: 'attraction', addresstype: 'tourism', name: 'Clock Tower', display_name: 'Clock Tower, Kutchery Bazar, Faisalabad, Punjab, 38000, Pakistan', importance: 0.5, boundingbox: ['31.41', '31.42', '73.07', '73.08'] },
        { osm_type: 'node', osm_id: 2, lat: '24.86', lon: '67.01', category: 'tourism', type: 'attraction', name: 'Clock Tower', display_name: 'Clock Tower, Karachi, Pakistan' },
      ]);
    });
    try {
      const r = await get('/api/geocode?q=Clock%20Tower&lang=ur&submit=1');
      assert.equal(r.body.providers.external, 'ok');
      const ext = r.body.results.filter((x) => x.source === 'nominatim');
      assert.equal(ext.length, 1, 'result outside the Faisalabad bounds is dropped');
      assert.equal(ext[0].kind, 'landmark');
      assert.equal(ext[0].sublabel, 'Kutchery Bazar · Faisalabad · Punjab');
      const u = new URL(extCalls[0].url);
      assert.equal(u.pathname, '/search');
      assert.equal(u.searchParams.get('countrycodes'), 'pk');
      assert.equal(u.searchParams.get('bounded'), '1');
      assert.equal(u.searchParams.get('viewbox'), '72.6,31.85,73.65,30.75');
      assert.equal(u.searchParams.get('accept-language'), 'ur,en');
      assert.equal(u.searchParams.get('email'), 'ops@example.org');
      assert.equal(extCalls[0].opts.headers['User-Agent'], config.geocoder.userAgent);
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM geocode_cache WHERE provider = 'nominatim'").get().n, 1);

      await get('/api/geocode?q=clock%20%20TOWER&lang=ur&submit=1'); // same normalised query → cache hit
      assert.equal(extCalls.length, 1);

      const rev = await get('/api/reverse?lat=31.4187&lng=73.0791');
      assert.deepEqual(rev.body, { label: 'Near Jail Road, Civil Lines (approximate)', source: 'nominatim', precision: 'street' });
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM geocode_cache').get().n, 1, 'reverse lookups are not cached');

      // Provider down → reverse falls back to the nearest gazetteer area, and the breaker opens.
      stubFetch(async () => new Response('busy', { status: 503 }));
      const fb = await get('/api/reverse?lat=31.4301&lng=73.0901');
      assert.deepEqual(fb.body, { label: 'Near Model Town (approximate)', source: 'gazetteer', precision: 'area' });
      await get('/api/reverse?lat=31.4301&lng=73.0901');
      assert.equal(extCalls.length, 1, 'breaker skips Nominatim for 60 s after a failure');
      assert.deepEqual((await get('/api/reverse?lat=30.8&lng=72.7')).body, { label: null });
    } finally { config.geocoder.email = ''; restore(); }
  });

  await t.test('nominatim global queue spaces requests ≥ minInterval apart', async () => {
    config.geocoder.provider = 'nominatim';
    providers.nominatim._test.queue.minIntervalMs = 150;
    const starts = [];
    stubFetch(async () => { starts.push(Date.now()); return jsonRes([]); });
    try {
      await Promise.all([providers.nominatim.search('queue a'), providers.nominatim.search('queue b'), providers.nominatim.search('queue c')]);
      assert.equal(starts.length, 3);
      assert.ok(starts[1] - starts[0] >= 140 && starts[2] - starts[1] >= 140, `spacing ${starts}`);
    } finally { providers.nominatim._test.queue.minIntervalMs = 1000; restore(); }
  });

  await t.test('google providers are disabled unless the map is Google (terms)', async () => {
    config.geocoder.provider = 'google';
    config.routing.provider = 'google';
    config.googleServerKey = 'server-key';
    stubFetch(async () => { throw new Error('Google must not be called with an OSM map'); });
    try {
      const cfg = (await get('/api/config')).body;
      assert.deepEqual(cfg.geocoder, { provider: 'none' });
      assert.deepEqual(cfg.routing, { provider: 'none', modes: { driving: false, walking: false, cycling: false } });
      assert.equal((await get('/api/geocode?q=susan%20road&submit=1')).body.providers.external, 'disabled');
      assert.equal((await search()).body.distance.routingReason, 'disabled');
      assert.equal(extCalls.length, 0);
    } finally { restore(); }
  });

  await t.test('geocodeAddress (importer): Nominatim candidates, never Google, gazetteer fallback', async () => {
    const geocoder = require('../server/lib/geocoder');
    config.geocoder.provider = 'nominatim';
    providers.nominatim._test.queue.minIntervalMs = 0;
    stubFetch(async (url) => {
      const q = new URL(url).searchParams.get('q');
      if (q.startsWith('Susan Road')) return jsonRes([{ osm_type: 'way', osm_id: 9, lat: '31.41', lon: '73.11', category: 'highway', type: 'primary', addresstype: 'road', name: 'Susan Road', display_name: 'Susan Road, Madina Town, Faisalabad, Pakistan' }]);
      return jsonRes([]);
    });
    try {
      assert.deepEqual(await geocoder.geocodeAddress('Susan Road', { town: 'Madina Town' }),
        { lat: 31.41, lng: 73.11, precision: 'street', ambiguous: false, source: 'nominatim', ref: 'osm:way/9' });
      assert.equal(new URL(extCalls[0].url).searchParams.get('q'), 'Susan Road, Madina Town, Faisalabad');
      const fallback = await geocoder.geocodeAddress('Model Town');
      assert.equal(fallback.source, 'gazetteer');
      assert.equal(fallback.precision, 'area');
      assert.equal(fallback.ref, `area:${A1}`);
      assert.equal(await geocoder.geocodeAddress('Nowhere Street 99'), null);

      config.geocoder.provider = 'google';
      config.map.provider = 'google';
      config.googleServerKey = 'server-key';
      stubFetch(async () => { throw new Error('geocodeAddress must never call Google (results are stored)'); });
      const g = await geocoder.geocodeAddress('Model Town');
      assert.equal(g.source, 'gazetteer');
      assert.equal(extCalls.length, 0);
    } finally { providers.nominatim._test.queue.minIntervalMs = 1000; restore(); }
  });

  await t.test('google geocoder + routes with a Google map: region/bounds/language, not persisted, field mask', async () => {
    config.map.provider = 'google';
    config.geocoder.provider = 'google';
    config.routing.provider = 'google';
    config.googleServerKey = 'server-key';
    stubFetch(async (url, opts) => {
      if (url.startsWith('https://maps.googleapis.com/maps/api/geocode/json')) {
        return jsonRes({ status: 'OK', results: [{ place_id: 'abc', formatted_address: 'Susan Road, Madina Town, Faisalabad, Pakistan', types: ['route'], geometry: { location: { lat: 31.41, lng: 73.11 }, location_type: 'GEOMETRIC_CENTER' } }] });
      }
      if (url.includes('computeRouteMatrix')) {
        assert.match(opts.headers['X-Goog-FieldMask'], /duration/);
        const body = JSON.parse(opts.body);
        assert.equal(body.travelMode, 'TWO_WHEELER');
        return jsonRes(body.destinations.map((_, i) => ({ originIndex: 0, ...(i ? { destinationIndex: i } : {}), duration: `${100 + i}s`, distanceMeters: 1000 + i, condition: 'ROUTE_EXISTS' })));
      }
      throw new Error('unexpected ' + url);
    });
    try {
      const r = await get('/api/geocode?q=susan%20road&lang=ur&submit=1');
      const g = r.body.results.find((x) => x.source === 'google');
      assert.equal(g.kind, 'address');
      assert.equal(g.precision, 'street');
      const u = new URL(extCalls[0].url);
      assert.equal(u.searchParams.get('region'), 'pk');
      assert.equal(u.searchParams.get('language'), 'ur');
      assert.equal(u.searchParams.get('bounds'), '30.75,72.6|31.85,73.65');
      assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM geocode_cache WHERE provider = 'google'").get().n, 0);
      const cfg = (await get('/api/config')).body;
      assert.equal(cfg.map.provider, 'google');
      assert.equal(cfg.geocoder.provider, 'google');
      assert.equal(cfg.routing.provider, 'google');
      assert.equal(cfg.routing.modes.two_wheeler, true);
      assert.ok('googleBrowserKey' in cfg.map, 'browser key is sent when the MAP provider is google');
      assert.ok(!JSON.stringify(cfg).includes('server-key'), 'server key never sent');
      const sr = await search('&mode=two_wheeler');
      assert.equal(sr.body.distance.method, 'route');
      assert.equal(sr.body.exact[0].durationS, 100);
    } finally { restore(); }
  });

  await t.test('config: stats from the DB, latest committed import', async () => {
    s.db.prepare("INSERT INTO import_batches (source_filename, file_sha256, status, created_at, committed_at) VALUES ('old.xlsx', 'x', 'committed', ?, '2026-01-01T00:00:00.000Z')").run(now);
    s.db.prepare("INSERT INTO import_batches (source_filename, file_sha256, status, created_at, committed_at) VALUES ('Filter.xlsx', 'y', 'committed', ?, '2026-02-01T00:00:00.000Z')").run(now);
    s.db.prepare("INSERT INTO import_batches (source_filename, file_sha256, status, created_at) VALUES ('draft.xlsx', 'z', 'previewed', ?)").run(now);
    const { body } = await get('/api/config');
    const total = s.db.prepare('SELECT COUNT(*) AS n FROM plants WHERE is_demo = 0').get().n;
    assert.equal(body.stats.plantsTotal, total);
    assert.equal(body.stats.plantsExact, 7);
    assert.equal(body.stats.plantsArea, 3);
    assert.equal(body.stats.plantsNoLocation, total - 10);
    assert.equal(body.stats.sourceFile, 'Filter.xlsx');
    assert.equal(body.stats.lastImportAt, '2026-02-01T00:00:00.000Z');
    assert.deepEqual(body.routing, { provider: 'none', modes: { driving: false, walking: false, cycling: false } });
    assert.deepEqual(body.geocoder, { provider: 'none' });
    assert.equal(body.demoMode, false);
    assert.equal(body.reportCategories.length, 8);
    assert.deepEqual(body.limits, { maxPhotos: 3, maxPhotoMb: 5, descriptionMin: 10, descriptionMax: 2000 });
  });

  // ── Admin ──
  const admin = await s.login('admin');
  const editor = await s.login('editor');
  const moderator = await s.login('moderator');
  const send = async (client, method, p, json) => { const r = await client.fetch(p, { method, json }); return { status: r.status, body: await r.json() }; };

  await t.test('admin permission matrix', async () => {
    assert.equal((await s.fetch('/api/admin/plants')).status, 401);
    assert.equal((await moderator.fetch('/api/admin/plants')).status, 200);
    assert.equal((await moderator.fetch('/api/admin/plants/CORE-E001')).status, 200);
    assert.equal((await send(moderator, 'PATCH', '/api/admin/plants/CORE-E001', { name: 'X', reason: 'moderator tries' })).status, 403);
    const ok = await send(editor, 'PATCH', '/api/admin/plants/CORE-E001', { name: 'Plant near Clock Tower', landmark: 'Clock Tower', reason: 'Confirmed on site visit' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.changed.sort(), ['landmark', 'name']);
    assert.equal(ok.body.plant.name, 'Plant near Clock Tower');
    assert.equal((await send(moderator, 'POST', '/api/admin/plants/CORE-E001/coordinates', { lat: 31.42, lng: 73.08, note: 'pin' })).status, 403);
    assert.equal((await moderator.fetch('/api/admin/plants/CORE-E001/tests', { method: 'POST', json: { sampleDate: '2026-01-01', laboratory: 'L', reason: 'x' } })).status, 403);
    assert.equal((await send(moderator, 'PATCH', `/api/admin/areas/${A1}`, { radiusM: 900, reason: 'test' })).status, 403);
    assert.equal((await send(editor, 'POST', '/api/admin/users', { username: 'someone', role: 'editor', password: 'long-enough-password' })).status, 403);
    assert.equal((await editor.fetch('/api/admin/users')).status, 403);
    assert.equal((await send(editor, 'POST', '/api/admin/maintenance/retention', {})).status, 403);
    assert.equal((await moderator.fetch('/api/admin/export/plants.csv')).status, 403);
    assert.equal((await editor.fetch('/api/admin/audit')).status, 200);
    assert.equal((await moderator.fetch('/api/admin/stats')).status, 200);
    const m = await send(admin, 'POST', '/api/admin/maintenance/retention', {});
    assert.equal(m.status, 200);
    assert.ok('result' in m.body);
    // CSRF enforced
    assert.equal((await s.fetch('/api/admin/plants/CORE-E001', { method: 'PATCH', json: { name: 'x', reason: 'no csrf' }, headers: { Cookie: editor.cookie } })).status, 403);
  });

  await t.test('PATCH rules: reason required, source traceability untouchable, stages recomputed, hours validated', async () => {
    const noReason = await send(editor, 'PATCH', '/api/admin/plants/CORE-E002', { name: 'X' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.details.field, 'reason');
    for (const field of ['source_values_json', 'source_file', 'sourceRow', 'plant_code', 'latitude', 'status', 'is_demo']) {
      const r = await send(editor, 'PATCH', '/api/admin/plants/CORE-E002', { [field]: 'x', reason: 'attempt' });
      assert.equal(r.status, 400, field);
      assert.equal(r.body.error.code, 'field_not_editable', field);
    }
    const tech = await send(editor, 'PATCH', '/api/admin/plants/CORE-E002', { technologyRaw: 'Activated Carbon + UV', reason: 'Corrected per operator letter' });
    assert.equal(tech.status, 200);
    assert.equal(tech.body.plant.treatment_stages_json, '["activated_carbon","uv"]');
    const odd = await send(editor, 'PATCH', '/api/admin/plants/CORE-E002', { technology_raw: 'Magic filter', reason: 'Recorded as stated' });
    assert.equal(odd.body.plant.treatment_stages_json, '[]');
    assert.equal(odd.body.warnings.length, 1);
    const badHours = await send(editor, 'PATCH', '/api/admin/plants/CORE-E002', { opening_hours_json: { mon: [['8am', '5pm']] }, reason: 'hours' });
    assert.equal(badHours.status, 400);
    const hours = await send(editor, 'PATCH', '/api/admin/plants/CORE-E002', { openingHours: { mon: [['08:00', '20:00']], sun: [] }, openingHoursText: 'Mon 8–8', reason: 'Posted on the plant door' });
    assert.equal(hours.status, 200);
    assert.deepEqual(JSON.parse(hours.body.plant.opening_hours_json), { mon: [['08:00', '20:00']], sun: [] });
    const row = s.db.prepare('SELECT source_values_json, source_file FROM plants WHERE plant_code = ?').get('CORE-E001');
    assert.equal(row.source_values_json, '{"Plant ID":"CORE-E001"}');
  });

  await t.test('audit log records actor and diff', async () => {
    const { body } = await get('/api/admin/audit?entityType=plant&entityId=CORE-E001&action=plant.update', moderator);
    assert.equal(body.total, 1);
    const e = body.items[0];
    assert.equal(e.actor.label, 'test-editor');
    assert.ok(e.actor.id > 0);
    assert.deepEqual(e.before, { name: null, landmark: null });
    assert.deepEqual(e.after, { name: 'Plant near Clock Tower', landmark: 'Clock Tower' });
    assert.equal(e.reason, 'Confirmed on site visit');
    const prefix = await get('/api/admin/audit?action=plant.&actor=test-editor', moderator);
    assert.ok(prefix.body.items.length >= 4 && prefix.body.items.every((i) => i.action.startsWith('plant.')));
  });

  await t.test('status change requires an assessment and writes history; verified sets verification fields', async () => {
    const short = await send(moderator, 'POST', '/api/admin/plants/CORE-E002/status', { status: 'temporarily_closed', assessment: 'too short' });
    assert.equal(short.status, 400);
    assert.equal(short.body.error.details.field, 'assessment');
    const missing = await send(moderator, 'POST', '/api/admin/plants/CORE-E002/status', { status: 'temporarily_closed' });
    assert.equal(missing.status, 400);

    // evidence reports must belong to this plant
    const rep = (plantId) => Number(s.db.prepare(`INSERT INTO reports (reference, plant_id, category, description, observed_at, consent_contact, created_at, updated_at)
                                            VALUES (?, ?, 'no_water', 'desc', '2026-01-01T10:00', 1, ?, ?)`).run(`TW-${Math.random().toString(36).slice(2, 10)}`, plantId, now, now).lastInsertRowid);
    const otherPlantReport = rep(E3.id);
    const ownReport = rep(E2.id);
    const assessment = 'Visited on site: the pump motor has failed and no water is dispensed.';
    const wrong = await send(moderator, 'POST', '/api/admin/plants/CORE-E002/status', { status: 'temporarily_closed', assessment, evidenceReportIds: [otherPlantReport] });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.details.field, 'evidenceReportIds');

    const ok = await send(moderator, 'POST', '/api/admin/plants/CORE-E002/status', { status: 'temporarily_closed', assessment, evidenceReportIds: [ownReport] });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.plant.status, 'temporarily_closed');
    assert.equal(ok.body.plant.status_source, 'admin');
    assert.ok(ok.body.plant.status_updated_at);
    const h = s.db.prepare('SELECT * FROM plant_status_history WHERE plant_id = ? ORDER BY id DESC').get(E2.id);
    assert.equal(h.old_status, 'operational');
    assert.equal(h.new_status, 'temporarily_closed');
    assert.equal(h.assessment, assessment);
    assert.equal(h.evidence_report_ids_json, JSON.stringify([ownReport]));
    assert.equal(ok.body.statusHistory[0].assessment, assessment);

    const ver = await send(editor, 'POST', '/api/admin/plants/CORE-E002/status', { status: 'operational', assessment: 'Repaired; operator confirmed and staff checked the dispensing taps.', verified: true });
    assert.equal(ver.status, 200);
    assert.equal(ver.body.plant.status_source, 'admin_verified');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ver.body.plant.last_verified_at));
    assert.ok(ver.body.plant.last_verified_by > 0);
    const pub = await get('/api/plants/CORE-E002');
    assert.equal(pub.body.status.verified, true);
    const rec = await search('&sort=recommended');
    assert.ok(rec.body.exact.find((p) => p.code === 'CORE-E002').recommendation.reasons.includes('status_verified_operational'));
    s.db.prepare('DELETE FROM reports').run();
  });

  await t.test('coordinates: admin pin sets verified (exact); out of bounds rejected; clear', async () => {
    const out = await send(editor, 'POST', '/api/admin/plants/CORE-N002/coordinates', { lat: 24.86, lng: 67.0, note: 'Karachi' });
    assert.equal(out.status, 400);
    assert.equal((await send(editor, 'POST', '/api/admin/plants/CORE-N002/coordinates', { lat: 31.42, lng: 73.08 })).status, 400, 'note/reason required');
    const r = await send(editor, 'POST', '/api/admin/plants/CORE-N002/coordinates', { lat: 31.4185, lng: 73.0795, note: 'Pinned from site visit photo' });
    assert.equal(r.status, 200);
    assert.equal(r.body.plant.coord_status, 'verified');
    assert.equal(r.body.plant.coord_source, 'admin map pin');
    assert.equal(r.body.summary.location.precision, 'exact');
    const sr = await search();
    assert.equal(sr.body.exact[0].code, 'CORE-N002');
    assert.equal(sr.body.exact[0].location.coordStatus, 'verified');
    assert.equal(sr.body.excluded.noLocation, EXCLUDED_NO_LOCATION - 1);
    assert.deepEqual((await get('/api/route?from=31.418,73.079&to=CORE-N002')).body, { available: false, reason: 'disabled' });
    const cleared = await send(editor, 'POST', '/api/admin/plants/CORE-N002/coordinates', { clear: true, reason: 'Pin was wrong' });
    assert.equal(cleared.body.plant.coord_status, 'missing');
    assert.equal(cleared.body.plant.latitude, null);
  });

  await t.test('water tests: validation rules, magic-byte uploads, public file serving', async () => {
    const base = { sampleDate: '2026-05-01', laboratory: 'PCRWR Faisalabad', reason: 'Lab report received' };
    const noStd = await send(editor, 'POST', '/api/admin/plants/CORE-E001/tests', { ...base, outcome: 'met_limits', results: [{ parameter: 'pH', valueText: '7.2', withinLimit: true }] });
    assert.equal(noStd.status, 400);
    assert.equal(noStd.body.error.details.field, 'standardName');
    const notAll = await send(editor, 'POST', '/api/admin/plants/CORE-E001/tests', { ...base, standardName: 'PSQCA', outcome: 'met_limits', results: [{ parameter: 'pH', valueText: '7.2', withinLimit: true }, { parameter: 'TDS', valueText: '400' }] });
    assert.equal(notAll.status, 400);
    assert.equal(notAll.body.error.details.field, 'results');
    const empty = await send(editor, 'POST', '/api/admin/plants/CORE-E001/tests', { ...base, standardName: 'PSQCA', outcome: 'met_limits', results: [] });
    assert.equal(empty.status, 400);
    const issueNoStd = await send(editor, 'POST', '/api/admin/plants/CORE-E001/tests', { ...base, outcome: 'issue_detected' });
    assert.equal(issueNoStd.status, 400);
    const future = await send(editor, 'POST', '/api/admin/plants/CORE-E001/tests', { ...base, sampleDate: '2999-01-01' });
    assert.equal(future.status, 400);
    const badResult = await send(editor, 'POST', '/api/admin/plants/CORE-E001/tests', { ...base, results: [{ parameter: 'pH' }] });
    assert.equal(badResult.status, 400);
    assert.equal(badResult.body.error.details.field, 'results[0].valueText');

    // multipart with a real PNG signature
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...base, standardName: 'PSQCA', standardVersion: '2010', outcome: 'met_limits' })) fd.append(k, v);
    fd.append('results', JSON.stringify([{ parameter: 'pH', valueText: '7.2', valueNum: 7.2, limitText: '6.5–8.5', withinLimit: true }]));
    fd.append('report', new Blob([PNG], { type: 'application/pdf' }), 'lab report.pdf'); // claimed type is ignored
    const created = await editor.fetch('/api/admin/plants/CORE-E001/tests', { method: 'POST', body: fd });
    assert.equal(created.status, 201);
    const test1 = (await created.json()).test;
    assert.equal(test1.outcome, 'met_limits');
    assert.match(test1.reportUrl, /^\/api\/files\/\d+$/);
    const file = await s.fetch(test1.reportUrl);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
    const f = s.db.prepare('SELECT * FROM files WHERE id = ?').get(test1.reportFileId);
    assert.equal(f.kind, 'test_report');
    assert.match(f.storage_path, /^tests\/[A-Za-z0-9_-]+\.png$/);

    const pub = await get('/api/plants/CORE-E001');
    assert.equal(pub.body.waterQuality.state, 'met_limits');
    assert.equal(pub.body.waterTests[0].standard.name, 'PSQCA');
    assert.equal(pub.body.waterTests[0].results[0].withinLimit, true);
    assert.ok(!pub.body.missingFields.includes('waterTests'));

    // bad magic bytes
    const fd2 = new FormData();
    for (const [k, v] of Object.entries(base)) fd2.append(k, v);
    fd2.append('report', new Blob([Buffer.from('not really a pdf')], { type: 'application/pdf' }), 'x.pdf');
    const rejected = await editor.fetch('/api/admin/plants/CORE-E001/tests', { method: 'POST', body: fd2 });
    assert.equal(rejected.status, 400);

    // unpublished test files are not public
    const fd3 = new FormData();
    for (const [k, v] of Object.entries({ ...base, published: 'false' })) fd3.append(k, v);
    fd3.append('report', new Blob([Buffer.from('%PDF-1.4\n%%EOF')]), 'r.pdf');
    const hiddenRes = await editor.fetch('/api/admin/plants/CORE-E001/tests', { method: 'POST', body: fd3 });
    assert.equal(hiddenRes.status, 201);
    const hidden = (await hiddenRes.json()).test;
    assert.equal(hidden.published, false);
    assert.equal((await s.fetch(`/api/files/${hidden.reportFileId}`)).status, 404);
    assert.equal((await get('/api/plants/CORE-E001')).body.waterTests.length, 1);

    // delete requires a reason
    assert.equal((await send(editor, 'DELETE', `/api/admin/tests/${hidden.id}`, {})).status, 400);
    const del = await send(editor, 'DELETE', `/api/admin/tests/${hidden.id}`, { reason: 'Uploaded twice' });
    assert.equal(del.status, 200);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get(hidden.reportFileId).n, 0);
  });

  await t.test('sources, verify, create plant, areas', async () => {
    const src = await send(editor, 'POST', '/api/admin/plants/CORE-E001/sources', { title: 'WASA list 2025', url: 'javascript:alert(1)', reason: 'x-ref' });
    assert.equal(src.status, 400);
    assert.equal((await send(editor, 'POST', '/api/admin/plants/CORE-E001/sources', { title: 'WASA list 2025', url: 'https://example.org/list.pdf', note: 'Cross-referenced' })).status, 201);
    assert.deepEqual((await get('/api/plants/CORE-E001')).body.sources, [{ title: 'WASA list 2025', url: 'https://example.org/list.pdf' }]);

    assert.equal((await send(editor, 'POST', '/api/admin/plants/CORE-E001/verify', { verifiedAt: '2999-01-01', note: 'future' })).status, 400);
    const v = await send(editor, 'POST', '/api/admin/plants/CORE-E001/verify', { verifiedAt: '2026-09-01', note: 'Details checked on site' });
    assert.equal(v.body.plant.last_verified_at, '2026-09-01');

    assert.equal((await send(editor, 'POST', '/api/admin/plants', { code: 'DEMO-9999', reason: 'x' })).status, 400);
    assert.equal((await send(editor, 'POST', '/api/admin/plants', { code: 'CORE-E001', reason: 'dup' })).status, 409);
    const c = await send(editor, 'POST', '/api/admin/plants', { code: 'fsd-new-0001', town: 'Jinnah Town', areaRaw: 'Model Town - Sector 3', name: 'New plant', reason: 'Reported by WASA' });
    assert.equal(c.status, 201);
    assert.equal(c.body.plant.plant_code, 'FSD-NEW-0001');
    assert.equal(c.body.plant.area_id, A1);
    assert.equal(c.body.plant.status, 'unknown');
    assert.equal(c.body.summary.location.precision, 'area');

    const areas = await get('/api/admin/areas', editor);
    assert.ok(areas.body.items.some((a) => a.id === A2 && a.usable === false));
    const pa = await send(editor, 'PATCH', `/api/admin/areas/${A2}`, { latitude: 31.5, longitude: 73.2, aliases: ['Saline A'], reason: 'Located with WASA engineer' });
    assert.equal(pa.status, 200);
    assert.equal(pa.body.area.geocodeStatus, 'manual');
    assert.ok(pa.body.area.reviewedAt);
    assert.equal((await search()).body.excluded.noLocation, EXCLUDED_NO_LOCATION - 1, 'N001 now in the area group');
    await send(editor, 'PATCH', `/api/admin/areas/${A2}`, { latitude: null, longitude: null, reason: 'Revert' });
  });

  await t.test('users: create, password length, cannot deactivate or demote yourself, audited without password', async () => {
    assert.equal((await send(admin, 'POST', '/api/admin/users', { username: 'new-ed', role: 'editor', password: 'short' })).status, 400);
    const c = await send(admin, 'POST', '/api/admin/users', { username: 'new-ed', role: 'editor', password: 'a-long-enough-pass', displayName: 'New Editor' });
    assert.equal(c.status, 201);
    assert.equal(c.body.user.role, 'editor');
    assert.equal((await send(admin, 'POST', '/api/admin/users', { username: 'NEW-ED', role: 'editor', password: 'a-long-enough-pass' })).status, 409);
    const me = (await get('/api/admin/me', admin)).body.user;
    assert.equal((await send(admin, 'PATCH', `/api/admin/users/${me.id}`, { active: false })).status, 400);
    assert.equal((await send(admin, 'PATCH', `/api/admin/users/${me.id}`, { role: 'editor' })).status, 400);
    const d = await send(admin, 'PATCH', `/api/admin/users/${c.body.user.id}`, { role: 'moderator', active: false, password: 'another-long-password' });
    assert.equal(d.status, 200);
    assert.equal(d.body.user.active, false);
    const log = s.db.prepare("SELECT before_json, after_json FROM audit_log WHERE entity_type = 'admin_user' AND entity_id = ? ORDER BY id").all(String(c.body.user.id));
    const text = JSON.stringify(log);
    assert.ok(!text.includes('a-long-enough-pass') && !text.includes('another-long-password'));
    assert.ok(text.includes('passwordChanged'));
  });

  await t.test('exports: CSV injection safe, traceability columns', async () => {
    const r = await admin.fetch('/api/admin/export/plants.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const csv = await r.text();
    const header = csv.replace(/^﻿/, '').split('\r\n')[0];
    for (const col of ['plant_code', 'source_file', 'source_sheet', 'source_row', 'source_values_json', 'import_batch_id']) assert.ok(header.includes(`"${col}"`), col);
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
    assert.ok(!/(^|,)"=/.test(csv));
    const j = await get('/api/admin/export/plants.json', editor);
    assert.equal(j.status, 200);
    assert.equal(j.body.count, j.body.items.length);
    assert.ok(j.body.items.every((i) => i.is_demo === 0));
  });

  await t.test('incomplete list', async () => {
    const { body } = await get('/api/admin/incomplete?missing=noLocationAtAll', editor);
    assert.ok(body.counts.noExactLocation >= body.counts.noLocationAtAll);
    assert.ok(body.items.every((i) => i.missing.includes('noLocationAtAll')));
    assert.ok(body.items.some((i) => i.code === 'CORE-N002'));
  });

  await t.test('no endpoint leaks reporter phone data', async () => {
    const rid = s.db.prepare(`INSERT INTO reporters (phone_hash, phone_enc, phone_last4, public_alias, created_at) VALUES ('HASHLEAK123', 'v1:LEAKCHECK:x:y', '4567', 'Community member 1', ?)`).run(now).lastInsertRowid;
    const rep = s.db.prepare(`INSERT INTO reports (reference, plant_id, reporter_id, category, description, observed_at, consent_contact, status, created_at, updated_at)
                              VALUES ('TW-LEAK-0001', ?, ?, 'no_water', 'SECRETDESCRIPTION call me', '2026-01-01T10:00', 1, 'confirmed', ?, ?)`).run(E1.id, rid, now, now).lastInsertRowid;
    s.db.prepare(`INSERT INTO report_events (report_id, action, to_status, reason, public_note, created_at) VALUES (?, 'status_change', 'confirmed', 'INTERNALREASON', 'Staff confirmed the tap is dry.', ?)`).run(rep, now);
    s.db.prepare("INSERT INTO ratings (plant_id, reporter_id, stars, status, created_at) VALUES (?, ?, 4, 'accepted', ?)").run(E1.id, rid, now);
    // a careless audit payload must still be scrubbed on the way out
    s.db.prepare(`INSERT INTO audit_log (actor_label, action, entity_type, entity_id, after_json, created_at) VALUES ('system', 'plant.note', 'plant', 'CORE-E001', ?, ?)`)
      .run(JSON.stringify({ phone_enc: 'v1:LEAKCHECK:x:y', nested: { phone: '+923001234567' } }), now);

    const detail = await get('/api/plants/CORE-E001');
    assert.deepEqual(detail.body.reportsSummary.confirmedOpenIssues, [{ category: 'no_water', confirmedAt: now, publicNote: 'Staff confirmed the tap is dry.' }]);
    const bodies = [
      JSON.stringify(detail.body),
      await (await s.fetch(`/api/search?lat=${O.lat}&lng=${O.lng}&sort=recommended`)).text(),
      await (await s.fetch('/api/plants?q=CORE')).text(),
      await (await s.fetch('/api/config')).text(),
      await (await admin.fetch('/api/admin/plants/CORE-E001')).text(),
      await (await admin.fetch('/api/admin/plants?q=CORE')).text(),
      await (await admin.fetch('/api/admin/audit?pageSize=200')).text(),
      await (await admin.fetch('/api/admin/export/plants.csv')).text(),
      await (await admin.fetch('/api/admin/export/plants.json')).text(),
      await (await admin.fetch('/api/admin/stats')).text(),
      await (await admin.fetch('/api/admin/incomplete')).text(),
    ];
    for (const b of bodies) {
      for (const secret of ['phone_enc', 'LEAKCHECK', 'HASHLEAK123', '+923001234567', 'SECRETDESCRIPTION', 'INTERNALREASON', 'phone_hash', 'reporter_id']) {
        assert.ok(!b.includes(secret), `leaked ${secret}: ${b.slice(b.indexOf(secret) - 80, b.indexOf(secret) + 40)}`);
      }
    }
    s.db.prepare('DELETE FROM report_events').run();
    s.db.prepare('DELETE FROM reports').run();
  });

  await t.test('reportsSummary: review-queue (flagged / honeypot) reports are not counted publicly', async () => {
    const ins = s.db.prepare(`INSERT INTO reports (reference, plant_id, category, description, observed_at, consent_contact, status, review_queue, created_at, updated_at)
                              VALUES (?, ?, 'no_water', 'd', '2026-01-01T10:00', 1, ?, ?, ?, ?)`);
    ins.run('TW-RQ00-0001', E3.id, 'pending', 0, now, now);
    ins.run('TW-RQ00-0002', E3.id, 'pending', 1, now, now);
    ins.run('TW-RQ00-0003', E3.id, 'under_review', 0, now, now);
    ins.run('TW-RQ00-0004', E3.id, 'resolved', 0, now, now);
    const { body } = await get('/api/plants/CORE-E003');
    assert.equal(body.reportsSummary.unverifiedOpen, 1);
    assert.equal(body.reportsSummary.underReview, 1);
    assert.equal(body.reportsSummary.resolvedLast90d, 1);
    s.db.prepare('DELETE FROM reports').run();
  });

  await t.test('demo data: isolated, labelled, removable', async () => {
    const demo = require('../server/lib/demo');
    const on = demo.syncDemoData(true);
    assert.deepEqual(on, { enabled: true, upserted: 8, removed: 0, waterTests: 1 });
    assert.deepEqual(demo.syncDemoData(true), { enabled: true, upserted: 8, removed: 0, waterTests: 1 }, 'idempotent');

    // DEMO_DATA off → invisible everywhere public
    config.demoData = false;
    let sr = await search('&limit=50');
    assert.ok(![...sr.body.exact, ...sr.body.area].some((p) => p.code.startsWith('DEMO-')));
    assert.equal((await get('/api/plants/DEMO-0001')).status, 404);
    assert.ok(!(await get('/api/plants?q=DEMO')).body.items.length);

    config.demoData = true;
    try {
      sr = await search('&limit=50');
      const demoCodes = codes(sr.body.exact).filter((c) => c.startsWith('DEMO-'));
      assert.ok(demoCodes.includes('DEMO-0001') && demoCodes.includes('DEMO-0002'));
      assert.ok(!demoCodes.includes('DEMO-0003'), 'permanently closed demo plant excluded');
      assert.ok(sr.body.excluded.closedPermanently >= 3);
      const d1 = sr.body.exact.find((p) => p.code === 'DEMO-0001');
      assert.equal(d1.isDemo, true);
      assert.match(d1.name, /^DEMO — .*\(not a real plant\)$/);
      assert.equal(d1.location.coordStatus, 'verified');
      assert.equal(sr.body.exact.find((p) => p.code === 'DEMO-0002').status.code, 'temporarily_closed');
      const d4 = await get('/api/plants/DEMO-0004');
      assert.ok(d4.body.openingHours.structured && typeof d4.body.openingHours.openNow === 'boolean');
      const d5 = await get('/api/plants/DEMO-0005');
      assert.equal(d5.body.waterTests[0].laboratory, 'DEMO LAB (fictional)');
      assert.equal(d5.body.waterTests[0].standard.name, 'DEMO standard (fictional)');
      assert.equal(d5.body.waterQuality.state, 'met_limits');
      assert.equal(d5.body.capacity.litresPerHour, 3785);
      assert.equal((await get('/api/plants/DEMO-0006')).body.waterQuality.state, 'unknown');
      assert.equal((await get('/api/config')).body.demoMode, true);
      for (const p of s.db.prepare('SELECT latitude, longitude FROM plants WHERE is_demo = 1').all()) {
        assert.ok(require('../server/lib/geo').inBounds(p.latitude, p.longitude));
      }
    } finally { config.demoData = false; }

    const off = demo.syncDemoData(false);
    assert.deepEqual(off, { enabled: false, upserted: 0, removed: 8, waterTests: 0 });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM plants WHERE is_demo = 1').get().n, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM water_tests WHERE laboratory = 'DEMO LAB (fictional)'").get().n, 0);
    assert.ok(s.db.prepare("SELECT COUNT(*) AS n FROM plants WHERE plant_code LIKE 'CORE-%'").get().n > 10, 'real plants untouched');
  });

  await t.test('rate limiting on geocode (hashed IP subject, 60/min)', async () => {
    clearRate();
    let last;
    for (let i = 0; i < 61; i++) last = await s.fetch('/api/geocode?q=model&submit=1');
    assert.equal(last.status, 429);
    const body = await last.json();
    assert.ok(body.error.details.retryAfterSec > 0);
    const subjects = s.db.prepare("SELECT DISTINCT subject FROM rate_events WHERE bucket = 'public:geo'").all();
    assert.equal(subjects.length, 1);
    assert.ok(!subjects[0].subject.includes('127.0.0.1'));
    clearRate();
  });
});
