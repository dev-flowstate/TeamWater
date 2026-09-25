'use strict';
// Spreadsheet import workflow: upload -> preview (mapping + validation) -> commit (one transaction) | cancel.
//
//   const pipeline = require('../import/pipeline');
//   const { batchId, sheets, suggestedMapping, targetFields } = await pipeline.createBatch({ buffer, filename, userId });
//   const { summary, rows } = await pipeline.previewBatch(batchId, { sheet, mapping, options: { updateExisting: true } });
//   const summary = await pipeline.commitBatch(batchId, { userId, req });
//   pipeline.cancelBatch(batchId, { req });
//   const csv = pipeline.errorsCsv(batchId);
//   const summary = await pipeline.importFromFile({ filePath, actorLabel: 'setup' });   // CLI / setup, end to end
//
// Summary: { total, new, update, unchanged, rejected, incomplete, duplicateReview, sourceFile, sheet, batchId, importedAt,
//            likelyDuplicates, geocoded, issues: { <code>: rows } }
// Accuracy rules (ARCHITECTURE.md §0): verbatim values are kept in source_values_json and *_raw columns; administrator-
// curated coordinates, status and verification are never overwritten; blank source cells never erase existing values.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { getDb, tx, parseJson } = require('../lib/db');
const { HttpError } = require('../lib/http');
const { audit } = require('../lib/audit');
const { nowIso, karachiParts } = require('../lib/time');
const { areaKey, normalizeSearch } = require('../lib/text');
const { TARGET_FIELDS, TARGET_KEYS, DATA_ISSUES, PARAM_PREFIX, suggestMapping, isParamKey } = require('./fields');
const { detectFileType, parseWorkbook } = require('./parse');
const { normalizeRow, GROUPS, TRACE_COLUMNS, DATASET_WIDE, nameSimilarity, inBounds } = require('./normalize');
const { toCsv } = require('./csv');

const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };
const MAX_GEOCODE_PER_COMMIT = 250;
const GEOCODE_BUDGET_MS = 60000; // keep a commit request bounded even if the provider is slow
const DUPLICATE_RADIUS_M = 25;
const NAME_SIMILARITY_MIN = 0.75;
const IMPORTER_CODES = new Set(Object.keys(DATA_ISSUES));
const GEOCODE_CODES = new Set(['geocoded_location_unverified', 'geocode_ambiguous', 'geocode_approximate']);
/** Which source group each importer issue depends on (used to keep issues for groups a re-import leaves blank). */
const ISSUE_GROUPS = {
  area_not_geocodable: ['area'], area_name_possible_typo: ['area'], sector_suffix_unverified: ['area'],
  operator_type_is_plant_type: ['operator_type'], operator_acronym_unexplained: ['operator_type'],
  operator_type_technology_mismatch: ['operator_type', 'technology'], unrecognised_technology: ['technology'],
  capacity_gallon_type_unspecified: ['capacity'], capacity_unusually_high: ['capacity'],
  status_undated: ['status'], unrecognised_status: ['status'],
  coordinates_out_of_bounds: ['coords'], coordinates_possibly_swapped: ['coords'],
};

// ───────────────────────── helpers ─────────────────────────
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortedJson = (text) => JSON.stringify([...parseJson(text, [])].sort());

function safeFilename(name) {
  const base = path.basename(String(name || 'upload').replace(/\\/g, '/'));
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|]/g, '').trim();
  return (clean || 'upload').slice(0, 200);
}

function getBatch(batchId) {
  const id = Number(batchId);
  const batch = Number.isInteger(id) && id > 0 ? getDb().prepare('SELECT * FROM import_batches WHERE id = ?').get(id) : null;
  if (!batch) throw new HttpError(404, 'not_found', 'Import batch not found.');
  return batch;
}

const parsedCache = new Map();
async function loadSheets(batch) {
  const hit = parsedCache.get(batch.id);
  if (hit && hit.sha === batch.file_sha256) return hit.sheets;
  const file = batch.file_id ? getDb().prepare('SELECT * FROM files WHERE id = ?').get(batch.file_id) : null;
  const full = file && path.join(config.uploadDir, file.storage_path);
  if (!full || !fs.existsSync(full)) throw new HttpError(410, 'upload_missing', 'The uploaded file for this batch is no longer available. Upload it again.');
  const buffer = fs.readFileSync(full);
  const { sheets } = await parseWorkbook(buffer, detectFileType(buffer, batch.source_filename), batch.source_filename);
  parsedCache.set(batch.id, { sha: batch.file_sha256, sheets });
  while (parsedCache.size > 4) parsedCache.delete(parsedCache.keys().next().value);
  return sheets;
}

/** Accepts { targetKey: header } or { sheet, columns: {...} }; returns a complete, validated column map. */
function validateMapping(input, headers) {
  const given = input && typeof input === 'object' ? (input.columns && typeof input.columns === 'object' ? input.columns : input) : null;
  const src = given || suggestMapping(headers);
  const headerSet = new Set(headers);
  const out = Object.fromEntries(TARGET_FIELDS.map((f) => [f.key, null]));
  let params = 0;
  for (const [rawKey, v] of Object.entries(src)) {
    const key = isParamKey(rawKey) ? PARAM_PREFIX + rawKey.slice(PARAM_PREFIX.length).trim() : rawKey;
    if (!TARGET_KEYS.has(key) && !isParamKey(key)) throw new HttpError(400, 'mapping_invalid', `Unknown target field "${rawKey}".`, { field: rawKey });
    if (v === null || v === undefined || v === '') continue;
    if (typeof v !== 'string' || !headerSet.has(v)) throw new HttpError(400, 'mapping_invalid', `Column "${v}" is not in the selected sheet.`, { field: rawKey });
    if (isParamKey(key) && ++params > 100) throw new HttpError(400, 'mapping_invalid', 'Too many water-test parameter columns (maximum 100).');
    out[key] = v;
  }
  if (!out.plant_code) throw new HttpError(400, 'mapping_invalid', 'Map a column to "Plant ID" before previewing.', { field: 'plant_code' });
  if (out.capacity && out.capacity === out.collection_limit) {
    throw new HttpError(400, 'mapping_invalid', 'Production capacity and the per-person collection limit must come from different columns.', { field: 'collection_limit' });
  }
  return out;
}

