'use strict';
// Public community endpoints (no account). See docs/ARCHITECTURE.md §6 "Reports & ratings".
//   POST /api/reports            multipart report (+ optional separate rating, photos, proximity)
//   POST /api/ratings            experience rating (separate record; one per phone per plant)
//   POST /api/verify/start       send an SMS code          POST /api/verify/confirm   check it → token
//   GET  /api/reports/status     reference + last 4 digits  POST /api/reports/reply    answer a clarification
//   POST /api/appeals            correction | appeal | deletion_request
//   GET  /api/photos/:id         approved AND public photos only
//
// Privacy: phone numbers never appear in any response or log line. Shared coordinates are used once to
// compute a distance to the plant and then discarded. Risk scores, reasons and the review threshold are
// internal and never returned here. Complaints and ratings are separate records: a report only creates a
// rating when the person explicitly chose stars in the optional rating field.
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { getDb, tx } = require('../lib/db');
const { HttpError, validate, str, int, num, oneOf, bool } = require('../lib/http');
const { normalizePhone, hashPhone, hashSubject, reference } = require('../lib/crypto');
const { rateCheck, rateRecord, rateCount } = require('../lib/ratelimit');
const { nowIso, addDays, TZ } = require('../lib/time');
const images = require('../lib/images');
const sms = require('../lib/sms');
const risk = require('../lib/risk');
const reporters = require('../lib/reporters');
const moderation = require('../lib/moderation');

const router = express.Router();

const HOUR = 3600e3;
const LIMITS = {
  reportPerIp: { windowMs: HOUR, max: 10 },
  reportPerPhone: { windowMs: 24 * HOUR, max: 5 },
  reportCooldown: { windowMs: 30 * 60e3, max: 1 }, // same phone, same plant
  ratingPerIp: { windowMs: HOUR, max: 30 },
  statusPerIp: { windowMs: 10 * 60e3, max: 60 },
  statusFailPerIp: { windowMs: HOUR, max: 20 },
  statusFailPerRef: { windowMs: HOUR, max: 10 },
  appealPerIp: { windowMs: HOUR, max: 10 },
  appealPerPhone: { windowMs: 24 * HOUR, max: 5 },
};

const ipSubject = (req) => hashSubject(req.ip);
const bad = (field, message, code = 'invalid_input', status = 400) => new HttpError(status, code, message, { field });

function enforce(res, result, message) {
  if (result.allowed) return;
  res.setHeader('Retry-After', String(result.retryAfterSec));
  throw new HttpError(429, 'rate_limited', message, { retryAfterSec: result.retryAfterSec });
}

function requirePhone(value) {
  const e164 = normalizePhone(value);
  if (!e164) throw bad('phone', 'phone: enter a Pakistani phone number, e.g. 0300 1234567');
  return e164;
}

function requireConsent(value) {
  if (value !== true) throw bad('consent', 'consent: please confirm that you agree to how we use your report and phone number');
}

function findPlant(code) {
  const p = getDb().prepare('SELECT * FROM plants WHERE plant_code = ? COLLATE NOCASE').get(String(code || '').trim());
  if (!p || (p.is_demo && !config.demoData)) {
    throw bad('plantCode', 'We could not find that plant. Please choose it again from the map or list.', 'unknown_plant', 422);
  }
  return p;
}

const isHoneypot = (body) => body && body.website !== undefined && body.website !== null && String(body.website).trim() !== '';

