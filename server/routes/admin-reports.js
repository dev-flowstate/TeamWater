'use strict';
// Admin: reports & moderation. See docs/ARCHITECTURE.md §7 "Reports & moderation".
// Every route declares its own permission (no router-wide middleware, so other admin routers mounted
// after this one are unaffected). Mutations need the CSRF header (enforced by requirePermission).
//
// Reports are not findings: confirming a report never changes a plant's official status. That is a separate
// action (POST /api/admin/plants/:code/status) that requires a documented assessment.
// Phone numbers: only `contact:reveal` (admin) can decrypt one, with a reason, audited. Audit payloads,
// logs and the default CSV export never contain a phone number.
const express = require('express');
const { getDb, tx, parseJson } = require('../lib/db');
const { HttpError, validate, str, int, oneOf, bool, paginate } = require('../lib/http');
const { requirePermission, can } = require('../lib/auth');
const { audit, diff } = require('../lib/audit');
const { nowIso, addDays } = require('../lib/time');
const images = require('../lib/images');
const risk = require('../lib/risk');
const reporters = require('../lib/reporters');
const moderation = require('../lib/moderation');

const router = express.Router();

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'not_found', 'Not found');
  return id;
};
const reasonField = str({ min: 3, max: 2000 });

function plantRef(row) {
  return { id: row.plant_id, code: row.plant_code, name: row.plant_name ?? null, town: row.plant_town ?? null, areaRaw: row.plant_area_raw ?? null, isDemo: Boolean(row.plant_is_demo) };
}
const PLANT_COLS = 'p.plant_code, p.name AS plant_name, p.town AS plant_town, p.area_raw AS plant_area_raw, p.is_demo AS plant_is_demo';