// ───────────────────────── merge rules for existing plants ─────────────────────────
const isExact = (status, lat, lng) => ['source', 'verified'].includes(status) && lat !== null && lat !== undefined && lng !== null && lng !== undefined;

/**
 * Compute the update for an existing plant. Never touches: coordinates when coord_status='verified'; status fields when
 * status_source is 'admin'/'admin_verified'; last_verified_*; or any group the source row leaves blank.
 */
function mergeForUpdate(existing, entry) {
  const protectedGroups = new Set(['last_verified']);
  if (existing.coord_status === 'verified') protectedGroups.add('coords');
  if (existing.status_source === 'admin' || existing.status_source === 'admin_verified') protectedGroups.add('status');
  const set = {};
  const kept = [];
  for (const g of entry.provided) {
    if (protectedGroups.has(g)) {
      if (g !== 'last_verified' && GROUPS[g].some((col) => ['latitude', 'longitude', 'status_raw'].includes(col) && !same(existing[col], entry.plant[col]))) kept.push(g);
      continue;
    }
    for (const col of GROUPS[g]) set[col] = entry.plant[col] ?? null;
  }
  for (const col of TRACE_COLUMNS) set[col] = entry.plant[col];

  // Review reasons: the row decides for groups it provides; otherwise earlier reasons are kept.
  const present = new Set(entry.present || entry.provided);
  const finalStatus = 'coord_status' in set ? set.coord_status : existing.coord_status;
  const exact = isExact(finalStatus, 'latitude' in set ? set.latitude : existing.latitude, 'longitude' in set ? set.longitude : existing.longitude);
  const old = parseJson(existing.review_reasons_json, []);
  const reasons = new Set();
  const decidedByRow = (code) => (ISSUE_GROUPS[code] || []).every((g) => present.has(g));
  for (const code of entry.issues) if (code !== 'no_coordinates' && decidedByRow(code)) reasons.add(code);
  for (const code of old) {
    if (!IMPORTER_CODES.has(code)) reasons.add(code); // set by another workflow; not ours to clear
    else if (GEOCODE_CODES.has(code)) { if (finalStatus === 'geocoded_pending') reasons.add(code); }
    else if (code === 'duplicate_plant_code') reasons.add(code);
    else if (ISSUE_GROUPS[code] && !decidedByRow(code)) reasons.add(code);
  }
  if (!exact) reasons.add('no_coordinates');
  if (protectedGroups.has('coords')) for (const c of ['coordinates_out_of_bounds', 'coordinates_possibly_swapped', 'no_coordinates']) reasons.delete(c);
  if (protectedGroups.has('status')) for (const c of ['status_undated', 'unrecognised_status']) reasons.delete(c);
  const list = [...reasons];
  set.review_reasons_json = JSON.stringify(list);
  const oldReviewable = new Set(old.filter((c) => !DATASET_WIDE.has(c)));
  const added = list.some((c) => !DATASET_WIDE.has(c) && !oldReviewable.has(c));
  set.needs_review = existing.needs_review || added ? 1 : 0; // cleared only by an administrator

  const diffCols = (cols) => cols.filter((col) => {
    const before = existing[col], value = set[col];
    return !(col === 'review_reasons_json' ? sortedJson(before) === sortedJson(value)
      : col === 'treatment_stages_json' ? same(parseJson(before, []), parseJson(value, [])) : same(before, value));
  }).map((col) => ({ field: col, before: existing[col] ?? null, after: set[col] ?? null }));
  const REVIEW = ['needs_review', 'review_reasons_json'];
  const dataChanges = diffCols(Object.keys(set).filter((c) => !TRACE_COLUMNS.includes(c) && !REVIEW.includes(c)));
  // Traceability follows the data: a plant whose data is unchanged keeps pointing at the row its data came from.
  const changes = [...dataChanges, ...diffCols(REVIEW)];
  if (dataChanges.length) changes.push(...diffCols(TRACE_COLUMNS));
  else for (const col of TRACE_COLUMNS) delete set[col];
  return { set, changes, exact, kept };
}

const KEPT_MESSAGES = {
  coords: 'The source coordinates differ from the administrator-verified location, which was kept.',
  status: 'The source status differs from the status set by an administrator, which was kept.',
};
const keptWarnings = (m) => m.kept.map((g) => ({ field: g === 'coords' ? 'latitude' : 'status_raw', code: 'admin_value_kept', message: KEPT_MESSAGES[g], value: null }));

function pendingExtras(db, plantId, entry) {
  const changes = [];
  for (const t of entry.tests || []) {
    const hit = db.prepare('SELECT id FROM water_tests WHERE plant_id = ? AND sample_date = ? AND IFNULL(laboratory, \'\') = ?').get(plantId, t.sampleDate, t.laboratory || '');
    if (!hit) changes.push({ field: 'water_test', before: null, after: t.sampleDate });
  }
  for (const s of entry.sources || []) {
    if (!db.prepare('SELECT id FROM plant_sources WHERE plant_id = ? AND url = ?').get(plantId, s.url)) changes.push({ field: 'source_document', before: null, after: s.url });
  }
  return changes;
}

// ───────────────────────── likely duplicates under different codes ─────────────────────────
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const plantDupView = (p) => ({
  code: p.plant_code, name: p.name, areaKey: p.area_name && p.town ? areaKey(p.area_name, p.town) : null,
  lat: isExact(p.coord_status, p.latitude, p.longitude) ? p.latitude : null, lng: isExact(p.coord_status, p.latitude, p.longitude) ? p.longitude : null,
});