// ── observedAt: 'YYYY-MM-DDTHH:MM' wall-clock time in Asia/Karachi ──
const FUTURE_TOLERANCE_MS = 5 * 60e3; // clock skew between phone and server
const MAX_AGE_DAYS = 90;
const karachiFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function karachiOffsetMs(instantMs) {
  const p = Object.fromEntries(karachiFmt.formatToParts(new Date(instantMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}
function parseObservedAt(value, nowMs = Date.now()) {
  const s = String(value ?? '').trim();
  if (!s) throw bad('observedAt', 'observedAt: is required');
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (!m) throw bad('observedAt', 'observedAt: use the format YYYY-MM-DDTHH:MM');
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const c = new Date(wall);
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d || h > 23 || mi > 59) {
    throw bad('observedAt', 'observedAt: is not a real date and time');
  }
  const instant = wall - karachiOffsetMs(wall - 5 * HOUR);
  if (instant > nowMs + FUTURE_TOLERANCE_MS) throw bad('observedAt', 'observedAt: cannot be in the future');
  if (instant < nowMs - MAX_AGE_DAYS * 24 * HOUR) throw bad('observedAt', `observedAt: must be within the last ${MAX_AGE_DAYS} days`);
  const pad = (n) => String(n).padStart(2, '0');
  return { local: `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`, instant };
}

// ── multipart parsing with clear, field-specific errors ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.floor(config.uploads.maxPhotoBytes),
    files: Math.floor(config.uploads.maxPhotos),
    fields: 30,
    fieldSize: 64 * 1024,
    parts: 40,
  },
}).array('photos', Math.floor(config.uploads.maxPhotos));

function parseMultipart(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.name !== 'MulterError') return next(err);
    const mb = Math.round((config.uploads.maxPhotoBytes / 1048576) * 10) / 10;
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return next(new HttpError(400, 'file_too_large', `Each photo must be ${mb} MB or smaller.`, { field: 'photos', maxPhotoMb: mb }));
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
        if (err.field && err.field !== 'photos') return next(bad(err.field, 'Unexpected file field.', 'upload_rejected'));
        return next(new HttpError(400, 'too_many_files', `You can attach at most ${config.uploads.maxPhotos} photos.`, { field: 'photos', maxPhotos: config.uploads.maxPhotos }));
      default:
        return next(bad(err.field || 'photos', 'The upload could not be read. Please try again.', 'upload_rejected'));
    }
  });
}

function ipGate(bucket, limit, message) {
  return (req, res, next) => {
    try { enforce(res, rateCheck(bucket, ipSubject(req), limit), message); next(); } catch (err) { next(err); }
  };
}