// ───────────────────────── Reports ─────────────────────────
router.get('/reports', requirePermission('reports:read'), (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  if (q.status) { oneOf(moderation.STATUSES)(q.status, 'status'); where.push('r.status = ?'); args.push(q.status); }
  if (q.severity) { oneOf(['normal', 'serious'])(q.severity, 'severity'); where.push('r.severity = ?'); args.push(q.severity); }
  if (q.category) { oneOf(moderation.CATEGORIES)(q.category, 'category'); where.push('r.category = ?'); args.push(q.category); }
  if (q.queue === '1' || q.queue === 'true') {
    where.push(`r.review_queue = 1 AND r.status IN (${moderation.OPEN_STATUSES.map(() => '?').join(',')})`);
    args.push(...moderation.OPEN_STATUSES);
  }
  if (q.plantCode) { where.push('p.plant_code = ? COLLATE NOCASE'); args.push(String(q.plantCode).trim()); }
  if (q.reporterId) { where.push('r.reporter_id = ?'); args.push(Number(q.reporterId)); }
  if (q.reference) { where.push('r.reference = ?'); args.push(String(q.reference).trim().toUpperCase()); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { page, pageSize, limit, offset } = paginate(q, { defaultSize: 25, maxSize: 200 });
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM reports r JOIN plants p ON p.id = r.plant_id ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT r.*, ${PLANT_COLS}, (SELECT COUNT(*) FROM report_photos rp WHERE rp.report_id = r.id) AS photo_count
                           FROM reports r JOIN plants p ON p.id = r.plant_id ${w}
                           ORDER BY (r.severity = 'serious' AND r.status IN ('pending','under_review','needs_clarification')) DESC,
                                    r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({
    items: rows.map((r) => ({
      id: r.id, reference: r.reference, plant: plantRef(r), category: r.category, severity: r.severity, status: r.status,
      riskScore: r.risk_score, riskLevel: risk.riskLevel(r.risk_score), reviewQueue: Boolean(r.review_queue),
      phoneVerified: Boolean(r.phone_verified), photoCount: r.photo_count, createdAt: r.created_at, redacted: Boolean(r.redacted_at),
    })),
    total, page, pageSize,
  });
});

function loadReport(id) {
  const row = getDb().prepare(`SELECT r.*, ${PLANT_COLS}, p.status AS plant_status FROM reports r JOIN plants p ON p.id = r.plant_id WHERE r.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'not_found', 'Report not found.');
  return row;
}

router.get('/reports/:id', requirePermission('reports:read'), (req, res) => {
  const r = loadReport(idParam(req));
  const db = getDb();
  const reporter = r.reporter_id ? reporters.findById(r.reporter_id) : null;
  const photos = db.prepare(`SELECT rp.*, f.mime, f.size_bytes, f.sha256, f.metadata_stripped, f.created_at AS uploaded_at
                             FROM report_photos rp JOIN files f ON f.id = rp.file_id WHERE rp.report_id = ? ORDER BY rp.id`).all(r.id);
  const events = db.prepare(`SELECT e.*, u.username FROM report_events e LEFT JOIN admin_users u ON u.id = e.actor_user_id
                             WHERE e.report_id = ? ORDER BY e.created_at, e.id`).all(r.id);
  const similar = r.redacted_at ? [] : risk.findSimilar(r.description, {
    sinceIso: addDays(r.created_at, -30), untilIso: addDays(r.created_at, 30), excludeId: r.id, minSimilarity: 0.6, limit: 10,
  });
  const simPlants = new Map();
  for (const s of similar) {
    if (!simPlants.has(s.plantId)) simPlants.set(s.plantId, db.prepare('SELECT plant_code FROM plants WHERE id = ?').get(s.plantId)?.plant_code ?? null);
  }
  const investigations = db.prepare(`SELECT i.id, i.title, i.status FROM investigations i JOIN investigation_reports ir ON ir.investigation_id = i.id
                                     WHERE ir.report_id = ? ORDER BY i.id`).all(r.id);
  const appeals = db.prepare('SELECT id, reference, kind, status, created_at FROM appeals WHERE report_id = ? ORDER BY id').all(r.id);
  res.json({
    id: r.id,
    reference: r.reference,
    plant: { ...plantRef(r), status: r.plant_status },
    category: r.category,
    severity: r.severity,
    status: r.status,
    allowedActions: moderation.allowedActions(r.status),
    description: r.description,
    observedAt: r.observed_at,
    lang: r.lang,
    consentContact: Boolean(r.consent_contact),
    phoneVerified: Boolean(r.phone_verified),
    riskScore: r.risk_score,
    riskLevel: risk.riskLevel(r.risk_score),
    riskReasons: parseJson(r.risk_reasons_json, []),
    reviewQueue: Boolean(r.review_queue),
    proximityShared: Boolean(r.proximity_shared),
    proximityDistanceM: r.proximity_distance_m,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    retentionUntil: r.retention_until,
    redactedAt: r.redacted_at,
    reporter: reporter ? reporters.adminView(reporter) : null,
    photos: photos.map((p) => ({
      id: p.id, url: `/api/admin/photos/${p.id}`, mime: p.mime, sizeBytes: p.size_bytes, sha256: p.sha256,
      metadataStripped: Boolean(p.metadata_stripped), moderationStatus: p.moderation_status, moderationNote: p.moderation_note,
      public: Boolean(p.public), publicUrl: p.moderation_status === 'approved' && p.public ? `/api/photos/${p.id}` : null,
    })),
    events: events.map((e) => ({
      id: e.id, action: e.action, fromStatus: e.from_status, toStatus: e.to_status, reason: e.reason, publicNote: e.public_note,
      actor: e.actor_user_id ? { id: e.actor_user_id, username: e.username } : null, at: e.created_at,
    })),
    similarReports: similar.map((s) => ({
      id: s.id, reference: s.reference, plantCode: simPlants.get(s.plantId), status: s.status, createdAt: s.createdAt,
      similarity: s.similarity, exact: s.exact, sameReporter: Boolean(r.reporter_id && s.reporterId === r.reporter_id),
    })),
    investigations,
    appeals: appeals.map((a) => ({ id: a.id, reference: a.reference, kind: a.kind, status: a.status, createdAt: a.created_at })),
    notice: 'Confirming a report does not change the plant\'s official status. Use the plant status action with a documented assessment.',
  });
});

router.post('/reports/:id/decision', requirePermission('reports:moderate'), (req, res) => {
  const id = idParam(req);
  const v = validate(req.body, {
    action: oneOf(moderation.ACTIONS),
    reason: reasonField,
    publicNote: str({ max: 1000, optional: true }),
  });
  const out = moderation.applyDecision(req, id, v);
  res.json({ ...out, allowedActions: moderation.allowedActions(out.status) });
});

router.post('/reports/:id/reveal-contact', requirePermission('contact:reveal'), (req, res) => {
  const r = loadReport(idParam(req));
  const { reason } = validate(req.body, { reason: str({ min: 5, max: 1000 }) });
  const reporter = r.reporter_id ? reporters.findById(r.reporter_id) : null;
  const phone = reporters.revealPhone(reporter);
  if (!phone) throw new HttpError(410, 'contact_erased', 'This reporter\'s phone number is no longer stored (erased by retention or at their request).');
  audit(req, { action: 'contact.reveal', entityType: 'reporter', entityId: reporter.id, after: { reportId: r.id, reference: r.reference }, reason });
  res.json({ phone });
});

// ───────────────────────── Photos ─────────────────────────
function loadPhoto(id) {
  const p = getDb().prepare(`SELECT rp.*, f.storage_path, f.mime, r.reference, r.redacted_at FROM report_photos rp
                             JOIN files f ON f.id = rp.file_id JOIN reports r ON r.id = rp.report_id WHERE rp.id = ?`).get(id);
  if (!p) throw new HttpError(404, 'not_found', 'Photo not found.');
  return p;
}

router.get('/photos/:id', requirePermission('reports:read'), (req, res) => {
  const p = loadPhoto(idParam(req));
  const buf = images.readStoredFile(p.storage_path);
  if (!buf) throw new HttpError(404, 'not_found', 'Photo file not found.');
  res.setHeader('Content-Type', p.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.end(buf);
});

router.post('/photos/:id/moderate', requirePermission('reports:moderate'), (req, res) => {
  const p = loadPhoto(idParam(req));
  const v = validate(req.body, { action: oneOf(['approve', 'reject']), public: bool({ optional: true }), note: str({ max: 1000, optional: true }) });
  if (v.action === 'approve' && v.public === null) {
    throw new HttpError(400, 'invalid_input', 'public: choose explicitly whether the approved photo may be shown publicly', { field: 'public' });
  }
  const makePublic = v.action === 'approve' && v.public === true;
  if (makePublic && !v.note) {
    throw new HttpError(400, 'invalid_input', 'note: before publishing, record that you checked for faces, phone numbers and other private details', { field: 'note' });
  }
  const after = { moderationStatus: v.action === 'approve' ? 'approved' : 'rejected', public: makePublic };
  getDb().prepare('UPDATE report_photos SET moderation_status = ?, public = ?, moderation_note = ? WHERE id = ?')
    .run(after.moderationStatus, makePublic ? 1 : 0, v.note, p.id);
  audit(req, {
    action: 'photo.moderate', entityType: 'report_photo', entityId: p.id,
    before: { moderationStatus: p.moderation_status, public: Boolean(p.public) }, after: { ...after, report: p.reference }, reason: v.note,
  });
  res.json({ id: p.id, ...after, publicUrl: makePublic ? `/api/photos/${p.id}` : null });
});

// ───────────────────────── Reporters ─────────────────────────
router.get('/reporters/:id', requirePermission('reports:read'), (req, res) => {
  const row = reporters.findById(idParam(req));
  if (!row) throw new HttpError(404, 'not_found', 'Reporter not found.');
  const db = getDb();
  const reports = db.prepare(`SELECT r.id, r.reference, r.category, r.severity, r.status, r.risk_score, r.review_queue, r.created_at, p.plant_code
                              FROM reports r JOIN plants p ON p.id = r.plant_id WHERE r.reporter_id = ? ORDER BY r.created_at DESC LIMIT 100`).all(row.id);
  const ratings = db.prepare(`SELECT g.id, g.stars, g.status, g.created_at, p.plant_code FROM ratings g JOIN plants p ON p.id = g.plant_id
                              WHERE g.reporter_id = ? ORDER BY g.created_at DESC LIMIT 100`).all(row.id);
  res.json({
    ...reporters.adminView(row),
    reports: reports.map((r) => ({ id: r.id, reference: r.reference, plantCode: r.plant_code, category: r.category, severity: r.severity,
      status: r.status, riskScore: r.risk_score, reviewQueue: Boolean(r.review_queue), createdAt: r.created_at })),
    ratings: ratings.map((g) => ({ id: g.id, plantCode: g.plant_code, stars: g.stars, status: g.status, createdAt: g.created_at })),
  });
});

router.post('/reporters/:id/status', requirePermission('reporters:manage'), (req, res) => {
  const row = reporters.findById(idParam(req));
  if (!row) throw new HttpError(404, 'not_found', 'Reporter not found.');
  const v = validate(req.body, { status: oneOf(['active', 'restricted', 'blocked']), reason: reasonField });
  getDb().prepare('UPDATE reporters SET status = ?, status_reason = ? WHERE id = ?').run(v.status, v.reason, row.id);
  audit(req, { action: 'reporter.status', entityType: 'reporter', entityId: row.id, before: { status: row.status }, after: { status: v.status }, reason: v.reason });
  res.json(reporters.adminView(reporters.findById(row.id)));
});

// ───────────────────────── Ratings ─────────────────────────
router.get('/ratings', requirePermission('reports:read'), (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  if (q.status) { oneOf(['pending', 'accepted', 'rejected'])(q.status, 'status'); where.push('g.status = ?'); args.push(q.status); }
  if (q.plantCode) { where.push('p.plant_code = ? COLLATE NOCASE'); args.push(String(q.plantCode).trim()); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { page, pageSize, limit, offset } = paginate(q);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ratings g JOIN plants p ON p.id = g.plant_id ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT g.*, p.plant_code, p.name AS plant_name, rp.public_alias FROM ratings g JOIN plants p ON p.id = g.plant_id
                           LEFT JOIN reporters rp ON rp.id = g.reporter_id ${w} ORDER BY g.created_at DESC, g.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  res.json({
    items: rows.map((g) => ({
      id: g.id, plant: { code: g.plant_code, name: g.plant_name }, stars: g.stars, status: g.status, riskScore: g.risk_score,
      riskLevel: risk.riskLevel(g.risk_score), riskReasons: parseJson(g.risk_reasons_json, []),
      reporter: g.reporter_id ? { id: g.reporter_id, alias: g.public_alias } : null, createdAt: g.created_at,
    })),
    total, page, pageSize,
  });
});

router.post('/ratings/:id/decision', requirePermission('reports:moderate'), (req, res) => {
  const id = idParam(req);
  const v = validate(req.body, { action: oneOf(['accept', 'reject']), reason: reasonField });
  const row = getDb().prepare('SELECT id, status FROM ratings WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'not_found', 'Rating not found.');
  const status = v.action === 'accept' ? 'accepted' : 'rejected';
  getDb().prepare('UPDATE ratings SET status = ? WHERE id = ?').run(status, id);
  audit(req, { action: 'rating.decision', entityType: 'rating', entityId: id, before: { status: row.status }, after: { status }, reason: v.reason });
  res.json({ id, status });
});

// ───────────────────────── Appeals ─────────────────────────
const APPEAL_STATUSES = ['open', 'in_progress', 'accepted', 'declined', 'completed'];
const APPEAL_FINAL = ['declined', 'completed'];

router.get('/appeals', requirePermission('appeals'), (req, res) => {
  const q = req.query;
  const where = [];
  const args = [];
  if (q.status) { oneOf(APPEAL_STATUSES)(q.status, 'status'); where.push('a.status = ?'); args.push(q.status); }
  if (q.kind) { oneOf(['correction', 'appeal', 'deletion_request'])(q.kind, 'kind'); where.push('a.kind = ?'); args.push(q.kind); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { page, pageSize, limit, offset } = paginate(q);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM appeals a ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT a.*, r.reference AS report_reference, p.plant_code, rp.public_alias, u.username AS resolved_by_name
                           FROM appeals a LEFT JOIN reports r ON r.id = a.report_id LEFT JOIN plants p ON p.id = a.plant_id
                           LEFT JOIN reporters rp ON rp.id = a.reporter_id LEFT JOIN admin_users u ON u.id = a.resolved_by
                           ${w} ORDER BY (a.status IN ('open','in_progress')) DESC, a.created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({
    items: rows.map((a) => ({
      id: a.id, reference: a.reference, kind: a.kind, status: a.status, message: a.message, resolution: a.resolution,
      report: a.report_id ? { id: a.report_id, reference: a.report_reference } : null,
      plantCode: a.plant_code || null,
      reporter: a.reporter_id ? { id: a.reporter_id, alias: a.public_alias } : null,
      matchedReporter: Boolean(a.reporter_id),
      createdAt: a.created_at, resolvedAt: a.resolved_at, resolvedBy: a.resolved_by_name || null,
    })),
    total, page, pageSize,
  });
});

router.post('/appeals/:id/resolve', requirePermission('appeals'), (req, res) => {
  const id = idParam(req);
  const v = validate(req.body, { status: oneOf(['in_progress', 'accepted', 'declined', 'completed']), resolution: str({ min: 3, max: 2000 }) });
  const appeal = getDb().prepare('SELECT * FROM appeals WHERE id = ?').get(id);
  if (!appeal) throw new HttpError(404, 'not_found', 'Appeal not found.');
  if (APPEAL_FINAL.includes(appeal.status)) throw new HttpError(409, 'already_resolved', `This request is already ${appeal.status}.`);
  // Erase first: if erasure fails the request stays open instead of being marked completed.
  let erasure = null;
  if (appeal.kind === 'deletion_request' && v.status === 'completed' && appeal.reporter_id) {
    erasure = moderation.eraseReporterData(req, appeal.reporter_id, { reason: v.resolution, appealReference: appeal.reference });
  }
  const final = APPEAL_FINAL.includes(v.status) || v.status === 'accepted';
  getDb().prepare('UPDATE appeals SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(v.status, v.resolution, req.user.id, final ? nowIso() : null, id);
  audit(req, {
    action: 'appeal.resolve', entityType: 'appeal', entityId: id,
    before: { status: appeal.status }, after: { status: v.status, kind: appeal.kind, reference: appeal.reference, erasure }, reason: v.resolution,
  });
  res.json({
    id, reference: appeal.reference, status: v.status, erasure,
    ...(appeal.kind === 'deletion_request' && v.status === 'completed' && !appeal.reporter_id
      ? { notice: 'No reporter matched this phone number, so there was no stored data to erase.' } : {}),
  });
});

// ───────────────────────── Investigations ─────────────────────────
function investigationView(i) {
  const reportRows = getDb().prepare(`SELECT r.id, r.reference, r.status, r.category FROM investigation_reports ir JOIN reports r ON r.id = ir.report_id
                                      WHERE ir.investigation_id = ? ORDER BY r.id`).all(i.id);
  return {
    id: i.id, plant: { code: i.plant_code, name: i.plant_name ?? null }, title: i.title, status: i.status, findings: i.findings,
    resolution: i.resolution, openedBy: i.opened_by_name || null, openedAt: i.opened_at, closedBy: i.closed_by_name || null, closedAt: i.closed_at,
    reports: reportRows.map((r) => ({ id: r.id, reference: r.reference, status: r.status, category: r.category })),
  };
}
const INV_SELECT = `SELECT i.*, p.plant_code, p.name AS plant_name, uo.username AS opened_by_name, uc.username AS closed_by_name
                    FROM investigations i JOIN plants p ON p.id = i.plant_id
                    LEFT JOIN admin_users uo ON uo.id = i.opened_by LEFT JOIN admin_users uc ON uc.id = i.closed_by`;

function linkReports(db, investigation, ids) {
  for (const rid of ids) {
    const r = db.prepare('SELECT id, plant_id FROM reports WHERE id = ?').get(rid);
    if (!r) throw new HttpError(422, 'unknown_report', `Report ${rid} does not exist.`, { field: 'reportIds' });
    if (r.plant_id !== investigation.plant_id) throw new HttpError(422, 'invalid_input', `Report ${rid} is about a different plant.`, { field: 'reportIds' });
    db.prepare('INSERT OR IGNORE INTO investigation_reports (investigation_id, report_id) VALUES (?, ?)').run(investigation.id, rid);
  }
}
const idList = (v, field) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(Number(x)) && Number(x) > 0)) {
    throw new HttpError(400, 'invalid_input', `${field}: must be a list of report ids`, { field });
  }
  return v.map(Number);
};

router.get('/investigations', requirePermission('investigations'), (req, res) => {
  const where = [];
  const args = [];
  if (req.query.plantCode) { where.push('p.plant_code = ? COLLATE NOCASE'); args.push(String(req.query.plantCode).trim()); }
  if (req.query.status) { oneOf(['open', 'closed'])(req.query.status, 'status'); where.push('i.status = ?'); args.push(req.query.status); }
  const rows = getDb().prepare(`${INV_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.status = 'open' DESC, i.opened_at DESC LIMIT 200`).all(...args);
  res.json({ items: rows.map(investigationView), total: rows.length });
});

router.post('/investigations', requirePermission('investigations'), (req, res) => {
  const v = validate(req.body, { plantCode: str({ max: 40 }), title: str({ min: 3, max: 200 }), findings: str({ max: 5000, optional: true }) });
  const reportIds = idList(req.body && req.body.reportIds, 'reportIds');
  const plant = getDb().prepare('SELECT id FROM plants WHERE plant_code = ? COLLATE NOCASE').get(v.plantCode);
  if (!plant) throw new HttpError(422, 'unknown_plant', 'Plant not found.', { field: 'plantCode' });
  const id = tx((db) => {
    const newId = Number(db.prepare('INSERT INTO investigations (plant_id, title, status, findings, opened_by, opened_at) VALUES (?, ?, \'open\', ?, ?, ?)')
      .run(plant.id, v.title, v.findings, req.user.id, nowIso()).lastInsertRowid);
    linkReports(db, { id: newId, plant_id: plant.id }, reportIds);
    audit(req, { action: 'investigation.create', entityType: 'investigation', entityId: newId, after: { plantCode: v.plantCode, title: v.title, reportIds } });
    return newId;
  });
  res.status(201).json(investigationView(getDb().prepare(`${INV_SELECT} WHERE i.id = ?`).get(id)));
});

router.patch('/investigations/:id', requirePermission('investigations'), (req, res) => {
  const id = idParam(req);
  const body = req.body || {};
  const v = validate(body, {
    title: str({ min: 3, max: 200, optional: true }),
    findings: str({ max: 5000, optional: true }),
    resolution: str({ max: 5000, optional: true }),
    status: oneOf(['open', 'closed'], { optional: true }),
    reason: str({ max: 2000, optional: true }),
  });
  const add = idList(body.addReportIds, 'addReportIds');
  const remove = idList(body.removeReportIds, 'removeReportIds');
  const inv = getDb().prepare('SELECT * FROM investigations WHERE id = ?').get(id);
  if (!inv) throw new HttpError(404, 'not_found', 'Investigation not found.');
  const next = {
    title: v.title ?? inv.title,
    findings: body.findings !== undefined ? v.findings : inv.findings,
    resolution: body.resolution !== undefined ? v.resolution : inv.resolution,
    status: v.status ?? inv.status,
  };
  if (next.status === 'closed' && inv.status !== 'closed' && !(next.resolution && next.resolution.length >= 10)) {
    throw new HttpError(400, 'invalid_input', 'resolution: describe the outcome (at least 10 characters) before closing', { field: 'resolution' });
  }
  tx((db) => {
    const closing = next.status === 'closed' && inv.status !== 'closed';
    const reopening = next.status === 'open' && inv.status === 'closed';
    db.prepare(`UPDATE investigations SET title = ?, findings = ?, resolution = ?, status = ?,
                closed_by = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE closed_by END,
                closed_at = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE closed_at END WHERE id = ?`)
      .run(next.title, next.findings, next.resolution, next.status, closing ? 1 : 0, req.user.id, reopening ? 1 : 0,
        closing ? 1 : 0, nowIso(), reopening ? 1 : 0, id);
    linkReports(db, inv, add);
    for (const rid of remove) db.prepare('DELETE FROM investigation_reports WHERE investigation_id = ? AND report_id = ?').run(id, rid);
    const d = diff({ title: inv.title, findings: inv.findings, resolution: inv.resolution, status: inv.status }, next);
    audit(req, { action: 'investigation.update', entityType: 'investigation', entityId: id, before: d.before,
      after: { ...d.after, addReportIds: add, removeReportIds: remove }, reason: v.reason });
  });
  res.json(investigationView(getDb().prepare(`${INV_SELECT} WHERE i.id = ?`).get(id)));
});

// ───────────────────────── Stats ─────────────────────────
router.get('/moderation/stats', requirePermission('reports:read'), (req, res) => {
  const db = getDb();
  const now = nowIso();
  const group = (sql, ...a) => Object.fromEntries(db.prepare(sql).all(...a).map((r) => [r.k, r.n]));
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  const open = moderation.OPEN_STATUSES.map((s) => `'${s}'`).join(',');
  const byStatus = Object.fromEntries(moderation.STATUSES.map((s) => [s, 0]));
  Object.assign(byStatus, group('SELECT status AS k, COUNT(*) AS n FROM reports GROUP BY status'));

  // Median hours from submission to the first moderator decision, over reports created in the last 30 days.
  const waits = db.prepare(`SELECT (julianday(MIN(e.created_at)) - julianday(r.created_at)) * 24 AS h FROM reports r
                            JOIN report_events e ON e.report_id = r.id AND e.actor_user_id IS NOT NULL
                            WHERE r.created_at >= ? GROUP BY r.id ORDER BY h`).all(addDays(now, -30)).map((x) => x.h);
  const median = waits.length ? Math.round(waits[Math.floor((waits.length - 1) / 2)] * 10) / 10 : null;

  res.json({
    reports: {
      total: count('SELECT COUNT(*) AS n FROM reports'),
      byStatus,
      bySeverity: group('SELECT severity AS k, COUNT(*) AS n FROM reports GROUP BY severity'),
      byCategory: group('SELECT category AS k, COUNT(*) AS n FROM reports GROUP BY category'),
      open: count(`SELECT COUNT(*) AS n FROM reports WHERE status IN (${open})`),
      seriousOpen: count(`SELECT COUNT(*) AS n FROM reports WHERE severity = 'serious' AND status IN (${open})`),
      reviewQueueOpen: count(`SELECT COUNT(*) AS n FROM reports WHERE review_queue = 1 AND status IN (${open})`),
      last24h: count('SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?', addDays(now, -1)),
      last7d: count('SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?', addDays(now, -7)),
      last30d: count('SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?', addDays(now, -30)),
      phoneVerifiedShare30d: (() => {
        const r = db.prepare('SELECT COUNT(*) AS n, SUM(phone_verified) AS v FROM reports WHERE created_at >= ?').get(addDays(now, -30));
        return r.n ? Math.round((r.v / r.n) * 100) / 100 : null;
      })(),
      redacted: count('SELECT COUNT(*) AS n FROM reports WHERE redacted_at IS NOT NULL'),
      medianHoursToFirstDecision30d: median,
    },
    photos: group('SELECT moderation_status AS k, COUNT(*) AS n FROM report_photos GROUP BY moderation_status'),
    publicPhotos: count('SELECT COUNT(*) AS n FROM report_photos WHERE public = 1'),
    ratings: group('SELECT status AS k, COUNT(*) AS n FROM ratings GROUP BY status'),
    appeals: {
      byStatus: group('SELECT status AS k, COUNT(*) AS n FROM appeals GROUP BY status'),
      openByKind: group("SELECT kind AS k, COUNT(*) AS n FROM appeals WHERE status IN ('open','in_progress') GROUP BY kind"),
    },
    reporters: {
      total: count('SELECT COUNT(*) AS n FROM reporters'),
      verified: count('SELECT COUNT(*) AS n FROM reporters WHERE phone_verified_at IS NOT NULL'),
      byStatus: group('SELECT status AS k, COUNT(*) AS n FROM reporters GROUP BY status'),
    },
    investigationsOpen: count("SELECT COUNT(*) AS n FROM investigations WHERE status = 'open'"),
  });
});

// ───────────────────────── CSV export ─────────────────────────
/** Quote every cell; neutralise spreadsheet formulas (=, +, -, @, tab, CR) with a leading apostrophe. */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

router.get('/export/reports.csv', requirePermission('export:reports'), (req, res) => {
  const includeContact = req.query.includeContact === '1' || req.query.includeContact === 'true';
  let reason = null;
  if (includeContact) {
    // Admin-only, explicit, justified and audited.
    if (!can(req.user, 'export:contacts')) {
      throw new HttpError(403, 'forbidden', 'Only administrators can export contact details.');
    }
    reason = str({ min: 5, max: 1000 })(req.query.reason, 'reason');
  }
  const where = [];
  const args = [];
  if (req.query.status) { oneOf(moderation.STATUSES)(req.query.status, 'status'); where.push('r.status = ?'); args.push(req.query.status); }
  if (req.query.plantCode) { where.push('p.plant_code = ? COLLATE NOCASE'); args.push(String(req.query.plantCode).trim()); }
  const rows = getDb().prepare(`SELECT r.*, p.plant_code, p.town AS plant_town, p.area_raw AS plant_area_raw,
                                  rp.public_alias, rp.phone_enc,
                                  (SELECT COUNT(*) FROM report_photos x WHERE x.report_id = r.id) AS photo_count
                                FROM reports r JOIN plants p ON p.id = r.plant_id LEFT JOIN reporters rp ON rp.id = r.reporter_id
                                ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at, r.id`).all(...args);
  const header = ['reference', 'plant_code', 'town', 'area', 'category', 'severity', 'status', 'observed_at_local', 'created_at', 'updated_at',
    'phone_verified', 'risk_score', 'review_queue', 'photo_count', 'reporter_alias', 'description', 'redacted_at'];
  if (includeContact) header.push('phone');
  const lines = [header.map(csvCell).join(',')];
  let contacts = 0;
  for (const r of rows) {
    const cells = [r.reference, r.plant_code, r.plant_town, r.plant_area_raw, r.category, r.severity, r.status, r.observed_at, r.created_at,
      r.updated_at, r.phone_verified, r.risk_score, r.review_queue, r.photo_count, r.public_alias, r.description, r.redacted_at];
    if (includeContact) {
      const phone = r.phone_enc ? reporters.revealPhone({ phone_enc: r.phone_enc }) : null;
      if (phone) contacts++;
      cells.push(phone);
    }
    lines.push(cells.map(csvCell).join(','));
  }
  audit(req, {
    action: includeContact ? 'export.reports_with_contacts' : 'export.reports', entityType: 'report', entityId: null,
    after: { rows: rows.length, includeContact, contacts, filters: { status: req.query.status || null, plantCode: req.query.plantCode || null } },
    reason,
  });
  const stamp = nowIso().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="reports-${stamp}${includeContact ? '-with-contacts' : ''}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

module.exports = router;
module.exports.csvCell = csvCell;