/**
 * Pairs of plants that look like the same physical plant under different codes: exact coordinates within 25 m AND a
 * similar name, or an identical normalised name in the same area. Rows without a name are never compared (shared
 * town/area/operator/technology/capacity alone is not evidence of duplication).
 */
function findLikelyDuplicates(subjects, others) {
  const all = [...subjects, ...others].filter((p) => p.name);
  const byNameArea = new Map();
  const grid = new Map();
  const cell = (lat, lng) => `${Math.floor(lat * 1000)}:${Math.floor(lng * 1000)}`;
  for (const p of all) {
    if (p.areaKey) {
      const k = `${normalizeSearch(p.name)}|${p.areaKey}`;
      if (!byNameArea.has(k)) byNameArea.set(k, []);
      byNameArea.get(k).push(p);
    }
    if (p.lat !== null && p.lat !== undefined) {
      const k = cell(p.lat, p.lng);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
  }
  const pairs = new Map();
  const add = (a, b, reason, detail, score) => {
    if (a.code === b.code) return;
    const key = [a.code, b.code].sort().join('\u0000');
    if (!pairs.has(key)) pairs.set(key, { a: a.code, b: b.code, reason, detail, score: Math.round(score * 100) / 100 });
  };
  for (const s of subjects) {
    if (!s.name) continue;
    if (s.areaKey) for (const o of byNameArea.get(`${normalizeSearch(s.name)}|${s.areaKey}`) || []) add(s, o, 'same_name_and_area', `Same name and area as ${o.code}.`, 1);
    if (s.lat === null || s.lat === undefined) continue;
    const [ci, cj] = [Math.floor(s.lat * 1000), Math.floor(s.lng * 1000)];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const o of grid.get(`${ci + di}:${cj + dj}`) || []) {
        if (o.code === s.code) continue;
        const d = haversineM(s.lat, s.lng, o.lat, o.lng);
        const sim = nameSimilarity(s.name, o.name);
        if (d <= DUPLICATE_RADIUS_M && sim >= NAME_SIMILARITY_MIN) add(s, o, 'nearby_position', `Within ${Math.round(d)} m of ${o.code} with a similar name.`, sim);
      }
    }
  }
  return [...pairs.values()];
}

// ───────────────────────── evaluation (shared by preview and dry-run) ─────────────────────────
function evaluateSheet(ws, columns, { sourceFile, updateExisting = true }) {
  const db = getDb();
  const existingByCode = new Map(db.prepare('SELECT * FROM plants').all().map((p) => [p.plant_code, p]));
  const firstRowByCode = new Map();
  const today = karachiParts().date;
  const rows = ws.rows.map((r) => {
    const entry = normalizeRow(r.values, columns, { sourceFile, sheet: ws.name, rowNumber: r.rowNumber, today });
    let outcome, changes = [], duplicateOfRow = null, plantId = null;
    if (entry.errors.length) outcome = 'rejected';
    else if (firstRowByCode.has(entry.code)) {
      outcome = 'duplicate_review';
      duplicateOfRow = firstRowByCode.get(entry.code);
      entry.warnings.push({ field: 'plant_code', code: 'duplicate_code_in_file', message: `Plant ID also appears at row ${duplicateOfRow}; this row was not imported and is held for duplicate review.`, value: entry.code });
    } else {
      firstRowByCode.set(entry.code, r.rowNumber);
      const existing = existingByCode.get(entry.code);
      if (!existing) outcome = 'new';
      else {
        plantId = existing.id;
        const m = mergeForUpdate(existing, entry);
        entry.warnings.push(...keptWarnings(m));
        changes = [...m.changes, ...pendingExtras(db, existing.id, entry)];
        entry.incomplete = !m.exact || !(m.set.name ?? existing.name);
        outcome = changes.length ? 'update' : 'unchanged';
        if (!updateExisting && changes.length) {
          outcome = 'unchanged';
          entry.warnings.push({ field: 'plant_code', code: 'existing_not_updated', message: 'A plant with this ID already exists and updating existing plants is switched off, so it was left unchanged.', value: entry.code });
          changes = [];
        }
      }
    }
    return { rowNumber: r.rowNumber, raw: r.values, entry, outcome, changes, duplicateOfRow, plantId };
  });

  // Likely duplicates (preview hint; recomputed against the database at commit)
  const live = rows.filter((r) => ['new', 'update', 'unchanged'].includes(r.outcome));
  const subjects = live.map((r) => {
    const ex = existingByCode.get(r.entry.code);
    const base = ex ? plantDupView(ex) : { code: r.entry.code, name: null, areaKey: null, lat: null, lng: null };
    const p = r.entry.plant;
    return {
      code: r.entry.code, name: p.name ?? base.name, areaKey: r.entry.areaKey ?? base.areaKey,
      lat: p.coord_status === 'source' ? p.latitude : base.lat, lng: p.coord_status === 'source' ? p.longitude : base.lng,
    };
  });
  const codes = new Set(subjects.map((s) => s.code));
  const others = [...existingByCode.values()].filter((p) => !codes.has(p.plant_code) && !p.is_demo && p.name).map(plantDupView);
  const byCode = new Map(live.map((r) => [r.entry.code, r]));
  for (const pair of findLikelyDuplicates(subjects, others)) {
    for (const [self, other] of [[pair.a, pair.b], [pair.b, pair.a]]) {
      const row = byCode.get(self);
      if (!row) continue;
      row.entry.likelyDuplicates = [...(row.entry.likelyDuplicates || []), { code: other, reason: pair.reason, score: pair.score }];
      row.entry.warnings.push({ field: 'name', code: 'possible_duplicate', message: `Possible duplicate of ${other} (${pair.reason === 'nearby_position' ? 'nearby, similar name' : 'same name and area'}). It will be imported and queued for duplicate review.`, value: other });
    }
  }
  return { rows, summary: summarise(rows, { sourceFile, sheet: ws.name }) };
}