// ── ratings (shared by POST /ratings and the optional rating on a report) ──
function upsertRating(db, { plant, reporter, stars, ipSubj, honeypot = false, heldWithReport = false }) {
  const assessment = risk.assessRating({
    plant, reporter, honeypot, heldWithReport, ipRecent: rateCount('rating:ip', ipSubj, HOUR),
  });
  const now = nowIso();
  const existing = db.prepare('SELECT id FROM ratings WHERE plant_id = ? AND reporter_id = ? ORDER BY id').all(plant.id, reporter.id);
  let id;
  if (existing.length) {
    id = existing[0].id;
    db.prepare('UPDATE ratings SET stars = ?, status = ?, risk_score = ?, risk_reasons_json = ?, created_at = ? WHERE id = ?')
      .run(stars, assessment.status, assessment.score, JSON.stringify(assessment.reasons), now, id);
    for (const extra of existing.slice(1)) db.prepare('DELETE FROM ratings WHERE id = ?').run(extra.id);
  } else {
    id = Number(db.prepare(`INSERT INTO ratings (plant_id, reporter_id, stars, status, risk_score, risk_reasons_json, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(plant.id, reporter.id, stars, assessment.status, assessment.score, JSON.stringify(assessment.reasons), now).lastInsertRowid);
  }
  rateRecord('rating:ip', ipSubj);
  return { id, status: assessment.status, replaced: existing.length > 0 };
}

const RATING_NOTE = 'Ratings describe people\'s experiences. They are not water-quality test results and do not show that water is safe.';

function verificationInfo(smsEnabled, tokenGiven, verified) {
  if (verified) return { available: true, status: 'verified', message: `Your phone number is verified. ${sms.PROOF_NOTE}` };
  if (!smsEnabled) return { available: false, status: 'unavailable', message: 'Phone verification is not available right now, so this report is marked as unverified. It will still be reviewed.' };
  if (tokenGiven) return { available: true, status: 'token_invalid', message: 'Your phone verification had expired, so this report is marked as unverified. It will still be reviewed.' };
  return { available: true, status: 'unverified', message: `This report is marked as unverified because the phone number was not verified. It will still be reviewed. ${sms.PROOF_NOTE}` };
}

// ───────────────────────── POST /api/reports ─────────────────────────
router.post('/reports',
  ipGate('report:ip', LIMITS.reportPerIp, 'Too many reports from this connection. Please try again later.'),
  parseMultipart,
  (req, res) => {
    const body = req.body || {};
    const files = req.files || [];
    const v = validate(body, {
      plantCode: str({ max: 40 }),
      category: oneOf(moderation.CATEGORIES),
      description: str({ min: 10, max: 2000 }),
      phone: str({ max: 40 }),
      consent: bool(),
      rating: int({ min: 1, max: 5, optional: true }),
      shareProximity: bool({ optional: true }),
      verificationToken: str({ max: 200, optional: true }),
      lang: str({ max: 10, optional: true }),
    });
    const observed = parseObservedAt(body.observedAt);
    requireConsent(v.consent);
    const e164 = requirePhone(v.phone);
    const plant = findPlant(v.plantCode);
    const honeypot = isHoneypot(body);

    // Proximity: compute a distance, then drop the coordinates. They are never stored or logged.
    let proximity = null;
    if (v.shareProximity) {
      const lat = num({ min: -90, max: 90 })(body.proximityLat, 'proximityLat');
      const lng = num({ min: -180, max: 180 })(body.proximityLng, 'proximityLng');
      proximity = risk.proximityToPlant(plant, lat, lng);
    }
    delete body.proximityLat;
    delete body.proximityLng;

    // Hard limits (429). Checked before any photo work.
    const phoneHash = hashPhone(e164);
    const cooldownSubject = `${phoneHash}|plant:${plant.id}`;
    enforce(res, rateCheck('report:phone-plant', cooldownSubject, LIMITS.reportCooldown),
      'You reported this plant a short time ago. Please wait before sending another report about the same plant.');
    enforce(res, rateCheck('report:phone', phoneHash, LIMITS.reportPerPhone),
      'This phone number has reached the daily limit for reports. Please try again later.');

    if (files.length > config.uploads.maxPhotos) {
      throw new HttpError(400, 'too_many_files', `You can attach at most ${config.uploads.maxPhotos} photos.`, { field: 'photos' });
    }
    const processed = files.map((f, index) => images.processPhoto(f.buffer, { index }));

    const smsState = sms.smsStatus();
    const verified = v.verificationToken ? sms.checkToken(e164, v.verificationToken) : false;
    const existing = reporters.findByPhone(e164);
    const assessment = risk.assessReport({
      plant, reporter: existing, description: v.description, photoHashes: processed.map((p) => p.sha256),
      proximity, phoneVerified: verified, smsEnabled: smsState.enabled, honeypot,
    });
    const severity = moderation.severityFor(v.category);
    const lang = ['en', 'ur'].includes(v.lang) ? v.lang : null;
    const ipSubj = ipSubject(req);

    // HONEYPOT DECISION: a filled hidden field is silently accepted (201, identical response) and the report is
    // stored in the review queue with reason `honeypot`, rather than rejected. Rejecting would tell bots which
    // field gave them away, and a real person whose browser autofilled the field would lose a genuine report.
    // Abuse signals are never proof, so a moderator makes the call.
    const stored = [];
    let result;
    try {
      for (const p of processed) stored.push({ ...p, ...images.storePhoto(p) });
      result = tx((db) => {
        const reporter = reporters.upsertReporter(e164, { verified });
        const now = nowIso();
        let ref;
        do { ref = reference('TW'); } while (db.prepare('SELECT 1 FROM reports WHERE reference = ?').get(ref));
        const reportId = Number(db.prepare(`INSERT INTO reports (reference, plant_id, reporter_id, category, description, observed_at,
              consent_contact, phone_verified, status, severity, risk_score, risk_reasons_json, review_queue, proximity_shared,
              proximity_distance_m, text_fingerprint, lang, created_at, updated_at, retention_until)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(ref, plant.id, reporter.id, v.category, v.description, observed.local, verified ? 1 : 0, severity,
            assessment.score, JSON.stringify(assessment.reasons), assessment.reviewQueue ? 1 : 0, v.shareProximity ? 1 : 0,
            proximity ? proximity.distanceM : null, assessment.fingerprint, lang, now, now, addDays(now, config.retention.reportDays))
          .lastInsertRowid);
        for (const s of stored) {
          const fileId = db.prepare(`INSERT INTO files (kind, storage_path, original_name, mime, size_bytes, sha256, metadata_stripped, created_at)
                                     VALUES ('report_photo', ?, NULL, ?, ?, ?, 1, ?)`)
            .run(s.storagePath, s.mime, s.sizeBytes, s.sha256, now).lastInsertRowid;
          db.prepare('INSERT INTO report_photos (report_id, file_id) VALUES (?, ?)').run(reportId, fileId);
        }
        moderation.addEvent(db, { reportId, action: 'submitted', toStatus: 'pending', at: now });
        if (assessment.reviewQueue) {
          moderation.addEvent(db, {
            reportId, action: 'auto_flagged', at: now,
            reason: `Placed in the review queue by risk signals: ${assessment.reasons.filter((r) => r.weight > 0).map((r) => r.code).join(', ')}. Signals are not proof.`,
          });
        }
        const rating = v.rating
          ? upsertRating(db, { plant, reporter, stars: v.rating, ipSubj, honeypot, heldWithReport: assessment.reviewQueue })
          : null;
        rateRecord('report:ip', ipSubj);
        rateRecord('report:phone', phoneHash);
        rateRecord('report:phone-plant', cooldownSubject);
        return { ref, rating };
      });
    } catch (err) {
      for (const s of stored) images.deleteStoredFile(s.storagePath);
      throw err;
    }

    res.status(201).json({
      reference: result.ref,
      status: 'pending',
      phoneVerified: verified,
      ratingRecorded: Boolean(result.rating),
      ...(result.rating ? { ratingStatus: result.rating.status } : {}),
      photoCount: stored.length,
      statusUrl: `/status.html?ref=${result.ref}`,
      verification: verificationInfo(smsState.enabled, Boolean(v.verificationToken), verified),
      message: 'Thank you. Your report has been received. Reports are checked by moderators and are not treated as confirmed findings. '
        + 'Keep your reference and the last 4 digits of your phone number to check its status.',
    });
  });

