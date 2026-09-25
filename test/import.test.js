'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { startTestServer } = require('./helpers');

const REAL_FILE = path.join(__dirname, '..', 'data', 'source', 'Filter_palnts_in_Faisalabad_1000_1.xlsx');

async function xlsxBuffer(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function parseCsv(text) {
  const { parseCsvText } = require('../server/import/parse');
  return parseCsvText(text).map((r) => r.cells.map((c) => c ?? ''));
}

test('import: unit rules', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const { suggestMapping } = require('../server/import/fields');
  const n = require('../server/import/normalize');
  const { validateMapping } = require('../server/import/pipeline');

  await t.test('auto-mapping by header synonyms (case and punctuation insensitive)', () => {
    const real = ['Plant ID', 'Town/Tehsil', 'Area/Union Council', 'Operating Entity Type', 'Water Source', 'Filtration Technology', 'Capacity (Gallons Per Hour)', 'Operational Status'];
    const m = suggestMapping(real);
    assert.deepEqual(
      [m.plant_code, m.town, m.area_raw, m.operator_type, m.water_source, m.technology_raw, m.capacity, m.status_raw],
      real,
    );
    assert.equal(m.collection_limit, null, 'capacity column is never suggested as a collection limit');
    const alt = suggestMapping(['PLANT-ID', 'Plant Name', 'lat', 'LNG', 'Y', 'Street Address', 'TDS (mg/L)', 'pH', 'Sample Date', 'Laboratory', 'Timings', 'Per Person Limit']);
    assert.equal(alt.plant_code, 'PLANT-ID');
    assert.equal(alt.name, 'Plant Name');
    assert.equal(alt.latitude, 'lat', 'first matching header wins');
    assert.equal(alt.longitude, 'LNG');
    assert.equal(alt.address, 'Street Address');
    assert.equal(alt['param:TDS'], 'TDS (mg/L)');
    assert.equal(alt['param:pH'], 'pH');
    assert.equal(alt.water_test_date, 'Sample Date');
    assert.equal(alt.water_test_lab, 'Laboratory');
    assert.equal(alt.opening_hours_text, 'Timings');
    assert.equal(alt.collection_limit, 'Per Person Limit');
    assert.equal(suggestMapping(['Longitude', 'x']).longitude, 'Longitude');
  });

  await t.test('capacity parsing: units, header fallback, conflicts, plausibility', () => {
    const H = 'Capacity (Gallons Per Hour)';
    const c1 = n.parseCapacity('5000 GPH', H);
    assert.deepEqual([c1.raw, c1.value, c1.unit, c1.unitLabel, c1.gallonType], ['5000 GPH', 5000, 'gallons_per_hour', 'GPH', 'unspecified']);
    assert.deepEqual(c1.issues, ['capacity_gallon_type_unspecified']);
    assert.equal(c1.basis, "As recorded in source column 'Capacity (Gallons Per Hour)'; whether this is rated or measured output is not stated.");
    assert.deepEqual([n.parseCapacity('5,000 gph', 'Capacity').value, n.parseCapacity('5,000 gph', 'Capacity').unit], [5000, 'gallons_per_hour']);
    const l = n.parseCapacity('1000 L/hr', 'Capacity');
    assert.deepEqual([l.value, l.unit, l.unitLabel, l.gallonType, l.issues.length], [1000, 'litres_per_hour', 'L/hr', 'not_applicable', 0]);
    assert.equal(n.parseCapacity('1,000 LPH', 'Capacity').unit, 'litres_per_hour');
    assert.equal(n.parseCapacity('10000 GPD', 'Capacity').unit, 'gallons_per_day');
    assert.equal(n.parseCapacity('5000 litres per day', 'Capacity').unit, 'litres_per_day');
    // header fallback (numeric and text cells without a unit)
    const h = n.parseCapacity(5000, H);
    assert.deepEqual([h.value, h.unit, h.unitLabel, h.raw], [5000, 'gallons_per_hour', 'Gallons Per Hour', '5000']);
    const us = n.parseCapacity('5000', 'Capacity (US gal/hr)');
    assert.deepEqual([us.unit, us.gallonType, us.issues.includes('capacity_gallon_type_unspecified')], ['gallons_per_hour', 'us', false]);
    assert.equal(n.parseCapacity('5000 imperial gallons per hour', 'Capacity').gallonType, 'imperial');
    assert.equal(n.parseCapacity('5000 UK gal/day', 'Capacity').gallonType, 'imperial');
    // conflict between the cell and the header: warn, keep the cell's unit, never change the number
    const cf = n.parseCapacity('1000 L/hr', H);
    assert.deepEqual([cf.value, cf.unit], [1000, 'litres_per_hour']);
    assert.ok(cf.warnings.some((w) => w.code === 'capacity_unit_conflict'));
    // no unit anywhere
    assert.ok(n.parseCapacity('5000', 'Capacity').warnings.some((w) => w.code === 'capacity_unit_missing'));
    // non-numeric: raw kept, value null
    const nn = n.parseCapacity('about five thousand', H);
    assert.deepEqual([nn.raw, nn.value], ['about five thousand', null]);
    assert.ok(nn.warnings.some((w) => w.code === 'capacity_not_numeric'));
    assert.equal(n.parseCapacity('1000-2000 GPH', H).value, null, 'ranges are not collapsed to a number');
    // plausibility
    const hi = n.parseCapacity('25000 GPH', H);
    assert.equal(hi.value, 25000);
    assert.ok(hi.issues.includes('capacity_unusually_high'));
    assert.ok(hi.warnings.some((w) => w.code === 'capacity_unusually_high'));
    assert.ok(!n.parseCapacity('20000 GPH', H).issues.includes('capacity_unusually_high'));
    assert.ok(n.parseCapacity('600000 GPD', 'Capacity').issues.includes('capacity_unusually_high'));
    assert.ok(!n.parseCapacity('400000 GPD', 'Capacity').issues.includes('capacity_unusually_high'));
    assert.equal(n.parseCapacity('', H), null);
  });

  await t.test('capacity is never used as a collection limit', () => {
    const values = { 'Plant ID': 'X-1', 'Capacity (Gallons Per Hour)': '5000 GPH' };
    const e = n.normalizeRow(values, suggestMapping(Object.keys(values)), { sourceFile: 'f.xlsx', sheet: 'S', rowNumber: 2 });
    assert.equal(e.plant.capacity_value, 5000);
    for (const col of ['collection_limit_raw', 'collection_limit_value', 'collection_limit_unit', 'collection_limit_period']) assert.equal(e.plant[col], undefined);
    assert.ok(e.missingFields.includes('collectionLimit'));
    assert.ok(!e.provided.includes('collection_limit'));

    const v2 = { 'Plant ID': 'X-2', 'Capacity (Gallons Per Hour)': '5000 GPH', 'Per Person Limit': '20 litres per visit' };
    const e2 = n.normalizeRow(v2, suggestMapping(Object.keys(v2)), { sourceFile: 'f.xlsx', sheet: 'S', rowNumber: 3 });
    assert.deepEqual([e2.plant.collection_limit_value, e2.plant.collection_limit_unit, e2.plant.collection_limit_period, e2.plant.collection_limit_raw], [20, 'litres', 'per_visit', '20 litres per visit']);
    assert.equal(e2.plant.capacity_value, 5000);
    const lim = n.parseCollectionLimit('5 gallons', 'Collection limit (per day)');
    assert.deepEqual([lim.value, lim.unit, lim.period], [5, 'gallons', 'per_day']);

    assert.throws(
      () => validateMapping({ plant_code: 'Plant ID', capacity: 'Capacity (Gallons Per Hour)', collection_limit: 'Capacity (Gallons Per Hour)' }, ['Plant ID', 'Capacity (Gallons Per Hour)']),
      (err) => err.status === 400 && err.code === 'mapping_invalid',
    );
    assert.throws(() => validateMapping({ capacity: 'Capacity' }, ['Capacity']), (err) => err.status === 400 && /Plant ID/.test(err.message));
    assert.throws(() => validateMapping({ plant_code: 'Nope' }, ['Plant ID']), (err) => err.status === 400);
  });

  await t.test('status mapping is conservative', () => {
    const cases = {
      'Fully Functional': 'operational', Functional: 'operational', Operational: 'operational', Working: 'operational', open: 'operational',
      'Temporarily Closed': 'temporarily_closed', 'Under Maintenance': 'temporarily_closed', 'under repair': 'temporarily_closed',
      'Permanently Closed': 'permanently_closed', 'Closed Permanently': 'permanently_closed',
      Decommissioned: 'decommissioned', Abandoned: 'decommissioned',
      'Non-Functional': 'unknown', 'Partially functional': 'unknown', Closed: 'unknown', '?': 'unknown',
    };
    for (const [raw, expected] of Object.entries(cases)) assert.equal(n.mapStatus(raw).status, expected, raw);
    const e = n.normalizeRow({ 'Plant ID': 'S-1', Status: 'Non-Functional' }, { plant_code: 'Plant ID', status_raw: 'Status' }, { sourceFile: 'f', sheet: 's', rowNumber: 2 });
    assert.deepEqual([e.plant.status, e.plant.status_raw, e.plant.status_source, e.plant.status_updated_at], ['unknown', 'Non-Functional', 'spreadsheet', null]);
    assert.ok(e.issues.includes('unrecognised_status'));
    assert.ok(e.issues.includes('status_undated'));
    assert.equal(e.needsReview, true);
    const dated = n.normalizeRow({ 'Plant ID': 'S-2', Status: 'Fully Functional', 'Status Date': '15/03/2026' },
      { plant_code: 'Plant ID', status_raw: 'Status', status_date: 'Status Date' }, { sourceFile: 'f', sheet: 's', rowNumber: 3, today: '2026-09-25' });
    assert.equal(dated.plant.status_updated_at, '2026-03-15');
    assert.ok(!dated.issues.includes('status_undated'));
  });

  await t.test('technology maps to treatment stages exactly as in the contract', () => {
    assert.deepEqual(n.mapTechnology('Reverse Osmosis (RO)').stages, ['reverse_osmosis']);
    assert.deepEqual(n.mapTechnology('Heavy-Duty Brackish RO Membrane (High TDS)').stages, ['reverse_osmosis']);
    assert.deepEqual(n.mapTechnology('Activated Carbon + UV').stages, ['activated_carbon', 'uv']);
    assert.deepEqual(n.mapTechnology('ultrafiltration (uf)').stages, ['ultrafiltration']);
    const u = n.mapTechnology('Carbon Block + Chlorination');
    assert.deepEqual([u.stages, u.recognised], [[], false]);
    const e = n.normalizeRow({ 'Plant ID': 'T-1', Tech: 'Magic Filter' }, { plant_code: 'Plant ID', technology_raw: 'Tech' }, { sourceFile: 'f', sheet: 's', rowNumber: 2 });
    assert.equal(e.plant.treatment_stages_json, '[]');
    assert.ok(e.warnings.some((w) => w.code === 'unrecognised_technology'));
  });

  await t.test('area and operator issues are data-driven', () => {
    const map = { plant_code: 'id', town: 'town', area_raw: 'area', operator_type: 'op', technology_raw: 'tech' };
    const run = (area, op, tech) => n.normalizeRow({ id: 'A-1', town: 'Jinnah Town', area, op, tech }, map, { sourceFile: 'f', sheet: 's', rowNumber: 2 });
    const a = run('Chalk 224 RB - Sector 5', 'Government (PSPA)', 'Ultrafiltration (UF)');
    assert.equal(a.plant.area_name, 'Chalk 224 RB');
    assert.equal(a.plant.area_sector, 'Sector 5');
    assert.equal(a.areaKey, 'chalk-224-rb|jinnah-town');
    assert.ok(a.issues.includes('area_name_possible_typo'));
    assert.ok(a.issues.includes('sector_suffix_unverified'));
    assert.ok(a.issues.includes('operator_acronym_unexplained'));
    assert.ok(!a.issues.includes('operator_type_is_plant_type'));
    const b = run('Saline Zone-C - Sector 8', 'Saline Water Treatment RO', 'Heavy-Duty Brackish RO Membrane (High TDS)');
    assert.ok(b.issues.includes('area_not_geocodable'));
    assert.ok(b.issues.includes('operator_type_is_plant_type'));
    assert.ok(!b.issues.includes('operator_type_technology_mismatch'));
    const c = run('Kachi Abadi - Sector 1', 'Private Commercial RO', 'Activated Carbon + UV');
    assert.ok(c.issues.includes('area_not_geocodable'));
    assert.ok(c.issues.includes('operator_type_technology_mismatch'));
    assert.ok(!c.issues.includes('operator_type_is_plant_type'));
    const d = run('Model Town - Sector 9', 'Government (WASA)', 'Reverse Osmosis (RO)');
    assert.deepEqual(d.issues.sort(), ['no_coordinates', 'sector_suffix_unverified']);
    assert.equal(d.needsReview, false, 'dataset-wide issues alone do not require review');
    assert.ok(run('Factory Area - Sector 4', 'Industrial Water Plant', 'Reverse Osmosis (RO)').issues.includes('operator_type_is_plant_type'));
  });

  await t.test('coordinates: bounds, swapped, precision', () => {
    const map = { plant_code: 'id', latitude: 'lat', longitude: 'lng', name: 'name' };
    const run = (lat, lng) => n.normalizeRow({ id: 'C-1', lat, lng, name: 'X' }, map, { sourceFile: 'f', sheet: 's', rowNumber: 2 });
    const ok = run(31.41802, 73.07915);
    assert.deepEqual([ok.plant.latitude, ok.plant.longitude, ok.plant.coord_status, ok.plant.coord_source, ok.incomplete], [31.41802, 73.07915, 'source', 'spreadsheet', false]);
    const sw = run(73.07915, 31.41802);
    assert.equal(sw.plant.latitude, undefined);
    assert.ok(sw.issues.includes('coordinates_possibly_swapped'));
    assert.ok(sw.issues.includes('no_coordinates'));
    assert.equal(sw.incomplete, true);
    const oob = run(24.8607, 67.0011);
    assert.equal(oob.plant.latitude, undefined);
    assert.ok(oob.issues.includes('coordinates_out_of_bounds'));
    assert.ok(run('31.4', '73.1').warnings.some((w) => w.code === 'coordinates_low_precision'));
    assert.ok(run('31.4N', 'abc').warnings.some((w) => w.code === 'coordinates_invalid'));
    assert.ok(run(31.41802, null).warnings.some((w) => w.code === 'coordinates_incomplete'));
  });

  await t.test('water tests only with a date and a value; never assessed', () => {
    const map = { plant_code: 'id', water_test_date: 'Test Date', water_test_lab: 'Lab', 'param:TDS': 'TDS (mg/L)', 'param:E. coli': 'E. coli' };
    const e = n.normalizeRow({ id: 'W-1', 'Test Date': '2026-04-20', Lab: 'PCRWR', 'TDS (mg/L)': 450, 'E. coli': 'Absent' }, map, { sourceFile: 'f', sheet: 's', rowNumber: 2 });
    assert.equal(e.tests.length, 1);
    assert.deepEqual(e.tests[0].results, [
      { parameter: 'TDS', valueText: '450', valueNum: 450, unit: 'mg/L' },
      { parameter: 'E. coli', valueText: 'Absent', valueNum: null, unit: null },
    ]);
    const noDate = n.normalizeRow({ id: 'W-2', 'TDS (mg/L)': 450 }, map, { sourceFile: 'f', sheet: 's', rowNumber: 3 });
    assert.equal(noDate.tests.length, 0);
    assert.ok(noDate.warnings.some((w) => w.code === 'water_test_undated'));
    const noVal = n.normalizeRow({ id: 'W-3', 'Test Date': '2026-04-20' }, map, { sourceFile: 'f', sheet: 's', rowNumber: 4 });
    assert.equal(noVal.tests.length, 0);
  });
});