function summarise(rows, { sourceFile, sheet, batchId = null, importedAt = null }) {
  const s = { total: rows.length, new: 0, update: 0, unchanged: 0, rejected: 0, incomplete: 0, duplicateReview: 0, sourceFile, sheet, batchId, importedAt, likelyDuplicates: 0, issues: {} };
  const likely = new Set();
  for (const r of rows) {
    if (r.outcome === 'duplicate_review') s.duplicateReview++;
    else s[r.outcome]++;
    if (r.outcome === 'rejected' || r.outcome === 'duplicate_review') continue;
    if (r.entry.incomplete) s.incomplete++;
    for (const c of r.entry.issues) s.issues[c] = (s.issues[c] || 0) + 1;
    for (const d of r.entry.likelyDuplicates || []) likely.add([r.entry.code, d.code].sort().join('\u0000'));
  }
  s.likelyDuplicates = likely.size;
  return s;
}

// ───────────────────────── row views & CSV ─────────────────────────
function rowView(r) {
  const n = parseJson(r.normalized_json, {}) || {};
  const p = n.plant || {};
  return {
    id: r.id, rowNumber: r.row_number, plantCode: n.code ?? null, outcome: r.outcome, incomplete: !!r.incomplete,
    needsReview: !!n.needsReview, errors: parseJson(r.errors_json, []), warnings: parseJson(r.warnings_json, []),
    issues: n.issues || [], missingFields: n.missingFields || [], changes: n.changes || [], duplicateOfRow: n.duplicateOfRow ?? null,
    likelyDuplicates: n.likelyDuplicates || [], plantId: r.plant_id ?? null, values: parseJson(r.raw_json, {}),
    plant: {
      name: p.name ?? null, town: p.town ?? null, areaRaw: p.area_raw ?? null, areaName: p.area_name ?? null, areaSector: p.area_sector ?? null,
      latitude: p.latitude ?? null, longitude: p.longitude ?? null, coordStatus: p.coord_status ?? null,
      operatorType: p.operator_type ?? null, waterSource: p.water_source ?? null, technologyRaw: p.technology_raw ?? null,
      stages: parseJson(p.treatment_stages_json, null), capacityRaw: p.capacity_raw ?? null, capacityValue: p.capacity_value ?? null,
      capacityUnit: p.capacity_unit ?? null, capacityGallonType: p.capacity_gallon_type ?? null,
      collectionLimitRaw: p.collection_limit_raw ?? null, statusRaw: p.status_raw ?? null, status: p.status ?? null,
    },
  };
}

function csvFromRows(rows, { severity } = {}) {
  const want = severity ? new Set(String(severity).split(',').map((s) => s.trim())) : null;
  const out = [['row_number', 'plant_code', 'severity', 'field', 'code', 'message', 'original_value']];
  for (const r of rows) {
    const items = [
      ...r.errors.map((e) => ['error', e]),
      ...r.warnings.map((w) => [DATASET_WIDE.has(w.code) ? 'notice' : 'warning', w]),
    ];
    for (const [sev, it] of items) {
      if (want && !want.has(sev)) continue;
      out.push([r.rowNumber, r.plantCode ?? '', sev, it.field ?? '', it.code ?? '', it.message ?? '', it.value ?? '']);
    }
  }
  return '\uFEFF' + toCsv(out);
}

