'use strict';
// Admin API — system (docs/ARCHITECTURE.md §7 "System").
//   GET   /api/admin/stats                    stats
//   GET   /api/admin/audit?entityType=&entityId=&actor=&action=&from=&to=&page=&pageSize=   audit:read
//   GET   /api/admin/users                    users:manage
//   POST  /api/admin/users                    users:manage  { username, role, password(≥12), displayName? }
//   PATCH /api/admin/users/:id                users:manage  { role?, active?, displayName?, password?, reason? }
//   GET   /api/admin/export/plants.csv|json   export:plants (?includeDemo=1)
//   POST  /api/admin/maintenance/retention    maintenance
//   GET   /api/admin/incomplete?missing=&page= plants:read
// Audit payloads are scrubbed of private contact / credential fields before they are returned.
const express = require('express');
const { getDb, tx, parseJson } = require('../lib/db');
const { HttpError, validate, str, int, oneOf, bool, date, paginate } = require('../lib/http');
const { requirePermission } = require('../lib/auth');
const { audit, diff } = require('../lib/audit');
const { nowIso } = require('../lib/time');
const { hashPassword } = require('../lib/crypto');
const { exactPosition, isAreaUsable } = require('../lib/plant-view');

const router = express.Router();

const ROLES = ['admin', 'editor', 'moderator'];
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,50}$/;

// ── Audit entry view (also used by admin-plants) ──
const SENSITIVE_KEYS = new Set([
  'phone', 'phone_enc', 'phoneenc', 'phone_hash', 'phonehash', 'phonee164', 'e164', 'phone_number', 'phonenumber',
  'password', 'password_hash', 'passwordhash', 'code_hash', 'token_hash', 'csrf_token', 'csrftoken', 'token', 'devcode',
]);
function scrub(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  // Sensitive keys are dropped entirely (not masked), so neither the value nor the field name is echoed.
  for (const [k, v] of Object.entries(value)) if (!SENSITIVE_KEYS.has(k.toLowerCase())) out[k] = scrub(v, depth + 1);
  return out;
}

