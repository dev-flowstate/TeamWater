'use strict';
// Admin API — plants & areas (docs/ARCHITECTURE.md §7 "Plants & areas").
//   GET    /api/admin/plants                     plants:read   list + filters
//   GET    /api/admin/plants/:code               plants:read   full admin view
//   POST   /api/admin/plants                     plants:write  create        { code, town?, areaRaw?, ...fields, reason }
//   PATCH  /api/admin/plants/:code               plants:write  edit fields   { ...fields, reason }
//   POST   /api/admin/plants/:code/coordinates   plants:write  { lat, lng, note } | { clear: true, reason }
//   POST   /api/admin/plants/:code/status        plants:status { status, assessment(≥20), evidenceReportIds?, investigationId?, verified? }
//   POST   /api/admin/plants/:code/verify        plants:write  { verifiedAt: 'YYYY-MM-DD', note }
//   POST   /api/admin/plants/:code/tests         tests:write   multipart (see below)
//   DELETE /api/admin/tests/:id                  tests:write   { reason }
//   POST   /api/admin/plants/:code/sources       plants:write  { title, url?, note?, reason }
//   GET    /api/admin/areas                      plants:read
//   PATCH  /api/admin/areas/:id                  areas:write   { latitude, longitude, radiusM, nameUr, aliases, reason }
// Every mutation requires a reason (for coordinates / verify / tests / sources the `note` / `notes` field is
// accepted as the reason; for status it is the `assessment`), is audited with a diff, and bumps updated_at.
// The source traceability columns (source_*, import_batch_id, imported_at, plant_code) can never be edited here.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { getDb, tx, plain, parseJson } = require('../lib/db');
const { HttpError, validate, str, num, int, oneOf, bool, date, paginate } = require('../lib/http');
const { requirePermission } = require('../lib/auth');
const { audit, diff } = require('../lib/audit');
const { nowIso, karachiParts } = require('../lib/time');
const { randomToken, sha256 } = require('../lib/crypto');
const { parseAreaRaw, areaKey } = require('../lib/text');
const { inBounds } = require('../lib/geo');
const { validateHours, HoursError } = require('../lib/hours');
const {
  toSummary, loadAggregates, areaFor, isAreaUsable, waterTestsFor, reportsSummary, dataIssues, stagesForTechnology,
} = require('../lib/plant-view');

const router = express.Router();

const STATUSES = ['operational', 'temporarily_closed', 'permanently_closed', 'decommissioned', 'unknown'];
const OUTCOMES = ['met_limits', 'issue_detected', 'not_assessed'];
const GALLON_TYPES = ['unspecified', 'us', 'imperial', 'not_applicable'];
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const EXACT_SQL = "p.coord_status IN ('source','verified') AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL";

const fail = (field, message, code = 'invalid_input') => { throw new HttpError(400, code, `${field}: ${message}`, { field }); };
const todayKarachi = () => karachiParts(new Date()).date;

/** First non-blank of the given body keys, validated as the audit reason. */
function reasonFrom(body, keys = ['reason'], { min = 3, max = 1000 } = {}) {
  const src = body || {};
  const key = keys.find((k) => typeof src[k] === 'string' && src[k].trim()) || keys[0];
  return str({ min, max })(src[key], 'reason');
}

function loadPlant(code) {
  const c = String(code || '').trim().toUpperCase();
  const row = CODE_RE.test(c) ? getDb().prepare('SELECT * FROM plants WHERE plant_code = ?').get(c) : null;
  if (!row) throw new HttpError(404, 'not_found', 'Plant not found.');
  return row;
}

const auditView = (row) => require('./admin-system').auditEntryView(row);

// ── Views ──
function areaAdminView(a) {
  return {
    id: a.id, areaKey: a.area_key, kind: a.kind, name: a.name, town: a.town, nameUr: a.name_ur,
    aliases: parseJson(a.aliases_json, []), latitude: a.latitude, longitude: a.longitude, radiusM: a.radius_m,
    geocodeStatus: a.geocode_status, geocodeSource: a.geocode_source, geocodeRef: a.geocode_ref, geocodeNote: a.geocode_note,
    reviewedBy: a.reviewed_by, reviewedAt: a.reviewed_at, updatedAt: a.updated_at, usable: isAreaUsable(a),
  };
}