test('import: pipeline, duplicates, routes and the real file', async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const pipeline = require('../server/import/pipeline');
  const { resolveDuplicate } = require('../server/import/duplicates');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-import-fixtures-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const plant = (code) => s.db.prepare('SELECT * FROM plants WHERE plant_code = ?').get(code);

  const HEAD_A = ['Plant ID', 'Plant Name', 'Town/Tehsil', 'Area/Union Council', 'Latitude', 'Longitude', 'Operating Entity Type', 'Water Source',
    'Filtration Technology', 'Capacity (Gallons Per Hour)', 'Per Person Limit', 'Operational Status', 'Address', 'TDS (mg/L)', 'Test Date', 'Laboratory'];
  const ROWS_A = [
    ['TA-0001', 'Model Town Filter Plant', 'Jinnah Town', 'Model Town - Sector 9', 31.40512, 73.10234, 'Government (WASA)', 'Groundwater (Tube Well)', 'Reverse Osmosis (RO)', '5000 GPH', '20 litres per visit', 'Fully Functional', null, 450, '2026-04-20', 'PCRWR Lab'],
    [null, 'No code plant', 'Jinnah Town', 'Gulberg - Sector 1', null, null, 'Government (WASA)', null, 'Reverse Osmosis (RO)', '1000 GPH', null, 'Fully Functional', null, null, null, null],
    ['TA-0002', 'Swapped Plant', 'Iqbal Town', 'Novelty Bridge - Sector 2', 73.0791, 31.4180, 'NGO (Community Welfare)', 'Mixed Municipal Supply', 'Carbon Block', '2000 GPH', null, 'Non-Functional', null, null, null, null],
    ['TA-0001', 'Model Town Filter Plant (repeat)', 'Jinnah Town', 'Model Town - Sector 9', null, null, 'Government (WASA)', null, 'Reverse Osmosis (RO)', '5000 GPH', null, 'Fully Functional', null, null, null, null],
    ['TA-0003', 'Far Away Plant', 'Madina Town', 'Canal Road - Sector 4', 24.8607, 67.0011, 'Government (PSPA)', null, 'Ultrafiltration (UF)', '1000 L/hr', null, 'Under Repair', null, null, null, null],
    ['TA-0004', 'model town filter plant', 'Jinnah Town', 'Model Town - Sector 3', 31.40515, 73.10236, 'Government (WASA)', null, 'Reverse Osmosis (RO)', '25000 GPH', null, 'Fully Functional', null, null, null, null],
    ['TA-0005', 'Jail Road Plant', 'Jinnah Town', 'Jhang Road - Sector 1', null, null, 'NGO (Alkhidmat Foundation)', null, 'Activated Carbon + UV', '1000 GPH', null, 'Fully Functional', '12 Jail Road', null, null, null],
  ];

  let batchA;
  await t.test('upload -> preview -> commit with validation, geocoder stub and duplicates', async () => {
    const created = await pipeline.createBatch({ buffer: await xlsxBuffer([{ name: 'Plants', rows: [HEAD_A, ...ROWS_A] }]), filename: 'fixture-a.xlsx', userId: null });
    batchA = created.batchId;
    assert.equal(created.sheets[0].rowCount, 7);
    assert.equal(created.suggestedMapping.sheet, 'Plants');
    assert.equal(created.suggestedMapping.columns['param:TDS'], 'TDS (mg/L)');
    assert.ok(created.targetFields.some((f) => f.key === 'plant_code' && f.required));
    const file = s.db.prepare('SELECT f.* FROM files f JOIN import_batches b ON b.file_id = f.id WHERE b.id = ?').get(batchA);
    assert.equal(file.kind, 'import_upload');
    assert.match(file.storage_path, /^imports\//);

    const preview = await pipeline.previewBatch(batchA, {});
    assert.deepEqual(
      [preview.summary.total, preview.summary.new, preview.summary.rejected, preview.summary.duplicateReview, preview.summary.update],
      [7, 5, 1, 1, 0],
    );
    const byRow = Object.fromEntries(preview.rows.map((r) => [r.rowNumber, r]));
    assert.equal(byRow[3].outcome, 'rejected');
    assert.deepEqual(byRow[3].errors.map((e) => [e.field, e.code]), [['plant_code', 'required']]);
    assert.equal(byRow[5].outcome, 'duplicate_review');
    assert.equal(byRow[5].duplicateOfRow, 2);
    assert.ok(byRow[7].warnings.some((w) => w.code === 'possible_duplicate' && w.value === 'TA-0001'));

    const calls = [];
    const summary = await pipeline.commitBatch(batchA, {
      actorLabel: 'test',
      geocoder: async (address, opts) => { calls.push([address, opts]); return { lat: 31.4201, lng: 73.0822, precision: 'street', source: 'stub' }; },
    });
    assert.deepEqual([summary.new, summary.rejected, summary.duplicateReview, summary.geocoded, summary.likelyDuplicates], [5, 1, 1, 1, 1]);
    assert.deepEqual(calls, [['12 Jail Road', { town: 'Jinnah Town' }]]);

    const p1 = plant('TA-0001');
    assert.deepEqual([p1.latitude, p1.longitude, p1.coord_status, p1.coord_source], [31.40512, 73.10234, 'source', 'spreadsheet']);
    assert.deepEqual([p1.capacity_value, p1.capacity_unit, p1.collection_limit_value, p1.collection_limit_unit, p1.collection_limit_period], [5000, 'gallons_per_hour', 20, 'litres', 'per_visit']);
    assert.equal(p1.source_row, 2);
    assert.equal(p1.source_sheet, 'Plants');
    assert.equal(p1.source_file, 'fixture-a.xlsx');
    assert.equal(p1.incomplete, undefined);
    const area = s.db.prepare('SELECT * FROM areas WHERE id = ?').get(p1.area_id);
    assert.deepEqual([area.area_key, area.kind, area.name, area.town, area.geocode_status], ['model-town|jinnah-town', 'area', 'Model Town', 'Jinnah Town', 'not_attempted']);
    const test1 = s.db.prepare('SELECT * FROM water_tests WHERE plant_id = ?').get(p1.id);
    assert.deepEqual([test1.sample_date, test1.laboratory, test1.outcome, test1.standard_name], ['2026-04-20', 'PCRWR Lab', 'not_assessed', null]);
    const res1 = s.db.prepare('SELECT * FROM water_test_results WHERE test_id = ?').all(test1.id);
    assert.deepEqual(res1.map((r) => [r.parameter, r.value_text, r.value_num, r.unit, r.within_limit]), [['TDS', '450', 450, 'mg/L', null]]);

    const p2 = plant('TA-0002');
    assert.equal(p2.latitude, null);
    assert.equal(p2.status, 'unknown');
    assert.equal(p2.needs_review, 1);
    assert.equal(p2.treatment_stages_json, '[]');
    for (const c of ['coordinates_possibly_swapped', 'unrecognised_status', 'unrecognised_technology']) assert.ok(JSON.parse(p2.review_reasons_json).includes(c), c);

    const p3 = plant('TA-0003');
    assert.equal(p3.latitude, null);
    assert.ok(JSON.parse(p3.review_reasons_json).includes('coordinates_out_of_bounds'));
    assert.deepEqual([p3.status, p3.capacity_unit], ['temporarily_closed', 'litres_per_hour']);
    const row6 = s.db.prepare('SELECT * FROM import_rows WHERE batch_id = ? AND row_number = 6').get(batchA);
    assert.ok(JSON.parse(row6.warnings_json).some((w) => w.code === 'capacity_unit_conflict'));

    const p5 = plant('TA-0005');
    assert.deepEqual([p5.coord_status, p5.latitude, p5.needs_review], ['geocoded_pending', 31.4201, 1]);
    const r5 = JSON.parse(p5.review_reasons_json);
    assert.ok(r5.includes('geocoded_location_unverified') && r5.includes('geocode_approximate'));

    const cands = s.db.prepare('SELECT * FROM duplicate_candidates WHERE batch_id = ? ORDER BY id').all(batchA);
    assert.equal(cands.length, 2);
    const inFile = cands.find((c) => c.other_plant_id === null);
    assert.equal(inFile.plant_id, p1.id);
    const likely = cands.find((c) => c.other_plant_id !== null);
    assert.deepEqual([likely.plant_id, likely.other_plant_id].sort(), [p1.id, plant('TA-0004').id].sort());

    const auditRow = s.db.prepare("SELECT * FROM audit_log WHERE action = 'import.commit' AND entity_id = ?").get(String(batchA));
    assert.equal(JSON.parse(auditRow.after_json).new, 5);
    assert.equal(auditRow.actor_label, 'test');
    await assert.rejects(pipeline.commitBatch(batchA, {}), (err) => err.status === 409);
  });

  await t.test('geocoder failure is safe', async () => {
    const buf = await xlsxBuffer([{ name: 'S', rows: [['Plant ID', 'Address'], ['TG-0001', '1 Main Road']] }]);
    const { batchId } = await pipeline.createBatch({ buffer: buf, filename: 'geo.xlsx' });
    await pipeline.previewBatch(batchId, {});
    const sum = await pipeline.commitBatch(batchId, { geocoder: async () => { throw new Error('down'); } });
    assert.equal(sum.new, 1);
    assert.equal(plant('TG-0001').coord_status, 'missing');
  });

  await t.test('re-import: update vs unchanged, blanks never erase, admin curation survives', async () => {
    const H = ['Plant ID', 'Plant Name', 'Town/Tehsil', 'Area/Union Council', 'Lat', 'Lng', 'Capacity (Gallons Per Hour)', 'Operational Status'];
    const base = [
      ['TB-0001', 'Plant One', 'Jinnah Town', 'Gulberg - Sector 1', 31.41001, 73.08001, '5000 GPH', 'Fully Functional'],
      ['TB-0002', 'Plant Two', 'Jinnah Town', 'Gulberg - Sector 2', 31.41101, 73.08101, '1000 GPH', 'Fully Functional'],
      ['TB-0003', 'Plant Three', 'Jinnah Town', 'Gulberg - Sector 3', 31.41201, 73.08201, '2000 GPH', 'Fully Functional'],
    ];
    const run = async (rows, name = 'b.xlsx') => pipeline.importFromFile({ filePath: await writeFixture(name, [H, ...rows]), actorLabel: 'test' });
    async function writeFixture(name, rows) {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, await xlsxBuffer([{ name: 'S', rows }]));
      return f;
    }
    const first = await run(base);
    assert.deepEqual([first.new, first.update, first.unchanged], [3, 0, 0]);
    const again = await run(base);
    assert.deepEqual([again.new, again.update, again.unchanged], [0, 0, 3]);

    // Administrator curation of TB-0003
    s.db.prepare(`UPDATE plants SET latitude = 31.5, longitude = 73.0, coord_status = 'verified', coord_source = 'admin map pin',
                  status = 'temporarily_closed', status_source = 'admin_verified', status_updated_at = '2026-09-01T10:00:00.000Z',
                  last_verified_at = '2026-09-01', last_verified_by = 1, needs_review = 0 WHERE plant_code = 'TB-0003'`).run();
    const changed = [
      ['TB-0001', 'Plant One', 'Jinnah Town', 'Gulberg - Sector 1', 31.41001, 73.08001, '10000 GPH', 'Fully Functional'],
      ['TB-0002', null, 'Jinnah Town', 'Gulberg - Sector 2', null, null, null, 'Fully Functional'],
      ['TB-0003', 'Plant Three', 'Jinnah Town', 'Gulberg - Sector 3', 31.45, 73.05, '2000 GPH', 'Working'],
    ];
    const upd = await run(changed);
    assert.equal(upd.update, 2, 'TB-0001 (capacity) and TB-0003 (stale review reasons dropped)');
    assert.equal(upd.unchanged, 1, 'blank cells are not changes');
    assert.equal(plant('TB-0001').capacity_value, 10000);
    const p2 = plant('TB-0002');
    assert.deepEqual([p2.name, p2.latitude, p2.capacity_raw], ['Plant Two', 31.41101, '1000 GPH'], 'blank source cells never erase existing values');
    const p3 = plant('TB-0003');
    assert.deepEqual([p3.latitude, p3.longitude, p3.coord_status, p3.coord_source], [31.5, 73.0, 'verified', 'admin map pin']);
    assert.deepEqual([p3.status, p3.status_source, p3.status_raw, p3.status_updated_at], ['temporarily_closed', 'admin_verified', 'Fully Functional', '2026-09-01T10:00:00.000Z']);
    assert.deepEqual([p3.last_verified_at, p3.last_verified_by], ['2026-09-01', 1]);
    assert.equal(JSON.parse(p3.source_values_json).Lat, 31.41201, 'traceability follows the data that was actually used');
    assert.equal(JSON.parse(plant('TB-0001').source_values_json)['Capacity (Gallons Per Hour)'], '10000 GPH');
    const row3 = s.db.prepare("SELECT * FROM import_rows WHERE batch_id = ? AND row_number = 4").get(upd.batchId);
    assert.equal(row3.outcome, 'update');
    assert.deepEqual(JSON.parse(row3.normalized_json).changes.map((c) => c.field), ['review_reasons_json'], 'protected coordinates/status are not changes');
    assert.deepEqual(JSON.parse(row3.warnings_json).filter((w) => w.code === 'admin_value_kept').map((w) => w.field), ['latitude', 'status_raw']);
    const reasons = JSON.parse(p3.review_reasons_json);
    assert.ok(!reasons.includes('no_coordinates') && !reasons.includes('status_undated'));
    const auditUpd = s.db.prepare("SELECT * FROM audit_log WHERE action = 'plant.import_update' AND entity_id = 'TB-0001' ORDER BY id DESC").get();
    assert.equal(JSON.parse(auditUpd.after_json).capacity_value, 10000);

    const noUpdate = await pipeline.importFromFile({ filePath: await writeFixture('c.xlsx', [H, ['TB-0001', 'Renamed', 'Jinnah Town', 'Gulberg - Sector 1', null, null, null, null]]), updateExisting: false });
    assert.deepEqual([noUpdate.update, noUpdate.unchanged], [0, 1]);
    assert.equal(plant('TB-0001').name, 'Plant One');
  });

  await t.test('routes: permissions, upload validation, preview, errors.csv, commit, cancel', async () => {
    const editor = await s.login('editor');
    const moderator = await s.login('moderator');
    const buf = await xlsxBuffer([{ name: 'Sheet1', rows: [
      ['Plant ID', 'Town', 'Filtration Technology', 'Operating Entity Type'],
      ['TC-0001', 'Jinnah Town', '=HYPERLINK("http://example.test","x")', 'Government (WASA)'],
      ['+TC-0002', 'Jinnah Town', 'Reverse Osmosis (RO)', 'Private, "Commercial" RO'],
      [null, 'Jinnah Town', 'Reverse Osmosis (RO)', null],
    ] }]);
    const form = (b, name) => { const fd = new FormData(); fd.append('file', new Blob([b]), name); return fd; };

    assert.equal((await moderator.fetch('/api/admin/imports', { method: 'POST', body: form(buf, 'c.xlsx') })).status, 403);
    assert.equal((await moderator.fetch('/api/admin/imports')).status, 403);
    assert.equal((await moderator.fetch('/api/admin/duplicates')).status, 403);
    assert.equal((await s.fetch('/api/admin/imports')).status, 401);
    assert.equal((await editor.fetch('/api/admin/imports')).status, 200);
    assert.equal((await editor.fetch('/api/admin/duplicates')).status, 200);

    const bad = await editor.fetch('/api/admin/imports', { method: 'POST', body: form(Buffer.from('not a workbook'), 'x.xlsx') });
    assert.equal(bad.status, 415);
    assert.equal((await editor.fetch('/api/admin/imports', { method: 'POST', body: form(Buffer.from('a'), 'x.pdf') })).status, 415);
    assert.equal((await editor.fetch('/api/admin/imports', { method: 'POST', body: new FormData() })).status, 400);

    const up = await editor.fetch('/api/admin/imports', { method: 'POST', body: form(buf, 'c.xlsx') });
    assert.equal(up.status, 201);
    const created = await up.json();
    assert.equal(created.suggestedMapping.columns.technology_raw, 'Filtration Technology');
    const id = created.batchId;

    const badMap = await editor.fetch(`/api/admin/imports/${id}/preview`, { method: 'POST', json: { mapping: { town: 'Town' } } });
    assert.equal(badMap.status, 400);
    const pv = await editor.fetch(`/api/admin/imports/${id}/preview`, { method: 'POST', json: { sheet: 'Sheet1', mapping: created.suggestedMapping.columns, options: { updateExisting: true } } });
    assert.equal(pv.status, 200);
    const preview = await pv.json();
    assert.deepEqual([preview.summary.total, preview.summary.new, preview.summary.rejected], [3, 2, 1]);
    const rej = await (await editor.fetch(`/api/admin/imports/${id}/rows?outcome=rejected`)).json();
    assert.deepEqual([rej.total, rej.items[0].rowNumber], [1, 4]);

    const csvRes = await editor.fetch(`/api/admin/imports/${id}/errors.csv`);
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type'), /text\/csv/);
    assert.match(csvRes.headers.get('content-disposition'), /attachment; filename="import-\d+-errors\.csv"/);
    const csvText = (await csvRes.text()).replace(/^﻿/, '');
    const csv = parseCsv(csvText);
    assert.deepEqual(csv[0], ['row_number', 'plant_code', 'severity', 'field', 'code', 'message', 'original_value']);
    const err = csv.find((r) => r[2] === 'error');
    assert.deepEqual(err.slice(0, 5), ['4', '', 'error', 'plant_code', 'required']);
    const tech = csv.find((r) => r[4] === 'unrecognised_technology');
    assert.equal(tech[6], '\'=HYPERLINK("http://example.test","x")', 'formula neutralised with a leading apostrophe');
    assert.ok(csvText.includes('"\'=HYPERLINK(""http://example.test"",""x"")"'), 'quotes are doubled inside a quoted cell');
    const malformed = csv.find((r) => r[4] === 'plant_code_malformed');
    assert.equal(malformed[1], "'+TC-0002");
    assert.ok(csv.some((r) => r[2] === 'notice' && r[4] === 'no_coordinates'));
    const onlyErrors = parseCsv((await (await editor.fetch(`/api/admin/imports/${id}/errors.csv?severity=error`)).text()).replace(/^﻿/, ''));
    assert.equal(onlyErrors.length, 2);

    const cm = await editor.fetch(`/api/admin/imports/${id}/commit`, { method: 'POST' });
    assert.equal(cm.status, 200);
    assert.equal((await cm.json()).summary.new, 2);
    assert.equal(plant('+TC-0002').operator_type, 'Private, "Commercial" RO');
    assert.equal((await editor.fetch(`/api/admin/imports/${id}/cancel`, { method: 'POST' })).status, 409);
    const list = await (await editor.fetch('/api/admin/imports')).json();
    assert.ok(list.items.some((b) => b.id === id && b.status === 'committed' && b.createdBy === 'test-editor'));
    const detail = await (await editor.fetch(`/api/admin/imports/${id}`)).json();
    assert.equal(detail.sheets[0].name, 'Sheet1');

    const up2 = await (await editor.fetch('/api/admin/imports', { method: 'POST', body: form(buf, 'c.xlsx') })).json();
    assert.ok(up2.previouslyCommitted && up2.previouslyCommitted.batchId === id);
    assert.equal((await editor.fetch(`/api/admin/imports/${up2.batchId}/commit`, { method: 'POST' })).status, 409, 'must preview first');
    const cancel = await editor.fetch(`/api/admin/imports/${up2.batchId}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'import.cancel'").get().n, 1);
    assert.equal((await editor.fetch('/api/admin/imports/999999/rows')).status, 404);
  });

  await t.test('pipeline rejects oversized and fake files; CSV works', async () => {
    const config = require('../server/config');
    const big = Buffer.alloc(config.uploads.maxImportBytes + 1);
    big.write('PK\u0003\u0004', 'latin1');
    await assert.rejects(pipeline.createBatch({ buffer: big, filename: 'big.xlsx' }), (e) => e.status === 413);
    await assert.rejects(pipeline.createBatch({ buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), filename: 'old.xls' }), (e) => e.status === 415);
    await assert.rejects(pipeline.createBatch({ buffer: Buffer.from('PK\u0003\u0004 truncated zip', 'latin1'), filename: 'broken.xlsx' }), (e) => e.status === 422);
    const { zipUncompressedSize } = require('../server/import/parse');
    assert.ok(zipUncompressedSize(fs.readFileSync(REAL_FILE)) > 0);
    const csv = Buffer.from('﻿Plant ID,Town/Tehsil,Capacity (Gallons Per Hour)\r\nTD-0001,Samundri,"5,000 GPH"\r\n,Samundri,1\r\n');
    const created = await pipeline.createBatch({ buffer: csv, filename: 'plants.csv' });
    const pv = await pipeline.previewBatch(created.batchId, {});
    assert.deepEqual([pv.summary.new, pv.summary.rejected], [1, 1]);
    const row = pv.rows.find((r) => r.plantCode === 'TD-0001');
    assert.deepEqual([row.rowNumber, row.plant.capacityValue, row.plant.capacityUnit], [2, 5000, 'gallons_per_hour']);
    pipeline.cancelBatch(created.batchId);
  });

  await t.test('duplicate review: list, keep_separate for a repeated code, merge moves references', async () => {
    const editor = await s.login('editor');
    const list = await (await editor.fetch('/api/admin/duplicates?status=open')).json();
    const inFile = list.items.find((c) => c.kind === 'duplicate_code_in_file' && c.plant && c.plant.code === 'TA-0001');
    const likely = list.items.find((c) => c.kind === 'likely_duplicate' && c.other);
    assert.ok(inFile && likely);
    assert.equal(inFile.row.rowNumber, 5);
    assert.equal(inFile.row.values['Plant Name'], 'Model Town Filter Plant (repeat)');
    assert.ok(likely.plant.code && likely.other.code && 'technologyRaw' in likely.plant);

    const noNote = await editor.fetch(`/api/admin/duplicates/${inFile.id}/resolve`, { method: 'POST', json: { action: 'keep_separate' } });
    assert.equal(noNote.status, 400);
    const mergeInFile = await editor.fetch(`/api/admin/duplicates/${inFile.id}/resolve`, { method: 'POST', json: { action: 'merge', note: 'try merge' } });
    assert.equal(mergeInFile.status, 400);
    const keep = await editor.fetch(`/api/admin/duplicates/${inFile.id}/resolve`, { method: 'POST', json: { action: 'keep_separate', note: 'Distinct plant with a reused code' } });
    assert.equal(keep.status, 200);
    const kept = await keep.json();
    assert.deepEqual([kept.status, kept.importedPlant, kept.derivedCode], ['kept_separate', 'TA-0001-DUP2', true]);
    const dup = plant('TA-0001-DUP2');
    assert.equal(dup.needs_review, 1);
    assert.ok(JSON.parse(dup.review_reasons_json).includes('duplicate_plant_code'));
    assert.equal(JSON.parse(dup.source_values_json)['Plant ID'], 'TA-0001');
    assert.equal(dup.source_row, 5);
    assert.equal((await editor.fetch(`/api/admin/duplicates/${inFile.id}/resolve`, { method: 'POST', json: { action: 'dismiss', note: 'again' } })).status, 409);

    // Give the plant that will be removed some references
    const keepId = likely.plant.id, removeId = likely.other.id;
    const now = new Date().toISOString();
    s.db.prepare("INSERT INTO water_tests (plant_id, sample_date, outcome, created_at) VALUES (?, '2026-01-02', 'not_assessed', ?)").run(removeId, now);
    s.db.prepare("INSERT INTO plant_sources (plant_id, title, created_at) VALUES (?, 'Doc', ?)").run(removeId, now);
    s.db.prepare(`INSERT INTO reports (reference, plant_id, category, description, observed_at, consent_contact, created_at, updated_at)
                  VALUES ('TW-TEST-0001', ?, 'no_water', 'No water this morning at all', '2026-09-01T08:00', 1, ?, ?)`).run(removeId, now, now);
    s.db.prepare("INSERT INTO ratings (plant_id, stars, created_at) VALUES (?, 4, ?)").run(removeId, now);
    const removedCode = likely.other.code;
    const merge = await editor.fetch(`/api/admin/duplicates/${likely.id}/resolve`, { method: 'POST', json: { action: 'merge', note: 'Same plant, two codes' } });
    assert.equal(merge.status, 200);
    const merged = await merge.json();
    assert.equal(merged.removedPlant, removedCode);
    assert.equal(plant(removedCode), undefined);
    for (const table of ['water_tests', 'plant_sources', 'reports', 'ratings']) {
      assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE plant_id = ?`).get(removeId).n, 0, table);
    }
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE plant_id = ? AND reference = 'TW-TEST-0001'").get(keepId).n, 1);
    const a = s.db.prepare("SELECT * FROM audit_log WHERE action = 'plant.merge' ORDER BY id DESC").get();
    assert.equal(JSON.parse(a.before_json).removedPlant.plant_code, removedCode);
    assert.equal(a.reason, 'Same plant, two codes');
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'duplicate.resolve'").get().n, 2);
    const done = await (await editor.fetch('/api/admin/duplicates?status=merged')).json();
    assert.ok(done.items.some((c) => c.id === likely.id && c.status === 'merged' && /Merged/.test(c.resolutionNote)));
    await assert.throws(() => resolveDuplicate(likely.id, { action: 'dismiss', note: 'x' }), (e) => e.status === 409);
  });

  await t.test('real spreadsheet: 1,000 new plants with exact traceability', async () => {
    const summary = await pipeline.importFromFile({ filePath: REAL_FILE, actorLabel: 'test' });
    assert.deepEqual(
      [summary.total, summary.new, summary.update, summary.unchanged, summary.rejected, summary.duplicateReview, summary.incomplete],
      [1000, 1000, 0, 0, 0, 0, 1000],
    );
    assert.equal(summary.sheet, 'Faisalabad_1000_Water_Filtratio');
    assert.equal(summary.sourceFile, 'Filter_palnts_in_Faisalabad_1000_1.xlsx');
    assert.equal(summary.likelyDuplicates, 0, 'no names or coordinates, so no duplicate candidates');
    assert.deepEqual(summary.issues, {
      sector_suffix_unverified: 1000, no_coordinates: 1000, capacity_gallon_type_unspecified: 1000, status_undated: 1000,
      operator_acronym_unexplained: 336, capacity_unusually_high: 216, operator_type_is_plant_type: 200,
      area_not_geocodable: 190, operator_type_technology_mismatch: 57, area_name_possible_typo: 26,
    });
    const p = plant('FSD-WFP-0010');
    assert.deepEqual([p.source_file, p.source_sheet, p.source_row, p.capacity_raw, p.capacity_value, p.capacity_unit, p.capacity_gallon_type],
      ['Filter_palnts_in_Faisalabad_1000_1.xlsx', 'Faisalabad_1000_Water_Filtratio', 11, '25000 GPH', 25000, 'gallons_per_hour', 'unspecified']);
    assert.deepEqual(JSON.parse(p.source_values_json), {
      'Plant ID': 'FSD-WFP-0010', 'Town/Tehsil': 'Samundri', 'Area/Union Council': 'Saline Zone-C - Sector 8',
      'Operating Entity Type': 'Saline Water Treatment RO', 'Water Source': 'Brackish/Saline Groundwater',
      'Filtration Technology': 'Heavy-Duty Brackish RO Membrane (High TDS)', 'Capacity (Gallons Per Hour)': '25000 GPH', 'Operational Status': 'Fully Functional',
    });
    assert.deepEqual([p.status, p.status_raw, p.status_source, p.status_updated_at], ['operational', 'Fully Functional', 'spreadsheet', null]);
    assert.deepEqual([p.coord_status, p.latitude, p.collection_limit_value, p.name], ['missing', null, null, null]);
    assert.equal(p.treatment_stages_json, '["reverse_osmosis"]');
    assert.equal(p.needs_review, 1);
    const first = plant('FSD-WFP-0001');
    assert.equal(first.source_row, 2);
    assert.equal(plant('FSD-WFP-1000').source_row, 1001);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM plants WHERE plant_code LIKE 'FSD-WFP-%'").get().n, 1000);
    assert.equal(s.db.prepare("SELECT COUNT(DISTINCT area_id) AS n FROM plants WHERE plant_code LIKE 'FSD-WFP-%'").get().n, 39);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM duplicate_candidates WHERE batch_id = ?').get(summary.batchId).n, 0);
    const again = await pipeline.importFromFile({ filePath: REAL_FILE, actorLabel: 'test' });
    assert.deepEqual([again.new, again.update, again.unchanged], [0, 0, 1000]);
  });
});