// ───────────────────────── POST /api/ratings ─────────────────────────
router.post('/ratings', ipGate('rating:ip', LIMITS.ratingPerIp, 'Too many ratings from this connection. Please try again later.'), (req, res) => {
  const body = req.body || {};
  const v = validate(body, {
    plantCode: str({ max: 40 }),
    stars: int({ min: 1, max: 5 }),
    phone: str({ max: 40 }),
    consent: bool(),
    verificationToken: str({ max: 200, optional: true }),
  });
  requireConsent(v.consent);
  const e164 = requirePhone(v.phone);
  const plant = findPlant(v.plantCode);
  const verified = v.verificationToken ? sms.checkToken(e164, v.verificationToken) : false;
  const ipSubj = ipSubject(req);
  const result = tx((db) => {
    const reporter = reporters.upsertReporter(e164, { verified });
    return upsertRating(db, { plant, reporter, stars: v.stars, ipSubj, honeypot: isHoneypot(body) });
  });
  res.status(result.replaced ? 200 : 201).json({
    status: result.status,
    replaced: result.replaced,
    message: (result.status === 'accepted' ? 'Thank you. Your rating has been recorded.' : 'Thank you. Your rating will appear after a moderator checks it.')
      + (result.replaced ? ' It replaces your earlier rating of this plant.' : '') + ' ' + RATING_NOTE,
  });
});