function adminListItem(row, area, agg) {
  return {
    id: row.id,
    ...toSummary(row, area, { aggregates: agg }),
    coordSource: row.coord_source ?? null,
    needsReview: row.needs_review === 1,
    reviewReasons: dataIssues(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function adminDetail(row) {
  const db = getDb();
  const area = areaFor(row);
  const statusHistory = db.prepare(`SELECT h.*, u.username FROM plant_status_history h LEFT JOIN admin_users u ON u.id = h.actor_user_id
                                    WHERE h.plant_id = ? ORDER BY h.created_at DESC, h.id DESC`).all(row.id)
    .map((h) => ({
      id: h.id, oldStatus: h.old_status, newStatus: h.new_status, assessment: h.assessment,
      evidenceReportIds: parseJson(h.evidence_report_ids_json, []), investigationId: h.investigation_id,
      actor: { id: h.actor_user_id, username: h.username ?? null }, createdAt: h.created_at,
    }));
  const sources = db.prepare(`SELECT s.*, u.username FROM plant_sources s LEFT JOIN admin_users u ON u.id = s.added_by
                              WHERE s.plant_id = ? ORDER BY s.created_at, s.id`).all(row.id)
    .map((s) => ({ id: s.id, title: s.title, url: s.url, fileId: s.file_id, note: s.note, addedBy: s.username ?? null, createdAt: s.created_at }));
  const auditRows = db.prepare(`SELECT * FROM audit_log WHERE entity_type = 'plant' AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`).all(row.plant_code);
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM reports WHERE plant_id = ? GROUP BY status').all(row.id).map((r) => [r.status, r.n]));
  const reviewQueue = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE plant_id = ? AND review_queue = 1 AND status IN ('pending','under_review','needs_clarification')").get(row.id).n;
  return {
    plant: plain(row),
    summary: toSummary(row, area),
    area: area ? areaAdminView(area) : null,
    sourceValues: parseJson(row.source_values_json, null),
    traceability: {
      sourceFile: row.source_file ?? null, sheet: row.source_sheet ?? null, row: row.source_row ?? null,
      importBatchId: row.import_batch_id ?? null, importedAt: row.imported_at ?? null,
    },
    statusHistory,
    waterTests: waterTestsFor(row.id, { includeUnpublished: true }),
    sources,
    audit: auditRows.map(auditView),
    reportCounts: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, reviewQueue },
    reportsSummary: reportsSummary(row.id),
  };
}

function usableAreaIdsJson() {
  return JSON.stringify(getDb().prepare('SELECT * FROM areas').all().filter(isAreaUsable).map((a) => a.id));
}

// ── GET /plants ──
router.get('/plants', requirePermission('plants:read'), (req, res) => {
  const v = validate(req.query, {
    q: str({ max: 200, optional: true }),
    town: str({ max: 200, optional: true }),
    coord: oneOf(['missing', 'exact', 'area', 'pending'], { optional: true }),
    status: oneOf(STATUSES, { optional: true }),
    needsReview: bool({ optional: true }),
    demo: bool({ optional: true }),
  });
  const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
  const where = ['1 = 1'];
  const params = [];
  if (v.q) {
    const like = `%${v.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(p.plant_code LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.area_raw LIKE ? ESCAPE '\\' OR p.town LIKE ? ESCAPE '\\' OR p.address LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like);
  }
  if (v.town) { where.push('p.town = ? COLLATE NOCASE'); params.push(v.town); }
  if (v.status) { where.push('p.status = ?'); params.push(v.status); }
  if (v.needsReview !== null) { where.push('p.needs_review = ?'); params.push(v.needsReview ? 1 : 0); }
  if (v.demo !== null) { where.push('p.is_demo = ?'); params.push(v.demo ? 1 : 0); }
  if (v.coord === 'missing') where.push("p.coord_status = 'missing'");
  if (v.coord === 'pending') where.push("p.coord_status = 'geocoded_pending'");
  if (v.coord === 'exact') where.push(`(${EXACT_SQL})`);
  if (v.coord === 'area') { where.push(`NOT (${EXACT_SQL}) AND p.area_id IN (SELECT value FROM json_each(?))`); params.push(usableAreaIdsJson()); }
  const db = getDb();
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM plants p WHERE ${w}`).get(...params).n;
  const rows = db.prepare(`SELECT p.* FROM plants p WHERE ${w} ORDER BY p.plant_code LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const areas = new Map(db.prepare('SELECT * FROM areas').all().map((a) => [a.id, a]));
  const agg = loadAggregates(rows.map((r) => r.id));
  res.json({ items: rows.map((r) => adminListItem(r, areas.get(r.area_id) || null, agg)), total, page, pageSize });
});

// ── GET /plants/:code ──
router.get('/plants/:code', requirePermission('plants:read'), (req, res) => {
  res.json(adminDetail(loadPlant(req.params.code)));
});

// ── Editable fields (PATCH / POST) ──
const optText = (max) => str({ max, optional: true });
function hoursField(v, f) {
  try {
    const h = validateHours(v);
    return h ? JSON.stringify(h) : null;
  } catch (err) {
    if (err instanceof HoursError) fail(f, err.message);
    throw err;
  }
}
function reviewReasonsField(v, f) {
  let arr = v;
  if (arr === null || arr === undefined || arr === '') return '[]';
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { fail(f, 'must be a JSON list of strings'); } }
  if (!Array.isArray(arr) || arr.length > 50) fail(f, 'must be a list of at most 50 strings');
  const out = arr.map((r) => {
    if (typeof r !== 'string' || !r.trim() || r.length > 200) fail(f, 'each reason must be a non-empty string (≤200 characters)');
    return r.trim();
  });
  return JSON.stringify(out);
}
const phoneField = (v, f) => {
  const s = str({ max: 40, optional: true })(v, f);
  if (s !== null && !/^[+0-9 ()\-/]{5,40}$/.test(s)) fail(f, 'must contain only digits, spaces, +, -, ( ) or /');
  return s;
};

const EDITABLE = {
  name: optText(300),
  address: optText(500),
  neighborhood: optText(200),
  landmark: optText(300),
  operator_name: optText(200),
  operator_type: optText(200),
  water_source: optText(200),
  technology_raw: optText(200),
  capacity_gallon_type: oneOf(GALLON_TYPES),
  collection_limit_raw: optText(200),
  collection_limit_value: num({ min: 0, max: 1e7, optional: true }),
  collection_limit_unit: oneOf(['litres', 'gallons'], { optional: true }),
  collection_limit_period: oneOf(['per_visit', 'per_day'], { optional: true }),
  opening_hours_text: optText(500),
  opening_hours_json: hoursField,
  public_phone: phoneField,
  public_contact_note: optText(500),
  accessibility: optText(500),
  needs_review: (v, f) => (bool()(v, f) ? 1 : 0),
  review_reasons_json: reviewReasonsField,
};
// camelCase aliases accepted from the Admin UI.
const ALIASES = { openingHours: 'opening_hours_json', openingHoursJson: 'opening_hours_json', reviewReasons: 'review_reasons_json', gallonType: 'capacity_gallon_type' };
const toSnake = (k) => ALIASES[k] || k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const NOT_FIELDS = new Set(['reason']);

/** Validates the editable subset of a body. Unknown / protected keys are rejected explicitly. */
function editableChanges(body, { extraAllowed = [] } = {}) {
  const changes = {};
  const rejected = [];
  for (const [key, value] of Object.entries(body || {})) {
    if (NOT_FIELDS.has(key) || extraAllowed.includes(key)) continue;
    const col = toSnake(key);
    if (!Object.hasOwn(EDITABLE, col)) { rejected.push(key); continue; }
    if (Object.hasOwn(changes, col)) fail(key, 'given twice');
    changes[col] = EDITABLE[col](value, key);
  }
  if (rejected.length) {
    throw new HttpError(400, 'field_not_editable', `These fields cannot be edited here: ${rejected.join(', ')}`, { field: rejected[0], fields: rejected });
  }
  const warnings = [];
  if (Object.hasOwn(changes, 'technology_raw')) {
    const { stages, recognised } = stagesForTechnology(changes.technology_raw);
    changes.treatment_stages_json = JSON.stringify(stages);
    if (!recognised && changes.technology_raw) warnings.push('technology_unrecognised: no treatment stages inferred');
  }
  return { changes, warnings };
}

// ── POST /plants ──
router.post('/plants', requirePermission('plants:write'), (req, res) => {
  const body = req.body || {};
  const reason = reasonFrom(body);
  const code = str({ max: 40 })(body.code ?? body.plantCode ?? body.plant_code, 'code').toUpperCase();
  if (!CODE_RE.test(code)) fail('code', 'must be 3–40 letters, digits, - or _');
  if (code.startsWith('DEMO-')) fail('code', 'the DEMO- prefix is reserved for demonstration data');
  const town = optText(200)(body.town, 'town');
  const areaRaw = optText(300)(body.areaRaw ?? body.area_raw, 'areaRaw');
  const { changes, warnings } = editableChanges(body, { extraAllowed: ['code', 'plantCode', 'plant_code', 'town', 'areaRaw', 'area_raw'] });
  const db = getDb();
  if (db.prepare('SELECT 1 FROM plants WHERE plant_code = ?').get(code)) throw new HttpError(409, 'conflict', 'A plant with this code already exists.', { field: 'code' });

  const parsed = parseAreaRaw(areaRaw);
  const area = parsed.name && town ? db.prepare('SELECT id FROM areas WHERE area_key = ?').get(areaKey(parsed.name, town)) : null;
  const now = nowIso();
  const row = {
    plant_code: code, town, area_raw: areaRaw, area_name: parsed.name, area_sector: parsed.sector, area_id: area ? area.id : null,
    status: 'unknown', status_source: 'none', coord_status: 'missing', ...changes, created_at: now, updated_at: now,
  };
  const cols = Object.keys(row);
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO plants (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
    const { created_at: _c, updated_at: _u, ...after } = row;
    audit(req, { action: 'plant.create', entityType: 'plant', entityId: code, after, reason });
    return Number(r.lastInsertRowid);
  });
  res.status(201).json({ ...adminDetail(db.prepare('SELECT * FROM plants WHERE id = ?').get(id)), warnings });
});

// ── PATCH /plants/:code ──
router.patch('/plants/:code', requirePermission('plants:write'), (req, res) => {
  const row = loadPlant(req.params.code);
  const reason = reasonFrom(req.body);
  const { changes, warnings } = editableChanges(req.body);
  if (!Object.keys(changes).length) fail('fields', 'nothing to change');
  const before = Object.fromEntries(Object.keys(changes).map((k) => [k, row[k] ?? null]));
  const d = diff(before, changes);
  if (d.changed.length) {
    const now = nowIso();
    tx(() => {
      getDb().prepare(`UPDATE plants SET ${d.changed.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...d.changed.map((c) => changes[c]), now, row.id);
      audit(req, { action: 'plant.update', entityType: 'plant', entityId: row.plant_code, before: d.before, after: d.after, reason });
    });
  }
  res.json({ ...adminDetail(getDb().prepare('SELECT * FROM plants WHERE id = ?').get(row.id)), changed: d.changed, warnings });
});

