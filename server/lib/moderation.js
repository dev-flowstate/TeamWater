'use strict';
// Report moderation: decision state machine, redaction/erasure, public timeline, plant summary.
//
// Reports are not findings. Nothing in this module changes a plant's official status — that is a separate
// admin action (POST /api/admin/plants/:code/status) that requires a documented assessment.
// Nothing is ever auto-rejected or auto-deleted; every decision is a named moderator action with a reason.
const { getDb, tx } = require('./db');
const { HttpError } = require('./http');
const { audit } = require('./audit');
const { nowIso, addDays } = require('./time');
const images = require('./images');
const reporters = require('./reporters');

const STATUSES = ['pending', 'under_review', 'needs_clarification', 'confirmed', 'resolved', 'rejected'];
const OPEN_STATUSES = ['pending', 'under_review', 'needs_clarification'];
const SERIOUS_CATEGORIES = ['color_odor_taste', 'no_water'];
const CATEGORIES = ['closed_during_hours', 'no_water', 'broken_equipment', 'color_odor_taste',
  'dirty_surroundings', 'incorrect_details', 'unexpected_charges', 'other'];

// action → { from: allowed current statuses, to }
// start_review from a closed status re-opens the report (e.g. after an accepted appeal).
const TRANSITIONS = {
  start_review: { from: ['pending', 'needs_clarification', 'confirmed', 'resolved', 'rejected'], to: 'under_review' },
  request_clarification: { from: ['pending', 'under_review'], to: 'needs_clarification' },
  confirm: { from: ['pending', 'under_review', 'needs_clarification'], to: 'confirmed' },
  resolve: { from: ['under_review', 'confirmed'], to: 'resolved' },
  reject: { from: ['pending', 'under_review', 'needs_clarification'], to: 'rejected' },
};
const ACTIONS = Object.keys(TRANSITIONS);

const allowedActions = (status) => ACTIONS.filter((a) => TRANSITIONS[a].from.includes(status));
const severityFor = (category) => (SERIOUS_CATEGORIES.includes(category) ? 'serious' : 'normal');

function addEvent(db, { reportId, actorUserId = null, action, fromStatus = null, toStatus = null, reason = null, publicNote = null, at = nowIso() }) {
  db.prepare(`INSERT INTO report_events (report_id, actor_user_id, action, from_status, to_status, reason, public_note, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(reportId, actorUserId, action, fromStatus, toStatus, reason, publicNote, at);
}

/**
 * Apply a moderator decision. `reason` (internal) is required; `publicNote` is shown on the status page.
 * request_clarification also requires a publicNote (the question the reporter will see).
 */
function applyDecision(req, reportId, { action, reason, publicNote = null }) {
  const t = TRANSITIONS[action];
  if (!t) throw new HttpError(400, 'invalid_input', `action: must be one of: ${ACTIONS.join(', ')}`, { field: 'action' });
  if (!reason || !String(reason).trim()) throw new HttpError(400, 'invalid_input', 'reason: is required', { field: 'reason' });
  if (action === 'request_clarification' && !publicNote) {
    throw new HttpError(400, 'invalid_input', 'publicNote: the question for the reporter is required', { field: 'publicNote' });
  }
  return tx((db) => {
    const report = db.prepare('SELECT id, reference, status, reporter_id FROM reports WHERE id = ?').get(reportId);
    if (!report) throw new HttpError(404, 'not_found', 'Report not found.');
    if (!t.from.includes(report.status)) {
      throw new HttpError(409, 'invalid_transition', `Cannot ${action.replace(/_/g, ' ')} a report that is ${report.status.replace(/_/g, ' ')}.`,
        { field: 'action', status: report.status, allowed: allowedActions(report.status) });
    }
    const now = nowIso();
    db.prepare('UPDATE reports SET status = ?, updated_at = ? WHERE id = ?').run(t.to, now, report.id);
    addEvent(db, {
      reportId: report.id, actorUserId: req.user ? req.user.id : null,
      action: action === 'request_clarification' ? 'clarification_requested' : 'status_change',
      fromStatus: report.status, toStatus: t.to, reason, publicNote, at: now,
    });
    reporters.recount(report.reporter_id);
    audit(req, {
      action: 'report.decision', entityType: 'report', entityId: report.id,
      before: { status: report.status }, after: { status: t.to, action, reference: report.reference, publicNote: publicNote || null }, reason,
    });
    return { id: report.id, reference: report.reference, status: t.to, previousStatus: report.status };
  });
}

/** Remove every photo (rows + files on disk) of the given reports. Returns the number removed. */
function deletePhotosOf(db, reportIds) {
  if (!reportIds.length) return { count: 0, paths: [] };
  const ph = reportIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT rp.id, rp.file_id, f.storage_path FROM report_photos rp JOIN files f ON f.id = rp.file_id
                           WHERE rp.report_id IN (${ph})`).all(...reportIds);
  for (const r of rows) {
    db.prepare('DELETE FROM report_photos WHERE id = ?').run(r.id);
    const stillUsed = db.prepare('SELECT 1 FROM report_photos WHERE file_id = ?').get(r.file_id);
    if (!stillUsed) db.prepare('DELETE FROM files WHERE id = ?').run(r.file_id);
  }
  return { count: rows.length, paths: rows.map((r) => r.storage_path) };
}