function auditEntryView(row) {
  return {
    id: row.id,
    actor: { id: row.actor_user_id ?? null, label: row.actor_label },
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: scrub(parseJson(row.before_json, null)),
    after: scrub(parseJson(row.after_json, null)),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

// ── GET /stats ──
router.get('/stats', requirePermission('stats'), (req, res) => {
  const db = getDb();
  const group = (sql, ...p) => Object.fromEntries(db.prepare(sql).all(...p).map((r) => [r.k ?? 'null', r.n]));
  const plants = db.prepare('SELECT coord_status, latitude, longitude, area_id FROM plants WHERE is_demo = 0').all();
  const areas = new Map(db.prepare('SELECT * FROM areas').all().map((a) => [a.id, a]));
  const location = { exact: 0, area: 0, none: 0, pendingReview: 0 };
  for (const p of plants) {
    if (exactPosition(p)) location.exact++;
    else if (isAreaUsable(areas.get(p.area_id))) location.area++;
    else location.none++;
    if (p.coord_status === 'geocoded_pending') location.pendingReview++;
  }
  const lastImport = db.prepare("SELECT source_filename, committed_at FROM import_batches WHERE status = 'committed' ORDER BY committed_at DESC, id DESC LIMIT 1").get();
  res.json({
    plants: {
      total: plants.length,
      demo: db.prepare('SELECT COUNT(*) AS n FROM plants WHERE is_demo = 1').get().n,
      byStatus: group('SELECT status AS k, COUNT(*) AS n FROM plants WHERE is_demo = 0 GROUP BY status'),
      byStatusSource: group('SELECT status_source AS k, COUNT(*) AS n FROM plants WHERE is_demo = 0 GROUP BY status_source'),
      location,
      needsReview: db.prepare('SELECT COUNT(*) AS n FROM plants WHERE is_demo = 0 AND needs_review = 1').get().n,
      verified: db.prepare('SELECT COUNT(*) AS n FROM plants WHERE is_demo = 0 AND last_verified_at IS NOT NULL').get().n,
    },
    areas: {
      total: areas.size,
      usable: [...areas.values()].filter(isAreaUsable).length,
      byGeocodeStatus: group('SELECT geocode_status AS k, COUNT(*) AS n FROM areas GROUP BY geocode_status'),
    },
    waterTests: {
      total: db.prepare('SELECT COUNT(*) AS n FROM water_tests t JOIN plants p ON p.id = t.plant_id WHERE p.is_demo = 0').get().n,
      published: db.prepare('SELECT COUNT(*) AS n FROM water_tests t JOIN plants p ON p.id = t.plant_id WHERE p.is_demo = 0 AND t.published = 1').get().n,
      plantsWithTests: db.prepare('SELECT COUNT(DISTINCT t.plant_id) AS n FROM water_tests t JOIN plants p ON p.id = t.plant_id WHERE p.is_demo = 0 AND t.published = 1').get().n,
    },
    reports: {
      byStatus: group('SELECT status AS k, COUNT(*) AS n FROM reports GROUP BY status'),
      reviewQueue: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE review_queue = 1 AND status IN ('pending','under_review','needs_clarification')").get().n,
    },
    ratings: { byStatus: group('SELECT status AS k, COUNT(*) AS n FROM ratings GROUP BY status') },
    appeals: { byStatus: group('SELECT status AS k, COUNT(*) AS n FROM appeals GROUP BY status') },
    users: { active: db.prepare('SELECT COUNT(*) AS n FROM admin_users WHERE active = 1').get().n, byRole: group('SELECT role AS k, COUNT(*) AS n FROM admin_users WHERE active = 1 GROUP BY role') },
    lastImport: { at: lastImport ? lastImport.committed_at : null, sourceFile: lastImport ? lastImport.source_filename : null },
    generatedAt: nowIso(),
  });
});

// ── GET /audit ──
router.get('/audit', requirePermission('audit:read'), (req, res) => {
  const v = validate(req.query, {
    entityType: str({ max: 50, optional: true }),
    entityId: str({ max: 100, optional: true }),
    actor: str({ max: 100, optional: true }),
    action: str({ max: 100, optional: true }),
    from: date({ optional: true }),
    to: date({ optional: true }),
  });
  const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
  const where = ['1 = 1'];
  const params = [];
  if (v.entityType) { where.push('entity_type = ?'); params.push(v.entityType); }
  if (v.entityId) { where.push('entity_id = ?'); params.push(v.entityId); }
  if (v.actor) {
    if (/^\d+$/.test(v.actor)) { where.push('actor_user_id = ?'); params.push(Number(v.actor)); }
    else { where.push('actor_label = ? COLLATE NOCASE'); params.push(v.actor); }
  }
  if (v.action) {
    if (/[.*]$/.test(v.action)) { where.push("action LIKE ? ESCAPE '\\'"); params.push(`${v.action.replace(/\*$/, '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    else { where.push('action = ?'); params.push(v.action); }
  }
  if (v.from) { where.push('created_at >= ?'); params.push(`${v.from}T00:00:00.000Z`); }
  if (v.to) { where.push('created_at < ?'); params.push(new Date(Date.parse(`${v.to}T00:00:00Z`) + 86400e3).toISOString()); }
  const db = getDb();
  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${w}`).get(...params).n;
  const items = db.prepare(`SELECT * FROM audit_log WHERE ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).map(auditEntryView);
  res.json({ items, total, page, pageSize });
});

// ── Users ──
const userView = (u) => ({
  id: u.id, username: u.username, displayName: u.display_name ?? null, role: u.role, active: u.active === 1,
  createdAt: u.created_at, lastLoginAt: u.last_login_at ?? null,
});

router.get('/users', requirePermission('users:manage'), (req, res) => {
  res.json({ items: getDb().prepare('SELECT * FROM admin_users ORDER BY username').all().map(userView) });
});

router.post('/users', requirePermission('users:manage'), (req, res) => {
  const v = validate(req.body, {
    username: str({ min: 3, max: 50, pattern: USERNAME_RE }),
    role: oneOf(ROLES),
    password: str({ min: 12, max: 200, trim: false }),
    displayName: str({ max: 100, optional: true }),
    reason: str({ max: 1000, optional: true }),
  });
  const db = getDb();
  if (db.prepare('SELECT 1 FROM admin_users WHERE username = ?').get(v.username)) {
    throw new HttpError(409, 'conflict', 'That username is already taken.', { field: 'username' });
  }
  const id = tx(() => {
    const r = db.prepare('INSERT INTO admin_users (username, display_name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(v.username, v.displayName, hashPassword(v.password), v.role, nowIso());
    const uid = Number(r.lastInsertRowid);
    audit(req, { action: 'admin_user.create', entityType: 'admin_user', entityId: uid, after: { username: v.username, role: v.role, displayName: v.displayName }, reason: v.reason });
    return uid;
  });
  res.status(201).json({ user: userView(db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id)) });
});

router.patch('/users/:id', requirePermission('users:manage'), (req, res) => {
  const id = int({ min: 1 })(req.params.id, 'id');
  const db = getDb();
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
  if (!user) throw new HttpError(404, 'not_found', 'User not found.');
  const v = validate(req.body, {
    role: oneOf(ROLES, { optional: true }),
    active: bool({ optional: true }),
    displayName: str({ max: 100, optional: true }),
    password: str({ min: 12, max: 200, trim: false, optional: true }),
    reason: str({ max: 1000, optional: true }),
  });
  const self = id === req.user.id;
  if (self && v.active === false) throw new HttpError(400, 'forbidden_self', 'You cannot deactivate your own account.', { field: 'active' });
  if (self && v.role !== null && v.role !== user.role) throw new HttpError(400, 'forbidden_self', 'You cannot change your own role.', { field: 'role' });

  const next = {};
  if (v.role !== null) next.role = v.role;
  if (v.active !== null) next.active = v.active ? 1 : 0;
  if (Object.hasOwn(req.body || {}, 'displayName')) next.display_name = v.displayName;
  const before = Object.fromEntries(Object.keys(next).map((k) => [k, user[k] ?? null]));
  const d = diff(before, next);
  const passwordChanged = v.password !== null;
  if (!d.changed.length && !passwordChanged) throw new HttpError(400, 'invalid_input', 'Nothing to change.', { field: 'fields' });
  tx(() => {
    if (d.changed.length) db.prepare(`UPDATE admin_users SET ${d.changed.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...d.changed.map((c) => next[c]), id);
    if (passwordChanged) db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hashPassword(v.password), id);
    // Deactivation, role change or password reset ends the user's other sessions.
    if (!self && (next.active === 0 || d.changed.includes('role') || passwordChanged)) db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
    audit(req, {
      action: 'admin_user.update', entityType: 'admin_user', entityId: id, reason: v.reason,
      before: d.before, after: { ...d.after, ...(passwordChanged ? { passwordChanged: true } : {}) },
    });
  });
  res.json({ user: userView(db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id)) });
});

// ── Exports ──
const EXPORT_COLUMNS = [
  'plant_code', 'name', 'town', 'area_raw', 'area_name', 'area_sector', 'area_id', 'address', 'neighborhood', 'landmark',
  'latitude', 'longitude', 'coord_status', 'coord_source', 'coord_accuracy_m', 'coord_note',
  'operator_type', 'operator_name', 'water_source', 'technology_raw', 'treatment_stages_json',
  'capacity_raw', 'capacity_value', 'capacity_unit', 'capacity_unit_label', 'capacity_basis', 'capacity_gallon_type',
  'collection_limit_raw', 'collection_limit_value', 'collection_limit_unit', 'collection_limit_period',
  'opening_hours_text', 'opening_hours_json',
  'status', 'status_raw', 'status_source', 'status_updated_at', 'status_note',
  'public_phone', 'public_contact_note', 'accessibility',
  'last_verified_at', 'verification_note', 'needs_review', 'review_reasons_json', 'is_demo',
  // Source traceability
  'source_file', 'source_sheet', 'source_row', 'source_values_json', 'import_batch_id', 'imported_at',
  'created_at', 'updated_at',
];

/** CSV cell, safe against formula injection in spreadsheet apps (OWASP: = + - @ TAB CR). */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (/^[=+\-@\t\r＝＋－＠]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function exportRows(req) {
  const v = validate(req.query, { includeDemo: bool({ optional: true }) });
  const rows = getDb().prepare(`SELECT ${EXPORT_COLUMNS.join(', ')} FROM plants ${v.includeDemo ? '' : 'WHERE is_demo = 0'} ORDER BY plant_code`).all();
  return { rows, includeDemo: !!v.includeDemo };
}

router.get('/export/plants.csv', requirePermission('export:plants'), (req, res) => {
  const { rows, includeDemo } = exportRows(req);
  audit(req, { action: 'export.plants', entityType: 'plant', after: { format: 'csv', count: rows.length, includeDemo } });
  const lines = [EXPORT_COLUMNS.map(csvCell).join(',')];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="team-water-plants-${nowIso().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n'); // BOM so spreadsheet apps read UTF-8 (Urdu) correctly
});

router.get('/export/plants.json', requirePermission('export:plants'), (req, res) => {
  const { rows, includeDemo } = exportRows(req);
  audit(req, { action: 'export.plants', entityType: 'plant', after: { format: 'json', count: rows.length, includeDemo } });
  res.setHeader('Content-Disposition', `attachment; filename="team-water-plants-${nowIso().slice(0, 10)}.json"`);
  res.json({ exportedAt: nowIso(), count: rows.length, columns: EXPORT_COLUMNS, items: rows.map((r) => ({ ...r })) });
});

// ── Maintenance ──
router.post('/maintenance/retention', requirePermission('maintenance'), async (req, res) => {
  const { runRetention } = require('../lib/retention');
  const result = await runRetention();
  audit(req, { action: 'maintenance.retention', entityType: 'system', entityId: 'retention', after: result ?? null, reason: typeof (req.body || {}).reason === 'string' ? req.body.reason.slice(0, 1000) : null });
  res.json({ ok: true, result: result ?? null });
});

// ── GET /incomplete ──
const INCOMPLETE_KEYS = ['noExactLocation', 'noLocationAtAll', 'noName', 'noHours', 'noTests', 'needsReview'];

router.get('/incomplete', requirePermission('plants:read'), (req, res) => {
  const v = validate(req.query, { missing: oneOf(INCOMPLETE_KEYS, { optional: true }), town: str({ max: 200, optional: true }) });
  const { page, pageSize, limit, offset } = paginate(req.query, { defaultSize: 50, maxSize: 200 });
  const db = getDb();
  const areas = new Map(db.prepare('SELECT * FROM areas').all().map((a) => [a.id, a]));
  const tested = new Set(db.prepare('SELECT DISTINCT plant_id FROM water_tests WHERE published = 1').all().map((r) => r.plant_id));
  const rows = db.prepare(`SELECT id, plant_code, name, town, area_raw, area_id, coord_status, latitude, longitude, status, needs_review,
                                  opening_hours_text, opening_hours_json FROM plants WHERE is_demo = 0 ORDER BY plant_code`).all();
  const counts = Object.fromEntries(INCOMPLETE_KEYS.map((k) => [k, 0]));
  const items = [];
  for (const r of rows) {
    const exact = !!exactPosition(r);
    const area = !exact && isAreaUsable(areas.get(r.area_id));
    const flags = {
      noExactLocation: !exact,
      noLocationAtAll: !exact && !area,
      noName: !r.name,
      noHours: !r.opening_hours_text && !r.opening_hours_json,
      noTests: !tested.has(r.id),
      needsReview: r.needs_review === 1,
    };
    const missing = INCOMPLETE_KEYS.filter((k) => flags[k]);
    for (const k of missing) counts[k]++;
    if (!missing.length) continue;
    if (v.missing && !flags[v.missing]) continue;
    if (v.town && String(r.town || '').toLowerCase() !== v.town.toLowerCase()) continue;
    items.push({
      code: r.plant_code, name: r.name, town: r.town, areaRaw: r.area_raw, status: r.status, coordStatus: r.coord_status,
      precision: exact ? 'exact' : area ? 'area' : 'none', needsReview: r.needs_review === 1, missing,
    });
  }
  res.json({ counts, items: items.slice(offset, offset + limit), total: items.length, page, pageSize });
});

module.exports = router;
module.exports.auditEntryView = auditEntryView;
module.exports.scrubAuditPayload = scrub;
module.exports.csvCell = csvCell;