// ── POST /plants/:code/coordinates ──
router.post('/plants/:code/coordinates', requirePermission('plants:write'), (req, res) => {
  const row = loadPlant(req.params.code);
  const body = req.body || {};
  const clear = body.clear === true || body.clear === 'true' || body.clear === 1 || body.clear === '1';
  const reason = reasonFrom(body, ['reason', 'note']);
  let next;
  if (clear) {
    next = { latitude: null, longitude: null, coord_status: 'missing', coord_source: null, coord_accuracy_m: null, coord_note: reason };
  } else {
    const v = validate(body, { lat: num({ min: -90, max: 90 }), lng: num({ min: -180, max: 180 }), accuracyM: num({ min: 0, max: 10000, optional: true }) });
    if (!inBounds(v.lat, v.lng)) throw new HttpError(400, 'out_of_bounds', 'The position is outside the Faisalabad service area.', { field: 'lat' });
    next = { latitude: v.lat, longitude: v.lng, coord_status: 'verified', coord_source: 'admin map pin', coord_accuracy_m: v.accuracyM, coord_note: reason };
  }
  const before = Object.fromEntries(Object.keys(next).map((k) => [k, row[k] ?? null]));
  const d = diff(before, next);
  tx(() => {
    getDb().prepare(`UPDATE plants SET ${Object.keys(next).map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(next), nowIso(), row.id);
    audit(req, { action: clear ? 'plant.coordinates.clear' : 'plant.coordinates.set', entityType: 'plant', entityId: row.plant_code, before: d.before, after: d.after, reason });
  });
  res.json(adminDetail(getDb().prepare('SELECT * FROM plants WHERE id = ?').get(row.id)));
});

// ── POST /plants/:code/status ──
function idList(v, f) {
  if (v === undefined || v === null || v === '') return [];
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { fail(f, 'must be a list of report ids'); } }
  if (!Array.isArray(arr) || arr.length > 200) fail(f, 'must be a list of at most 200 report ids');
  const ids = arr.map((x) => Number(x));
  if (ids.some((n) => !Number.isInteger(n) || n < 1)) fail(f, 'must contain whole-number ids');
  return [...new Set(ids)];
}

router.post('/plants/:code/status', requirePermission('plants:status'), (req, res) => {
  const row = loadPlant(req.params.code);
  const v = validate(req.body, {
    status: oneOf(STATUSES),
    assessment: str({ min: 20, max: 5000 }),
    evidenceReportIds: idList,
    investigationId: int({ min: 1, optional: true }),
    verified: bool({ optional: true }),
    publicNote: str({ max: 500, optional: true }),
  });
  const db = getDb();
  if (v.evidenceReportIds.length) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE plant_id = ? AND id IN (SELECT value FROM json_each(?))')
      .get(row.id, JSON.stringify(v.evidenceReportIds)).n;
    if (n !== v.evidenceReportIds.length) fail('evidenceReportIds', 'every report must exist and belong to this plant');
  }
  if (v.investigationId !== null && !db.prepare('SELECT 1 FROM investigations WHERE id = ? AND plant_id = ?').get(v.investigationId, row.id)) {
    fail('investigationId', 'investigation not found for this plant');
  }
  const now = nowIso();
  const next = {
    status: v.status,
    status_source: v.verified ? 'admin_verified' : 'admin',
    status_updated_at: now,
    status_note: v.publicNote,
    ...(v.verified ? { last_verified_at: todayKarachi(), last_verified_by: req.user.id } : {}),
  };
  const before = Object.fromEntries(Object.keys(next).map((k) => [k, row[k] ?? null]));
  const d = diff(before, next);
  const historyId = tx(() => {
    const h = db.prepare(`INSERT INTO plant_status_history (plant_id, old_status, new_status, assessment, evidence_report_ids_json, investigation_id, actor_user_id, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.status, v.status, v.assessment, JSON.stringify(v.evidenceReportIds), v.investigationId, req.user.id, now);
    db.prepare(`UPDATE plants SET ${Object.keys(next).map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...Object.values(next), now, row.id);
    audit(req, {
      action: 'plant.status', entityType: 'plant', entityId: row.plant_code, before: d.before,
      after: { ...d.after, evidenceReportIds: v.evidenceReportIds, investigationId: v.investigationId }, reason: v.assessment,
    });
    return Number(h.lastInsertRowid);
  });
  res.json({ ...adminDetail(db.prepare('SELECT * FROM plants WHERE id = ?').get(row.id)), historyId });
});

// ── POST /plants/:code/verify ──
router.post('/plants/:code/verify', requirePermission('plants:write'), (req, res) => {
  const row = loadPlant(req.params.code);
  const v = validate(req.body, { verifiedAt: date() });
  const reason = reasonFrom(req.body, ['note', 'reason']);
  if (v.verifiedAt > todayKarachi()) fail('verifiedAt', 'cannot be in the future');
  if (v.verifiedAt < '2000-01-01') fail('verifiedAt', 'is too far in the past');
  const next = { last_verified_at: v.verifiedAt, last_verified_by: req.user.id, verification_note: reason };
  const before = Object.fromEntries(Object.keys(next).map((k) => [k, row[k] ?? null]));
  const d = diff(before, next);
  tx(() => {
    getDb().prepare('UPDATE plants SET last_verified_at = ?, last_verified_by = ?, verification_note = ?, updated_at = ? WHERE id = ?')
      .run(v.verifiedAt, req.user.id, reason, nowIso(), row.id);
    audit(req, { action: 'plant.verify', entityType: 'plant', entityId: row.plant_code, before: d.before, after: d.after, reason });
  });
  res.json(adminDetail(getDb().prepare('SELECT * FROM plants WHERE id = ?').get(row.id)));
});

// ── POST /plants/:code/tests (multipart) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxDocBytes, files: 1, fields: 40, fieldSize: 256 * 1024, parts: 50 },
});

const MAGIC = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];
const sniff = (buf) => MAGIC.find((m) => m.test(buf)) || null;

function parseResults(input) {
  let arr = input;
  if (arr === undefined || arr === null || arr === '') return [];
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { fail('results', 'must be a JSON list'); } }
  if (!Array.isArray(arr)) fail('results', 'must be a list');
  if (arr.length > 200) fail('results', 'too many results');
  return arr.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`results[${i}]`, 'must be an object');
    let v;
    try {
      v = validate(r, {
        parameter: str({ max: 100 }), valueText: str({ max: 200 }), valueNum: num({ optional: true }),
        unit: str({ max: 40, optional: true }), limitText: str({ max: 200, optional: true }),
      });
    } catch (err) {
      if (err instanceof HttpError && err.details) fail(`results[${i}].${err.details.field}`, err.message.replace(/^[^:]+:\s*/, ''));
      throw err;
    }
    const w = r.withinLimit;
    if (w !== undefined && w !== null && w !== true && w !== false) fail(`results[${i}].withinLimit`, 'must be true, false or null');
    return { ...v, withinLimit: w === undefined ? null : w };
  });
}

function storeTestFile(file) {
  const kind = sniff(file.buffer);
  if (!kind) fail('report', 'must be a PDF, JPEG or PNG file', 'upload_rejected');
  const dir = path.join(config.uploadDir, 'tests');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomToken(18)}.${kind.ext}`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, file.buffer, { flag: 'wx', mode: 0o640 });
  const original = path.basename(String(file.originalname || '')).replace(/[\u0000-\u001f\u007f"\\]/g, '').slice(0, 200) || null;
  return { abs, storagePath: `tests/${name}`, mime: kind.mime, size: file.buffer.length, sha: sha256(file.buffer), original };
}

router.post('/plants/:code/tests', requirePermission('tests:write'), upload.single('report'), (req, res) => {
  const row = loadPlant(req.params.code);
  const body = req.body || {};
  const v = validate(body, {
    sampleDate: date(),
    laboratory: str({ max: 200 }),
    sourceDescription: str({ max: 500, optional: true }),
    standardName: str({ max: 200, optional: true }),
    standardVersion: str({ max: 100, optional: true }),
    standardSource: str({ max: 500, optional: true }),
    outcome: oneOf(OUTCOMES, { optional: true }),
    notes: str({ max: 2000, optional: true }),
    published: bool({ optional: true }),
  });
  const reason = reasonFrom(body, ['reason', 'notes']);
  const outcome = v.outcome || 'not_assessed';
  const results = parseResults(body.results);
  if (v.sampleDate > todayKarachi()) fail('sampleDate', 'cannot be in the future');
  if ((outcome === 'met_limits' || outcome === 'issue_detected') && !v.standardName) {
    fail('standardName', 'is required when the outcome compares results with a standard');
  }
  if (!v.standardName && results.some((r) => r.withinLimit !== null)) {
    fail('standardName', 'is required when any result is marked within / outside a limit');
  }
  if (outcome === 'met_limits' && (!results.length || results.some((r) => r.withinLimit !== true))) {
    fail('results', 'met_limits requires at least one result and every result within its limit');
  }

  const stored = req.file ? storeTestFile(req.file) : null;
  const db = getDb();
  const now = nowIso();
  let testId;
  try {
    testId = tx(() => {
      let fileId = null;
      if (stored) {
        fileId = Number(db.prepare(`INSERT INTO files (kind, storage_path, original_name, mime, size_bytes, sha256, metadata_stripped, uploaded_by_user, created_at)
                                    VALUES ('test_report', ?, ?, ?, ?, ?, 0, ?, ?)`)
          .run(stored.storagePath, stored.original, stored.mime, stored.size, stored.sha, req.user.id, now).lastInsertRowid);
      }
      const t = db.prepare(`INSERT INTO water_tests (plant_id, sample_date, laboratory, source_description, report_file_id, standard_name, standard_version,
                              standard_source, outcome, notes, published, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, v.sampleDate, v.laboratory, v.sourceDescription, fileId, v.standardName, v.standardVersion, v.standardSource,
          outcome, v.notes, v.published === false ? 0 : 1, req.user.id, now);
      const id = Number(t.lastInsertRowid);
      const ins = db.prepare('INSERT INTO water_test_results (test_id, parameter, value_text, value_num, unit, limit_text, within_limit) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const r of results) ins.run(id, r.parameter, r.valueText, r.valueNum, r.unit, r.limitText, r.withinLimit === null ? null : r.withinLimit ? 1 : 0);
      db.prepare('UPDATE plants SET updated_at = ? WHERE id = ?').run(now, row.id);
      audit(req, {
        action: 'plant.test.create', entityType: 'plant', entityId: row.plant_code, reason,
        after: { testId: id, sampleDate: v.sampleDate, laboratory: v.laboratory, standardName: v.standardName, outcome, results: results.length, fileId, published: v.published !== false },
      });
      return id;
    });
  } catch (err) {
    if (stored) { try { fs.unlinkSync(stored.abs); } catch { /* ignore */ } }
    throw err;
  }
  const test = waterTestsFor(row.id, { includeUnpublished: true }).find((t) => t.id === testId);
  res.status(201).json({ test });
});

// ── DELETE /tests/:id ──
router.delete('/tests/:id', requirePermission('tests:write'), (req, res) => {
  const id = int({ min: 1 })(req.params.id, 'id');
  const reason = reasonFrom({ ...(req.query || {}), ...(req.body || {}) });
  const db = getDb();
  const t = db.prepare('SELECT t.*, p.plant_code FROM water_tests t JOIN plants p ON p.id = t.plant_id WHERE t.id = ?').get(id);
  if (!t) throw new HttpError(404, 'not_found', 'Water test not found.');
  const resultCount = db.prepare('SELECT COUNT(*) AS n FROM water_test_results WHERE test_id = ?').get(id).n;
  let fileToRemove = null;
  tx(() => {
    db.prepare('DELETE FROM water_tests WHERE id = ?').run(id);
    if (t.report_file_id) {
      const used = db.prepare(`SELECT (SELECT COUNT(*) FROM water_tests WHERE report_file_id = ?) + (SELECT COUNT(*) FROM plant_sources WHERE file_id = ?) AS n`)
        .get(t.report_file_id, t.report_file_id).n;
      if (!used) {
        fileToRemove = db.prepare('SELECT storage_path FROM files WHERE id = ?').get(t.report_file_id);
        db.prepare('DELETE FROM files WHERE id = ?').run(t.report_file_id);
      }
    }
    db.prepare('UPDATE plants SET updated_at = ? WHERE id = ?').run(nowIso(), t.plant_id);
    audit(req, {
      action: 'plant.test.delete', entityType: 'plant', entityId: t.plant_code, reason,
      before: { testId: id, sampleDate: t.sample_date, laboratory: t.laboratory, standardName: t.standard_name, outcome: t.outcome, results: resultCount, fileId: t.report_file_id, published: t.published === 1 },
    });
  });
  if (fileToRemove) {
    const root = path.resolve(config.uploadDir);
    const abs = path.resolve(root, fileToRemove.storage_path);
    if (abs.startsWith(root + path.sep)) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
  }
  res.json({ ok: true, deleted: id });
});

// ── POST /plants/:code/sources ──
router.post('/plants/:code/sources', requirePermission('plants:write'), (req, res) => {
  const row = loadPlant(req.params.code);
  const v = validate(req.body, { title: str({ max: 300 }), url: str({ max: 1000, optional: true }), note: str({ max: 1000, optional: true }) });
  const reason = reasonFrom(req.body, ['reason', 'note']);
  if (v.url) {
    let u;
    try { u = new URL(v.url); } catch { fail('url', 'must be a valid http(s) URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) fail('url', 'must start with http:// or https://');
  }
  const now = nowIso();
  const id = tx(() => {
    const r = getDb().prepare('INSERT INTO plant_sources (plant_id, title, url, note, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, v.title, v.url, v.note, req.user.id, now);
    getDb().prepare('UPDATE plants SET updated_at = ? WHERE id = ?').run(now, row.id);
    const sid = Number(r.lastInsertRowid);
    audit(req, { action: 'plant.source.add', entityType: 'plant', entityId: row.plant_code, after: { sourceId: sid, title: v.title, url: v.url, note: v.note }, reason });
    return sid;
  });
  res.status(201).json({ source: { id, title: v.title, url: v.url, note: v.note, createdAt: now } });
});

// ── Areas ──
router.get('/areas', requirePermission('plants:read'), (req, res) => {
  const db = getDb();
  const counts = new Map(db.prepare('SELECT area_id, COUNT(*) AS n FROM plants WHERE area_id IS NOT NULL AND is_demo = 0 GROUP BY area_id').all().map((r) => [r.area_id, r.n]));
  const items = db.prepare('SELECT * FROM areas ORDER BY town, name, id').all().map((a) => ({ ...areaAdminView(a), plantCount: counts.get(a.id) || 0 }));
  res.json({ items, total: items.length });
});

function aliasesField(v, f) {
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = arr.split(/[,\n]/); } }
  if (!Array.isArray(arr) || arr.length > 100) fail(f, 'must be a list of at most 100 aliases');
  const out = [];
  for (const a of arr) {
    if (typeof a !== 'string') fail(f, 'aliases must be text');
    const s = a.trim();
    if (s.length > 200) fail(f, 'each alias must be at most 200 characters');
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

router.patch('/areas/:id', requirePermission('areas:write'), (req, res) => {
  const id = int({ min: 1 })(req.params.id, 'id');
  const db = getDb();
  const area = db.prepare('SELECT * FROM areas WHERE id = ?').get(id);
  if (!area) throw new HttpError(404, 'not_found', 'Area not found.');
  const body = req.body || {};
  const reason = reasonFrom(body);
  const next = {};
  const has = (k) => Object.hasOwn(body, k);
  if (has('latitude') || has('longitude')) {
    const clearing = (body.latitude === null || body.latitude === '') && (body.longitude === null || body.longitude === '');
    if (clearing) {
      Object.assign(next, { latitude: null, longitude: null, geocode_status: 'not_geocodable' });
    } else {
      const v = validate(body, { latitude: num({ min: -90, max: 90 }), longitude: num({ min: -180, max: 180 }) });
      if (!inBounds(v.latitude, v.longitude)) throw new HttpError(400, 'out_of_bounds', 'The position is outside the Faisalabad service area.', { field: 'latitude' });
      Object.assign(next, { latitude: v.latitude, longitude: v.longitude, geocode_status: 'manual', geocode_source: 'Administrator (manual)' });
    }
  }
  if (has('radiusM')) next.radius_m = num({ min: 50, max: 20000, optional: true })(body.radiusM, 'radiusM');
  if (has('nameUr')) next.name_ur = str({ max: 200, optional: true })(body.nameUr, 'nameUr');
  if (has('aliases')) next.aliases_json = JSON.stringify(aliasesField(body.aliases, 'aliases'));
  if (!Object.keys(next).length) fail('fields', 'nothing to change');
  // Any edit of an area that keeps a position counts as a manual review of it.
  const finalLat = Object.hasOwn(next, 'latitude') ? next.latitude : area.latitude;
  if (finalLat !== null && !Object.hasOwn(next, 'geocode_status')) next.geocode_status = 'manual';
  const before = Object.fromEntries(Object.keys(next).map((k) => [k, area[k] ?? null]));
  const d = diff(before, next);
  const now = nowIso();
  tx(() => {
    db.prepare(`UPDATE areas SET ${Object.keys(next).map((c) => `${c} = ?`).join(', ')}, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`)
      .run(...Object.values(next), req.user.id, now, now, id);
    audit(req, { action: 'area.update', entityType: 'area', entityId: id, before: d.before, after: d.after, reason });
  });
  try {
    const gaz = require('../lib/gazetteer');
    if (typeof gaz.invalidate === 'function') gaz.invalidate();
  } catch { /* gazetteer not available */ }
  res.json({ area: areaAdminView(db.prepare('SELECT * FROM areas WHERE id = ?').get(id)), changed: d.changed });
});

module.exports = router;