// ───────────────────────── public API ─────────────────────────
/** Store an upload, parse its sheets and suggest a column mapping. */
async function createBatch({ buffer, filename, userId = null, req = null, actorLabel = null }) {
  const name = safeFilename(filename);
  if (!Buffer.isBuffer(buffer)) throw new HttpError(400, 'file_required', 'No file was uploaded.');
  if (buffer.length > config.uploads.maxImportBytes) {
    throw new HttpError(413, 'file_too_large', `The file is larger than ${Math.round(config.uploads.maxImportBytes / 1048576)} MB.`);
  }
  const type = detectFileType(buffer, name);
  const { sheets } = await parseWorkbook(buffer, type, name);
  const hash = sha256Buf(buffer);
  const db = getDb();
  const now = nowIso();

  let fileRow = db.prepare("SELECT * FROM files WHERE kind = 'import_upload' AND sha256 = ? ORDER BY id DESC").get(hash);
  if (!fileRow || !fs.existsSync(path.join(config.uploadDir, fileRow.storage_path))) {
    const rel = path.posix.join('imports', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${hash.slice(0, 12)}.${type}`);
    fs.mkdirSync(path.join(config.uploadDir, 'imports'), { recursive: true });
    fs.writeFileSync(path.join(config.uploadDir, rel), buffer, { mode: 0o600 });
    const r = db.prepare(`INSERT INTO files (kind, storage_path, original_name, mime, size_bytes, sha256, uploaded_by_user, created_at)
                          VALUES ('import_upload', ?, ?, ?, ?, ?, ?, ?)`).run(rel, name, MIME[type], buffer.length, hash, userId, now);
    fileRow = { id: Number(r.lastInsertRowid) };
  }

  const sheetViews = sheets.map((s) => ({ name: s.name, rowCount: s.rowCount, headerRow: s.headerRow, headers: s.headers, suggestedColumns: suggestMapping(s.headers) }));
  const main = sheetViews.find((s) => s.rowCount > 0) || sheetViews.find((s) => s.headers.length);
  const suggestedMapping = { sheet: main.name, columns: main.suggestedColumns };
  const r = db.prepare(`INSERT INTO import_batches (file_id, source_filename, file_sha256, sheet_name, mapping_json, status, created_by, created_at)
                        VALUES (?, ?, ?, ?, ?, 'uploaded', ?, ?)`).run(fileRow.id, name, hash, main.name, JSON.stringify(suggestedMapping), userId, now);
  const batchId = Number(r.lastInsertRowid);
  parsedCache.set(batchId, { sha: hash, sheets });
  audit(req, { action: 'import.upload', entityType: 'import_batch', entityId: batchId, after: { filename: name, sha256: hash, sizeBytes: buffer.length, sheets: sheets.map((s) => s.name) }, actorLabel });
  const previous = db.prepare("SELECT id, committed_at FROM import_batches WHERE file_sha256 = ? AND status = 'committed' ORDER BY id DESC").get(hash);
  return {
    batchId, filename: name, sheets: sheetViews, suggestedMapping, targetFields: TARGET_FIELDS,
    previouslyCommitted: previous ? { batchId: previous.id, committedAt: previous.committed_at } : null,
  };
}

/** Validate every row with the given mapping, store import_rows, return the summary and a page of rows. */
async function previewBatch(batchId, { sheet, mapping, options = {}, page = 1, pageSize = 50, outcome } = {}) {
  const batch = getBatch(batchId);
  if (!['uploaded', 'previewed'].includes(batch.status)) throw new HttpError(409, 'batch_closed', `This import is already ${batch.status}.`);
  const sheets = await loadSheets(batch);
  const stored = parseJson(batch.mapping_json, {}) || {};
  const sheetName = sheet || stored.sheet || batch.sheet_name;
  const ws = sheets.find((s) => s.name === sheetName);
  if (!ws) throw new HttpError(400, 'unknown_sheet', `Sheet "${sheetName}" was not found in the workbook.`, { field: 'sheet' });
  const columns = validateMapping(mapping === undefined && sheetName === stored.sheet ? stored.columns : mapping, ws.headers);
  const updateExisting = !(options && (options.updateExisting === false || options.updateExisting === 'false'));
  const { rows, summary } = evaluateSheet(ws, columns, { sourceFile: batch.source_filename, updateExisting });
  summary.batchId = batch.id;

  const db = getDb();
  tx(() => {
    db.prepare('DELETE FROM duplicate_candidates WHERE import_row_id IN (SELECT id FROM import_rows WHERE batch_id = ?)').run(batch.id);
    db.prepare('DELETE FROM import_rows WHERE batch_id = ?').run(batch.id);
    const ins = db.prepare(`INSERT INTO import_rows (batch_id, row_number, raw_json, normalized_json, outcome, incomplete, errors_json, warnings_json, plant_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      const { errors, warnings, ...rest } = r.entry;
      ins.run(batch.id, r.rowNumber, JSON.stringify(r.raw), JSON.stringify({ ...rest, changes: r.changes, duplicateOfRow: r.duplicateOfRow }),
        r.outcome, r.entry.incomplete ? 1 : 0, JSON.stringify(errors), JSON.stringify(warnings), r.plantId);
    }
    db.prepare("UPDATE import_batches SET sheet_name = ?, mapping_json = ?, status = 'previewed', summary_json = ? WHERE id = ?")
      .run(ws.name, JSON.stringify({ sheet: ws.name, columns, options: { updateExisting } }), JSON.stringify(summary), batch.id);
  });
  const pageData = getRows(batch.id, { outcome, page, pageSize });
  return { batchId: batch.id, sheet: ws.name, mapping: columns, summary, rows: pageData.items, total: pageData.total, page: pageData.page, pageSize: pageData.pageSize };
}

