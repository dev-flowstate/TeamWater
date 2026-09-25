'use strict';
// ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
// ║  DEMONSTRATION DATA ONLY — THESE ARE NOT REAL PLANTS.                                        ║
// ║                                                                                              ║
// ║  * Isolated: every row has plants.is_demo = 1 and a code DEMO-0001…; public queries only     ║
// ║    return them when config.demoData (DEMO_DATA=1) is on, and every page then shows a banner. ║
// ║  * Labelled: every name reads "DEMO — … (not a real plant)"; the demo water test names a     ║
// ║    fictional laboratory and a fictional standard. Positions are made up.                     ║
// ║  * Never enable DEMO_DATA in production unless that is explicitly intended (e.g. a public    ║
// ║    training site). syncDemoData(false) removes every demo plant and all dependent rows.      ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
//
// syncDemoData(enabled) → { enabled, upserted, removed, waterTests }
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { getDb, tx } = require('./db');
const { nowIso, karachiParts } = require('./time');

const DEMO_SOURCE = 'DEMO (generated demonstration data — not from any real source)';

// Positions are fictional points spread across central Faisalabad (all inside config.map.bounds).
const DEMO_PLANTS = [
  {
    code: 'DEMO-0001', name: 'DEMO — Sample plant A (not a real plant)', lat: 31.4187, lng: 73.0791,
    status: 'operational', status_source: 'admin_verified', verified: true,
    technology: 'Reverse Osmosis (RO)', stages: ['reverse_osmosis'], capacity: 2000, gallonType: 'unspecified',
    note: 'Verified operating status (demo).',
  },
  {
    code: 'DEMO-0002', name: 'DEMO — Sample plant B (not a real plant)', lat: 31.4262, lng: 73.0912,
    status: 'temporarily_closed', status_source: 'admin', technology: 'Ultrafiltration (UF)', stages: ['ultrafiltration'],
    capacity: 1000, gallonType: 'unspecified', note: 'Temporarily closed (demo).',
  },
  {
    code: 'DEMO-0003', name: 'DEMO — Sample plant C (not a real plant)', lat: 31.4098, lng: 73.0655,
    status: 'permanently_closed', status_source: 'admin', technology: 'Reverse Osmosis (RO)', stages: ['reverse_osmosis'],
    capacity: 5000, gallonType: 'unspecified', note: 'Permanently closed (demo) — excluded from search results.',
  },
  {
    code: 'DEMO-0004', name: 'DEMO — Sample plant D (not a real plant)', lat: 31.4352, lng: 73.0703,
    status: 'operational', status_source: 'spreadsheet', technology: 'Activated Carbon + UV', stages: ['activated_carbon', 'uv'],
    capacity: 1000, gallonType: 'unspecified',
    hoursText: 'DEMO hours: Mon–Sat 08:00–20:00, Sun closed',
    hours: { mon: [['08:00', '20:00']], tue: [['08:00', '20:00']], wed: [['08:00', '20:00']], thu: [['08:00', '20:00']], fri: [['08:00', '20:00']], sat: [['08:00', '20:00']], sun: [] },
  },
  {
    code: 'DEMO-0005', name: 'DEMO — Sample plant E (not a real plant)', lat: 31.4003, lng: 73.0998,
    status: 'operational', status_source: 'spreadsheet', technology: 'Reverse Osmosis (RO)', stages: ['reverse_osmosis'],
    capacity: 1000, gallonType: 'us', withTest: true,
  },
  {
    code: 'DEMO-0006', name: 'DEMO — Sample plant F (not a real plant)', lat: 31.4448, lng: 73.1049,
    status: 'operational', status_source: 'spreadsheet', technology: 'Heavy-Duty Brackish RO Membrane (High TDS)', stages: ['reverse_osmosis'],
    capacity: 10000, gallonType: 'unspecified', note: 'No water-test data (demo).',
  },
  {
    code: 'DEMO-0007', name: 'DEMO — Sample plant G (not a real plant)', lat: 31.3951, lng: 73.0552,
    status: 'unknown', status_source: 'none', technology: 'Ultrafiltration (UF)', stages: ['ultrafiltration'],
    capacity: 2000, gallonType: 'unspecified',
  },
  {
    code: 'DEMO-0008', name: 'DEMO — Sample plant H (not a real plant)', lat: 31.4221, lng: 73.1148,
    status: 'operational', status_source: 'admin', technology: 'Reverse Osmosis (RO)', stages: ['reverse_osmosis'],
    capacity: 5000, gallonType: 'unspecified',
  },
];

function plantRow(d, now, today) {
  return {
    plant_code: d.code,
    name: d.name,
    town: 'DEMO (fictional)',
    area_raw: 'DEMO area (fictional)',
    area_name: 'DEMO area (fictional)',
    area_sector: null,
    area_id: null,
    address: 'DEMO — fictional address',
    latitude: d.lat,
    longitude: d.lng,
    coord_status: 'verified',
    coord_source: 'DEMO (fictional position)',
    coord_note: 'Demonstration data — not a real location.',
    operator_type: 'DEMO operator (fictional)',
    water_source: 'DEMO source (fictional)',
    technology_raw: d.technology,
    treatment_stages_json: JSON.stringify(d.stages),
    capacity_raw: `${d.capacity} GPH`,
    capacity_value: d.capacity,
    capacity_unit: 'gallons_per_hour',
    capacity_unit_label: 'GPH',
    capacity_basis: 'DEMO value (fictional)',
    capacity_gallon_type: d.gallonType,
    opening_hours_text: d.hoursText || null,
    opening_hours_json: d.hours ? JSON.stringify(d.hours) : null,
    status: d.status,
    status_raw: `DEMO: ${d.status}`,
    status_source: d.status_source,
    status_updated_at: d.status_source === 'spreadsheet' || d.status_source === 'none' ? null : now,
    status_note: d.note || null,
    last_verified_at: d.verified ? today : null,
    last_verified_by: null,
    verification_note: d.verified ? 'DEMO verification (fictional).' : null,
    needs_review: 0,
    review_reasons_json: '[]',
    source_file: DEMO_SOURCE,
    source_sheet: null,
    source_row: null,
    source_values_json: null,
    is_demo: 1,
  };
}