// ───────────────────────── SMS verification ─────────────────────────
router.post('/verify/start', async (req, res) => {
  const body = req.body || {};
  const { phone } = validate(body, { phone: str({ max: 40 }) });
  const e164 = requirePhone(phone);
  res.json(await sms.startVerification(e164, { ipSubject: ipSubject(req), lang: body.lang === 'ur' ? 'ur' : 'en' }));
});

router.post('/verify/confirm', (req, res) => {
  const { phone, code } = validate(req.body || {}, { phone: str({ max: 40 }), code: str({ max: 12 }) });
  const e164 = requirePhone(phone);
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) throw bad('code', 'code: enter the 6-digit code from the SMS', 'invalid_code');
  res.json(sms.confirmVerification(e164, clean, { ipSubject: ipSubject(req) }));
});

// ───────────────────────── Status page & clarification reply ─────────────────────────
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Looks up a report by reference + last 4 digits of the reporter's phone. Rate-limited; failures are indistinguishable. */
function lookupOwnReport(req, res, input) {
  const ip = ipSubject(req);
  enforce(res, rateCheck('status:ip', ip, LIMITS.statusPerIp), 'Too many requests. Please wait a few minutes.');
  rateRecord('status:ip', ip);
  const ref = String(input.reference ?? input.ref ?? '').trim().toUpperCase();
  const last4 = String(input.last4 ?? '').trim();
  if (!ref) throw bad('reference', 'reference: is required');
  if (!/^TW-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(ref)) throw bad('reference', 'reference: should look like TW-XXXX-XXXX');
  if (!/^\d{4}$/.test(last4)) throw bad('last4', 'last4: enter the last 4 digits of the phone number you used');
  const refSubject = hashSubject('ref|' + ref, { rotateDaily: false });
  enforce(res, rateCheck('status:fail-ref', refSubject, LIMITS.statusFailPerRef), 'Too many attempts for this reference. Please try again later.');
  enforce(res, rateCheck('status:fail-ip', ip, LIMITS.statusFailPerIp), 'Too many attempts. Please try again later.');
  const row = getDb().prepare(`SELECT r.*, p.plant_code, p.name AS plant_name, p.town AS plant_town, p.area_raw AS plant_area_raw,
                                      rp.phone_last4 AS reporter_last4
                               FROM reports r JOIN plants p ON p.id = r.plant_id LEFT JOIN reporters rp ON rp.id = r.reporter_id
                               WHERE r.reference = ?`).get(ref);
  if (!row || !row.reporter_last4 || !safeEqual(row.reporter_last4, last4)) {
    rateRecord('status:fail-ref', refSubject);
    rateRecord('status:fail-ip', ip);
    throw new HttpError(404, 'not_found', 'No report matches that reference and phone digits. Please check both and try again.');
  }
  return row;
}

router.get('/reports/status', (req, res) => {
  const row = lookupOwnReport(req, res, req.query);
  res.json({
    reference: row.reference,
    plant: { code: row.plant_code, name: row.plant_name, town: row.plant_town, areaRaw: row.plant_area_raw },
    category: row.category,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timeline: moderation.publicTimeline(row.id),
    canReply: row.status === 'needs_clarification',
    canAppeal: ['rejected', 'resolved'].includes(row.status),
    redacted: Boolean(row.redacted_at),
  });
});

router.post('/reports/reply', (req, res) => {
  const body = req.body || {};
  const { message } = validate(body, { message: str({ min: 2, max: 2000 }) });
  const row = lookupOwnReport(req, res, body);
  if (row.status !== 'needs_clarification') {
    throw new HttpError(409, 'not_awaiting_reply', 'This report is not waiting for more information.', { status: row.status });
  }
  tx((db) => {
    const now = nowIso();
    const changed = db.prepare("UPDATE reports SET status = 'under_review', updated_at = ? WHERE id = ? AND status = 'needs_clarification'")
      .run(now, row.id).changes;
    if (!changed) throw new HttpError(409, 'not_awaiting_reply', 'This report is not waiting for more information.');
    // The reply text is stored as the event's internal `reason`: moderators see it, the public timeline never does.
    moderation.addEvent(db, { reportId: row.id, action: 'reporter_reply', fromStatus: 'needs_clarification', toStatus: 'under_review', reason: message, at: now });
    if (row.reporter_id) reporters.touch(row.reporter_id);
  });
  res.json({ ok: true, status: 'under_review', message: 'Thank you. Your reply has been sent to the moderators.' });
});