function getRows(batchId, { outcome, page = 1, pageSize = 50 } = {}) {
  const batch = getBatch(batchId);
  const db = getDb();
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 50));
  const outcomes = ['new', 'update', 'unchanged', 'rejected', 'duplicate_review'];
  let where = 'batch_id = ?';
  const args = [batch.id];
  if (outcome === 'issues') where += " AND (errors_json != '[]' OR json_extract(normalized_json, '$.needsReview') = 1)";
  else if (outcome) {
    if (!outcomes.includes(outcome)) throw new HttpError(400, 'invalid_input', `outcome must be one of: ${outcomes.join(', ')}, issues`, { field: 'outcome' });
    where += ' AND outcome = ?';
    args.push(outcome);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM import_rows WHERE ${where}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM import_rows WHERE ${where} ORDER BY row_number LIMIT ? OFFSET ?`).all(...args, size, (pg - 1) * size).map(rowView);
  return { items, total, page: pg, pageSize: size };
}

function loadGeocoder() {
  try {
    const g = require('../lib/geocoder');
    return typeof g.geocodeAddress === 'function' ? g.geocodeAddress : null;
  } catch {
    return null;
  }
}

/** Interpret whatever the geocoder returns; only a usable, in-bounds point is accepted. */
function interpretGeocode(res) {
  if (!res) return null;
  if (res.available === false) return { unavailable: true };
  const list = Array.isArray(res) ? res : Array.isArray(res.results) ? res.results : [res];
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const cands = list.map((c) => ({ ...c, lat: num(c.lat ?? c.latitude), lng: num(c.lng ?? c.lon ?? c.longitude) }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && inBounds(c.lat, c.lng, 0));
  if (!cands.length) return null;
  const best = cands[0];
  // An area-level match (or a gazetteer centroid) is not a plant position: never store it as one (§0.4).
  const source = String(best.source || best.provider || res.provider || 'geocoder').slice(0, 100);
  if (best.precision === 'area' || best.kind === 'area' || best.kind === 'town' || source === 'gazetteer') return null;
  return {
    lat: best.lat, lng: best.lng, source, ref: best.ref ? String(best.ref).slice(0, 200) : null,
    label: best.label || best.displayName || best.display_name || null,
    ambiguous: res.ambiguous === true || (res.ambiguous !== false && cands.length > 1),
    approximate: best.approximate === true || (best.precision !== undefined && best.precision !== 'exact'),
  };
}

function applyGeocode(target, g, reasons) {
  Object.assign(target, {
    latitude: g.lat, longitude: g.lng, coord_status: 'geocoded_pending', coord_accuracy_m: null,
    coord_source: `Geocoded from address (${g.source})`,
    coord_note: `Address match awaiting administrator verification${g.label ? `: ${String(g.label).slice(0, 300)}` : ''}${g.ref ? ` (${g.ref})` : ''}.`,
    needs_review: 1,
  });
  reasons.add('geocoded_location_unverified');
  if (g.ambiguous) reasons.add('geocode_ambiguous');
  if (g.approximate) reasons.add('geocode_approximate');
}

const insertCache = new Map();
function insertRow(db, table, row) {
  const cols = Object.keys(row);
  const sig = `${table}:${cols.join(',')}`;
  let stmt = insertCache.get(sig);
  if (!stmt || insertCache.db !== db) {
    if (insertCache.db !== db) { insertCache.clear(); insertCache.db = db; }
    stmt = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    insertCache.set(sig, stmt);
  }
  return Number(stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c]))).lastInsertRowid);
}

function makeAreaLinker(db, now) {
  const ins = db.prepare("INSERT OR IGNORE INTO areas (area_key, kind, name, town, geocode_status, updated_at) VALUES (?, 'area', ?, ?, 'not_attempted', ?)");
  const sel = db.prepare('SELECT id FROM areas WHERE area_key = ?');
  const cache = new Map();
  return (name, town) => {
    if (!name || !town) return null;
    const key = areaKey(name, town);
    if (!cache.has(key)) { ins.run(key, name, town, now); cache.set(key, sel.get(key).id); }
    return cache.get(key);
  };
}

function addExtras(db, plantId, entry, { userId, now, sourceFile, sheet, rowNumber }) {
  let tests = 0;
  for (const t of entry.tests || []) {
    if (db.prepare('SELECT id FROM water_tests WHERE plant_id = ? AND sample_date = ? AND IFNULL(laboratory, \'\') = ?').get(plantId, t.sampleDate, t.laboratory || '')) continue;
    const testId = insertRow(db, 'water_tests', {
      plant_id: plantId, sample_date: t.sampleDate, laboratory: t.laboratory,
      source_description: `Imported from '${sourceFile}', sheet '${sheet}', row ${rowNumber}. No standard was given, so results are not assessed.`,
      outcome: 'not_assessed', published: 1, created_by: userId, created_at: now,
    });
    for (const res of t.results) {
      insertRow(db, 'water_test_results', { test_id: testId, parameter: res.parameter, value_text: res.valueText, value_num: res.valueNum, unit: res.unit, limit_text: null, within_limit: null });
    }
    tests++;
  }
  for (const s of entry.sources || []) {
    if (db.prepare('SELECT id FROM plant_sources WHERE plant_id = ? AND url = ?').get(plantId, s.url)) continue;
    insertRow(db, 'plant_sources', { plant_id: plantId, title: s.title, url: s.url, note: `From '${sourceFile}', row ${rowNumber}.`, added_by: userId, created_at: now });
  }
  return tests;
}

/** Insert one normalised entry as a new plant (used by commit and by duplicate keep_separate). */
function insertEntry(db, entry, { code, batchId, now, linkArea, geocode = null, extraReasons = [] }) {
  const row = { ...entry.plant, plant_code: code, import_batch_id: batchId, imported_at: now, created_at: now, updated_at: now };
  row.area_id = linkArea(row.area_name, row.town);
  const reasons = new Set([...entry.issues, ...extraReasons]);
  if (geocode) applyGeocode(row, geocode, reasons);
  row.review_reasons_json = JSON.stringify([...reasons]);
  row.needs_review = row.needs_review || [...reasons].some((c) => !DATASET_WIDE.has(c)) ? 1 : 0;
  return insertRow(db, 'plants', row);
}

/** Apply a previewed batch in one transaction. */
async function commitBatch(batchId, { userId = null, req = null, actorLabel = null, geocoder } = {}) {
  const batch = getBatch(batchId);
  if (batch.status === 'uploaded') throw new HttpError(409, 'not_previewed', 'Preview the import before committing it.');
  if (batch.status !== 'previewed') throw new HttpError(409, 'batch_closed', `This import is already ${batch.status}.`);
  const db = getDb();
  const mappingInfo = parseJson(batch.mapping_json, {}) || {};
  const updateExisting = !(mappingInfo.options && mappingInfo.options.updateExisting === false);
  const actor = req && req.user ? req.user.id : userId;
  const rows = db.prepare('SELECT * FROM import_rows WHERE batch_id = ? ORDER BY row_number').all(batch.id)
    .map((r) => ({ ...r, entry: { ...parseJson(r.normalized_json, {}), errors: parseJson(r.errors_json, []), warnings: parseJson(r.warnings_json, []) } }));

  // 1. Plan against the current database (it may have changed since the preview).
  const existingByCode = new Map(db.prepare('SELECT * FROM plants').all().map((p) => [p.plant_code, p]));
  const plan = rows.map((r) => {
    if (r.outcome === 'rejected' || r.outcome === 'duplicate_review') return { r, action: r.outcome };
    const existing = existingByCode.get(r.entry.code);
    if (!existing) return { r, action: 'new' };
    const m = mergeForUpdate(existing, r.entry);
    return { r, action: 'update', existing, merge: m };
  });

  // 2. Optional address geocoding (outside the transaction; results stay hidden until an administrator verifies them).
  const geocodeAddress = geocoder === undefined ? loadGeocoder() : geocoder;
  let geocodeCalls = 0, geocoderDown = false;
  const geocodeDeadline = Date.now() + GEOCODE_BUDGET_MS;
  if (geocodeAddress) {
    for (const p of plan) {
      const g = p.r.entry.geocode;
      if (!g || geocoderDown || geocodeCalls >= MAX_GEOCODE_PER_COMMIT || Date.now() > geocodeDeadline) continue;
      if (p.action === 'update' && (p.merge.exact || ['verified', 'geocoded_pending'].includes(p.existing.coord_status))) continue;
      if (p.action !== 'new' && p.action !== 'update') continue;
      geocodeCalls++;
      try {
        const res = interpretGeocode(await geocodeAddress(g.address, { town: g.town }));
        if (res && res.unavailable) geocoderDown = true;
        else if (res) p.geocode = res;
      } catch {
        geocoderDown = true;
      }
    }
  }

  // 3. Apply everything atomically.
  const now = nowIso();
  const summary = tx(() => {
    const linkArea = makeAreaLinker(db, now);
    const ctxFor = (r) => ({ userId: actor, now, sourceFile: batch.source_filename, sheet: batch.sheet_name, rowNumber: r.row_number });
    const setRow = db.prepare('UPDATE import_rows SET outcome = ?, plant_id = ?, incomplete = ? WHERE id = ?');
    const counts = { geocoded: 0, testsAdded: 0 };
    const finalRows = [];
    for (const p of plan) {
      const { r } = p;
      const entry = r.entry;
      if (p.action === 'rejected' || p.action === 'duplicate_review') { finalRows.push({ outcome: r.outcome, entry }); continue; }
      if (p.action === 'new') {
        const id = insertEntry(db, entry, { code: entry.code, batchId: batch.id, now, linkArea, geocode: p.geocode });
        if (p.geocode) counts.geocoded++;
        counts.testsAdded += addExtras(db, id, entry, ctxFor(r));
        audit(req, { action: 'plant.import_create', entityType: 'plant', entityId: entry.code, after: { batchId: batch.id, sourceFile: batch.source_filename, sheet: batch.sheet_name, row: r.row_number }, actorLabel });
        setRow.run('new', id, entry.incomplete ? 1 : 0, r.id);
        finalRows.push({ outcome: 'new', entry });
        continue;
      }
      // Existing plant
      const { existing, merge } = p;
      const set = { ...merge.set };
      if ('area_raw' in set || 'town' in set) {
        const areaId = linkArea(set.area_name !== undefined ? set.area_name : existing.area_name, set.town !== undefined ? set.town : existing.town);
        if (!same(areaId, existing.area_id)) set.area_id = areaId;
      }
      if (p.geocode) {
        const reasons = new Set(parseJson(set.review_reasons_json, []));
        applyGeocode(set, p.geocode, reasons);
        set.review_reasons_json = JSON.stringify([...reasons]);
        counts.geocoded++;
      }
      let changes = merge.changes.slice();
      if ('area_id' in set) changes.push({ field: 'area_id', before: existing.area_id, after: set.area_id });
      if (p.geocode) changes.push({ field: 'latitude', before: existing.latitude, after: set.latitude });
      changes = [...changes, ...pendingExtras(db, existing.id, entry)];
      const incomplete = !(isExact(set.coord_status ?? existing.coord_status, set.latitude !== undefined ? set.latitude : existing.latitude, set.longitude !== undefined ? set.longitude : existing.longitude) && (set.name ?? existing.name));
      if (!changes.length || !updateExisting) {
        setRow.run('unchanged', existing.id, incomplete ? 1 : 0, r.id);
        finalRows.push({ outcome: 'unchanged', entry: { ...entry, incomplete } });
        continue;
      }
      Object.assign(set, { import_batch_id: batch.id, imported_at: now, updated_at: now });
      const cols = Object.keys(set);
      db.prepare(`UPDATE plants SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c] ?? null), existing.id);
      counts.testsAdded += addExtras(db, existing.id, entry, ctxFor(r));
      const before = {}, after = {};
      for (const c of changes) { before[c.field] = c.before; after[c.field] = c.after; }
      audit(req, { action: 'plant.import_update', entityType: 'plant', entityId: existing.plant_code, before, after, reason: `Import batch ${batch.id} (${batch.source_filename}, row ${r.row_number})`, actorLabel });
      setRow.run('update', existing.id, incomplete ? 1 : 0, r.id);
      finalRows.push({ outcome: 'update', entry: { ...entry, incomplete } });
    }

    // In-file duplicate codes -> review queue (not imported)
    const findPlant = db.prepare('SELECT id FROM plants WHERE plant_code = ?');
    const openSame = db.prepare(`SELECT dc.id FROM duplicate_candidates dc JOIN import_rows ir ON ir.id = dc.import_row_id
                                 WHERE dc.status = 'open' AND dc.reason = 'duplicate_plant_code' AND dc.plant_id IS ? AND ir.raw_json = ?`);
    const insCand = db.prepare(`INSERT INTO duplicate_candidates (batch_id, import_row_id, plant_id, other_plant_id, reason, score, status)
                                VALUES (?, ?, ?, ?, ?, ?, 'open')`);
    for (const p of plan) {
      if (p.action !== 'duplicate_review') continue;
      const target = findPlant.get(p.r.entry.code);
      const targetId = target ? target.id : null;
      if (openSame.get(targetId, p.r.raw_json)) continue;
      insCand.run(batch.id, p.r.id, targetId, null, 'duplicate_plant_code', 1);
    }

    // Likely duplicates under different codes (named plants only)
    const all = db.prepare('SELECT id, plant_code, name, area_name, town, latitude, longitude, coord_status, is_demo FROM plants WHERE name IS NOT NULL').all();
    const touched = new Set(finalRows.filter((f) => f.outcome !== 'rejected' && f.outcome !== 'duplicate_review').map((f) => f.entry.code));
    const idByCode = new Map(all.map((p) => [p.plant_code, p.id]));
    const subjects = all.filter((p) => touched.has(p.plant_code)).map(plantDupView);
    const others = all.filter((p) => !touched.has(p.plant_code) && !p.is_demo).map(plantDupView);
    const pairExists = db.prepare(`SELECT id FROM duplicate_candidates WHERE (plant_id = ? AND other_plant_id = ?) OR (plant_id = ? AND other_plant_id = ?)`);
    let likely = 0;
    for (const pair of findLikelyDuplicates(subjects, others)) {
      const a = idByCode.get(pair.a), b = idByCode.get(pair.b);
      if (!a || !b || pairExists.get(a, b, b, a)) continue;
      insCand.run(batch.id, null, a, b, pair.reason, pair.score);
      likely++;
    }

    const s = summarise(finalRows.map((f) => ({ outcome: f.outcome, entry: f.entry })), { sourceFile: batch.source_filename, sheet: batch.sheet_name, batchId: batch.id, importedAt: now });
    s.likelyDuplicates = likely;
    s.geocoded = counts.geocoded;
    s.waterTestsAdded = counts.testsAdded;
    db.prepare("UPDATE import_batches SET status = 'committed', committed_at = ?, summary_json = ? WHERE id = ?").run(now, JSON.stringify(s), batch.id);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_import', JSON.stringify({ batchId: batch.id, sourceFile: batch.source_filename, sheet: batch.sheet_name, importedAt: now }));
    audit(req, { action: 'import.commit', entityType: 'import_batch', entityId: batch.id, after: s, actorLabel });
    return s;
  });
  return summary;
}