function deleteFileRows(db, fileIds) {
  for (const id of fileIds) {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (!f) continue;
    const stillUsed = db.prepare(`SELECT
        (SELECT COUNT(*) FROM water_tests WHERE report_file_id = ?) + (SELECT COUNT(*) FROM report_photos WHERE file_id = ?) +
        (SELECT COUNT(*) FROM plant_sources WHERE file_id = ?) + (SELECT COUNT(*) FROM import_batches WHERE file_id = ?) AS n`).get(id, id, id, id).n;
    if (stillUsed) continue;
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    const abs = path.resolve(config.uploadDir, f.storage_path);
    if (abs.startsWith(path.resolve(config.uploadDir) + path.sep)) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
  }
}

/** Removes demo plants (all, or those whose code is not in keepCodes) and every dependent row. */
function removeDemoPlants(db, keepCodes = []) {
  const ids = db.prepare('SELECT id FROM plants WHERE is_demo = 1 AND plant_code NOT IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(keepCodes)).map((r) => r.id);
  if (!ids.length) return 0;
  const list = JSON.stringify(ids);
  const IN = '(SELECT value FROM json_each(?))';
  const fileIds = [
    ...db.prepare(`SELECT report_file_id AS id FROM water_tests WHERE report_file_id IS NOT NULL AND plant_id IN ${IN}`).all(list),
    ...db.prepare(`SELECT file_id AS id FROM plant_sources WHERE file_id IS NOT NULL AND plant_id IN ${IN}`).all(list),
    ...db.prepare(`SELECT ph.file_id AS id FROM report_photos ph JOIN reports r ON r.id = ph.report_id WHERE r.plant_id IN ${IN}`).all(list),
  ].map((r) => r.id);
  // Rows whose foreign keys do not cascade are handled explicitly.
  db.prepare(`UPDATE appeals SET plant_id = NULL WHERE plant_id IN ${IN}`).run(list);
  db.prepare(`UPDATE import_rows SET plant_id = NULL WHERE plant_id IN ${IN}`).run(list);
  db.prepare(`DELETE FROM reports WHERE plant_id IN ${IN}`).run(list); // report_events / report_photos / investigation_reports cascade
  db.prepare(`DELETE FROM plants WHERE id IN ${IN}`).run(list); // tests, results, sources, history, ratings, investigations cascade
  deleteFileRows(db, fileIds);
  return ids.length;
}

function syncDemoData(enabled) {
  const db = getDb();
  return tx(() => {
    if (!enabled) return { enabled: false, upserted: 0, removed: removeDemoPlants(db), waterTests: 0 };

    const now = nowIso();
    const today = karachiParts(new Date()).date;
    const removed = removeDemoPlants(db, DEMO_PLANTS.map((d) => d.code));
    let waterTests = 0;
    for (const d of DEMO_PLANTS) {
      const existing = db.prepare('SELECT is_demo FROM plants WHERE plant_code = ?').get(d.code);
      if (existing && existing.is_demo !== 1) throw new Error(`Refusing to overwrite non-demo plant ${d.code}`);
      const row = plantRow(d, now, today);
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO plants (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)
                  ON CONFLICT(plant_code) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`)
        .run(...cols.map((c) => row[c]), now, now);
      const plant = db.prepare('SELECT id FROM plants WHERE plant_code = ?').get(d.code);

      // Rebuild dependent demo rows so repeated syncs stay idempotent.
      db.prepare('DELETE FROM water_tests WHERE plant_id = ?').run(plant.id);
      if (d.withTest) {
        const sample = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
        const t = db.prepare(`INSERT INTO water_tests (plant_id, sample_date, laboratory, source_description, standard_name, standard_version,
                                standard_source, outcome, notes, published, created_at)
                              VALUES (?, ?, 'DEMO LAB (fictional)', 'DEMO sample from the dispensing tap (fictional)', 'DEMO standard (fictional)',
                                'DEMO-1', 'Fictional standard used for demonstration only', 'met_limits',
                                'Demonstration data — not a real laboratory result.', 1, ?)`).run(plant.id, sample, now);
        const testId = Number(t.lastInsertRowid);
        const ins = db.prepare('INSERT INTO water_test_results (test_id, parameter, value_text, value_num, unit, limit_text, within_limit) VALUES (?, ?, ?, ?, ?, ?, 1)');
        ins.run(testId, 'pH (DEMO)', '7.2', 7.2, null, '6.5–8.5 (DEMO)');
        ins.run(testId, 'TDS (DEMO)', '180', 180, 'mg/L', '< 1000 (DEMO)');
        ins.run(testId, 'E. coli (DEMO)', 'Absent', null, null, 'Absent (DEMO)');
        waterTests++;
      }
    }
    return { enabled: true, upserted: DEMO_PLANTS.length, removed, waterTests };
  });
}

module.exports = { DEMO_PLANTS, syncDemoData, removeDemoPlants };