// ───────────────────────── POST /api/appeals ─────────────────────────
const APPEAL_MESSAGES = {
  correction: 'Thank you. A moderator will review your correction.',
  appeal: 'Thank you. A moderator will review your appeal.',
  deletion_request: 'We received your deletion request. When a moderator completes it, your phone number is erased and the text and photos of your reports are removed.',
};

router.post('/appeals', ipGate('appeal:ip', LIMITS.appealPerIp, 'Too many requests from this connection. Please try again later.'), (req, res) => {
  const v = validate(req.body || {}, {
    kind: oneOf(['correction', 'appeal', 'deletion_request']),
    reference: str({ max: 20, optional: true }),
    plantCode: str({ max: 40, optional: true }),
    phone: str({ max: 40 }),
    message: str({ min: 10, max: 2000 }),
  });
  const e164 = requirePhone(v.phone);
  const phoneHash = hashPhone(e164);
  enforce(res, rateCheck('appeal:phone', phoneHash, LIMITS.appealPerPhone), 'Too many requests for this phone number today. Please try again later.');
  const db = getDb();
  let report = null;
  if (v.reference) {
    report = db.prepare('SELECT id, plant_id, reporter_id FROM reports WHERE reference = ?').get(v.reference.toUpperCase());
    if (!report) throw bad('reference', 'We could not find a report with that reference.', 'unknown_report', 422);
  }
  let plantId = null;
  if (v.plantCode) plantId = findPlant(v.plantCode).id;

  const apRef = tx(() => {
    // Matched by phone hash. Deletion requests never create a reporter record; corrections and appeals keep
    // the (encrypted) number so a moderator can follow up if needed.
    let reporter = reporters.findByPhone(e164);
    if (v.kind !== 'deletion_request') reporter = reporters.upsertReporter(e164);
    let linkedReport = report;
    // A deletion request only ever acts on the requester's own reports.
    if (v.kind === 'deletion_request' && report && (!reporter || report.reporter_id !== reporter.id)) linkedReport = null;
    let ref;
    do { ref = reference('AP'); } while (db.prepare('SELECT 1 FROM appeals WHERE reference = ?').get(ref));
    db.prepare(`INSERT INTO appeals (reference, kind, report_id, plant_id, reporter_id, message, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(ref, v.kind, linkedReport ? linkedReport.id : null, plantId ?? (linkedReport ? linkedReport.plant_id : null),
        reporter ? reporter.id : null, v.message, nowIso());
    if (linkedReport) moderation.addEvent(db, { reportId: linkedReport.id, action: 'appeal', reason: `${v.kind.replace('_', ' ')} ${ref} received` });
    rateRecord('appeal:ip', ipSubject(req));
    rateRecord('appeal:phone', phoneHash);
    return ref;
  });
  res.status(201).json({ reference: apRef, message: APPEAL_MESSAGES[v.kind] });
});

// ───────────────────────── GET /api/photos/:id ─────────────────────────
router.get('/photos/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'not_found', 'Not found');
  const row = getDb().prepare(`SELECT f.storage_path, f.mime FROM report_photos rp
                                 JOIN files f ON f.id = rp.file_id JOIN reports r ON r.id = rp.report_id
                               WHERE rp.id = ? AND rp.moderation_status = 'approved' AND rp.public = 1
                                 AND r.redacted_at IS NULL AND r.status != 'rejected'`).get(id);
  const buf = row && images.readStoredFile(row.storage_path);
  if (!buf) throw new HttpError(404, 'not_found', 'Not found');
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.end(buf);
});

module.exports = router;
module.exports.parseObservedAt = parseObservedAt;