function cancelBatch(batchId, { req = null, actorLabel = null } = {}) {
  const batch = getBatch(batchId);
  if (!['uploaded', 'previewed'].includes(batch.status)) throw new HttpError(409, 'batch_closed', `This import is already ${batch.status}.`);
  getDb().prepare("UPDATE import_batches SET status = 'cancelled' WHERE id = ?").run(batch.id);
  parsedCache.delete(batch.id);
  audit(req, { action: 'import.cancel', entityType: 'import_batch', entityId: batch.id, before: { status: batch.status }, after: { status: 'cancelled' }, actorLabel });
  return { batchId: batch.id, status: 'cancelled' };
}

/** CSV of every error and warning in a batch (severity: error | warning | notice for dataset-wide limitations). */
function errorsCsv(batchId, opts = {}) {
  const batch = getBatch(batchId);
  const rows = getDb().prepare('SELECT * FROM import_rows WHERE batch_id = ? ORDER BY row_number').all(batch.id).map(rowView);
  return csvFromRows(rows, opts);
}

function listBatches({ page = 1, pageSize = 25 } = {}) {
  const db = getDb();
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const total = db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n;
  const items = db.prepare(`SELECT b.*, u.username FROM import_batches b LEFT JOIN admin_users u ON u.id = b.created_by
                            ORDER BY b.id DESC LIMIT ? OFFSET ?`).all(size, (pg - 1) * size).map(batchView);
  return { items, total, page: pg, pageSize: size };
}