/** Redact report text (and reporter replies) and delete photos. Idempotent for already-redacted reports. */
function redactReports(db, reportIds, text) {
  if (!reportIds.length) return { reportsRedacted: 0, photosDeleted: 0, paths: [] };
  const now = nowIso();
  let n = 0;
  for (const id of reportIds) {
    n += Number(db.prepare(`UPDATE reports SET description = ?, text_fingerprint = NULL, redacted_at = ?, updated_at = ?
                            WHERE id = ? AND redacted_at IS NULL`).run(text, now, now, id).changes);
    // Reporter replies are the reporter's own words: redact them too. Moderator reasons are kept (they are our records).
    db.prepare("UPDATE report_events SET reason = ? WHERE report_id = ? AND action = 'reporter_reply'").run(text, id);
  }
  const photos = deletePhotosOf(db, reportIds);
  return { reportsRedacted: n, photosDeleted: photos.count, paths: photos.paths };
}

const DELETION_TEXT = "[redacted at reporter's request]";

/**
 * Complete a deletion request: erase the encrypted number and last 4 digits, redact the reporter's reports,
 * delete their photos, detach their ratings. The keyed phone hash is kept so rate limits and moderator
 * blocks keep working; it cannot be turned back into a number without the server key.
 */
function eraseReporterData(req, reporterId, { reason, appealReference = null } = {}) {
  const result = tx((db) => {
    const reporter = db.prepare('SELECT id FROM reporters WHERE id = ?').get(reporterId);
    if (!reporter) return null;
    db.prepare('UPDATE reporters SET phone_enc = NULL, phone_last4 = NULL, phone_verified_at = NULL WHERE id = ?').run(reporterId);
    const ids = db.prepare('SELECT id FROM reports WHERE reporter_id = ?').all(reporterId).map((r) => r.id);
    const red = redactReports(db, ids, DELETION_TEXT);
    // Reports already redacted by retention still get the deletion wording on their replies above; their text stays redacted.
    const ratings = Number(db.prepare('UPDATE ratings SET reporter_id = NULL WHERE reporter_id = ?').run(reporterId).changes);
    const counts = { reportsRedacted: red.reportsRedacted, photosDeleted: red.photosDeleted, ratingsDetached: ratings, contactErased: true };
    audit(req, { action: 'reporter.erase', entityType: 'reporter', entityId: reporterId, after: { ...counts, appeal: appealReference }, reason });
    return { counts, paths: red.paths };
  });
  if (!result) return null;
  for (const p of result.paths) images.deleteStoredFile(p);
  return result.counts;
}

/** Public status timeline: status changes and public notes only — never internal reasons or risk. */
function publicTimeline(reportId) {
  const events = getDb().prepare(`SELECT action, to_status, public_note, created_at FROM report_events
                                  WHERE report_id = ? AND (to_status IS NOT NULL OR public_note IS NOT NULL)
                                  ORDER BY created_at, id`).all(reportId);
  let current = 'pending';
  return events.map((e) => {
    if (e.to_status) current = e.to_status;
    return { status: current, at: e.created_at, publicNote: e.public_note || null };
  });
}

/**
 * Summary used by the plant detail page (Core API may call this for PlantDetail.reportsSummary).
 * Reports held in the risk review queue and still pending are not counted until a moderator looks at them.
 */
function plantReportsSummary(plantId) {
  const db = getDb();
  const row = db.prepare(`SELECT
      SUM(CASE WHEN status = 'pending' AND review_queue = 0 THEN 1 ELSE 0 END) AS unverified_open,
      SUM(CASE WHEN status IN ('under_review', 'needs_clarification') THEN 1 ELSE 0 END) AS under_review,
      SUM(CASE WHEN status = 'resolved' AND updated_at >= ? THEN 1 ELSE 0 END) AS resolved_90d
    FROM reports WHERE plant_id = ?`).get(addDays(nowIso(), -90), plantId);
  const confirmed = db.prepare(`SELECT r.category,
        (SELECT e.created_at FROM report_events e WHERE e.report_id = r.id AND e.to_status = 'confirmed' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS confirmed_at,
        (SELECT e.public_note FROM report_events e WHERE e.report_id = r.id AND e.to_status = 'confirmed' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS public_note
      FROM reports r WHERE r.plant_id = ? AND r.status = 'confirmed' ORDER BY r.updated_at DESC`).all(plantId);
  return {
    unverifiedOpen: row.unverified_open || 0,
    underReview: row.under_review || 0,
    confirmedOpenIssues: confirmed.map((c) => ({ category: c.category, confirmedAt: c.confirmed_at, publicNote: c.public_note || null })),
    resolvedLast90d: row.resolved_90d || 0,
  };
}

module.exports = {
  STATUSES, OPEN_STATUSES, SERIOUS_CATEGORIES, CATEGORIES, TRANSITIONS, ACTIONS, DELETION_TEXT,
  allowedActions, severityFor, addEvent, applyDecision, deletePhotosOf, redactReports, eraseReporterData,
  publicTimeline, plantReportsSummary,
};