function batchView(b) {
  return {
    id: b.id, filename: b.source_filename, sha256: b.file_sha256, sheet: b.sheet_name, status: b.status,
    mapping: parseJson(b.mapping_json, null), summary: parseJson(b.summary_json, null),
    createdAt: b.created_at, committedAt: b.committed_at, createdBy: b.username ?? null,
  };
}

async function getBatchDetail(batchId) {
  const b = getDb().prepare('SELECT b.*, u.username FROM import_batches b LEFT JOIN admin_users u ON u.id = b.created_by WHERE b.id = ?').get(getBatch(batchId).id);
  const view = batchView(b);
  try {
    view.sheets = (await loadSheets(b)).map((s) => ({ name: s.name, rowCount: s.rowCount, headerRow: s.headerRow, headers: s.headers, suggestedColumns: suggestMapping(s.headers) }));
  } catch {
    view.sheets = null;
  }
  view.targetFields = TARGET_FIELDS;
  return view;
}

/**
 * End-to-end import of a file on disk (CLI and `npm run setup`). With dryRun, nothing is written to the database and
 * the result also carries `errorsCsv`.
 */
async function importFromFile({ filePath, sheet, mapping, actorLabel = 'cli', updateExisting = true, dryRun = false, userId = null, geocoder } = {}) {
  const buffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  if (dryRun) {
    if (buffer.length > config.uploads.maxImportBytes) throw new HttpError(413, 'file_too_large', 'The file is too large.');
    const { sheets } = await parseWorkbook(buffer, detectFileType(buffer, filename), filename);
    const ws = sheet ? sheets.find((s) => s.name === sheet) : sheets.find((s) => s.rowCount > 0) || sheets[0];
    if (!ws) throw new HttpError(400, 'unknown_sheet', `Sheet "${sheet}" was not found in the workbook.`);
    const { rows, summary } = evaluateSheet(ws, validateMapping(mapping, ws.headers), { sourceFile: filename, updateExisting });
    const views = rows.map((r) => ({ rowNumber: r.rowNumber, plantCode: r.entry.code, errors: r.entry.errors, warnings: r.entry.warnings }));
    return { ...summary, dryRun: true, errorsCsv: csvFromRows(views) };
  }
  const created = await createBatch({ buffer, filename, userId, actorLabel });
  const target = sheet ? created.sheets.find((s) => s.name === sheet) : created.sheets.find((s) => s.name === created.suggestedMapping.sheet);
  if (!target) {
    cancelBatch(created.batchId, { actorLabel });
    throw new HttpError(400, 'unknown_sheet', `Sheet "${sheet}" was not found in the workbook.`);
  }
  try {
    await previewBatch(created.batchId, { sheet: target.name, mapping: mapping || target.suggestedColumns, options: { updateExisting } });
  } catch (err) {
    cancelBatch(created.batchId, { actorLabel });
    throw err;
  }
  return commitBatch(created.batchId, { userId, actorLabel, geocoder });
}

module.exports = {
  createBatch, previewBatch, commitBatch, cancelBatch, errorsCsv, importFromFile, getRows, listBatches, getBatchDetail,
  // exported for the duplicates workflow and tests
  insertEntry, addExtras, makeAreaLinker, mergeForUpdate, findLikelyDuplicates, validateMapping, interpretGeocode, rowView, haversineM,
  TARGET_FIELDS, DATA_ISSUES,
};
