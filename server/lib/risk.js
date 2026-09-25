'use strict';
// Abuse-signal scoring for community reports and ratings.
//
// PRINCIPLE: these signals help moderators decide what to look at first. They never prove that a report
// is false, and nothing here rejects, deletes or hides anything. A high score only sets review_queue=1.
// The review threshold (env RISK_REVIEW_THRESHOLD, default 40) is private and never sent in any response.
//
// Deliberately NOT penalised (the brief says these can all be valid): being a new reporter, sending no photo,
// not sharing location, sharing a location far from the plant (people often report after leaving).
// No device fingerprinting is used.
//
// Report signals — each reason is { code, detail, weight }; the score is the clamped sum (0–100):
//   honeypot             +60  hidden form field filled in (always queued)
//   duplicate_text       +40  same normalised text as another report in the last 30 days (+20 if under 6 words)
//   near_duplicate_text  +30  word-shingle Jaccard ≥ 0.8 with a report in the last 30 days (texts ≥ 5 words)
//   duplicate_image      +25  identical photo (sha256 of the stripped bytes) already attached to another report
//   plant_burst          +15  ≥ 3 other phones reported this plant in the last hour (+25 at ≥ 6)
//   reporter_burst       +20  this phone reported ≥ 2 other plants in the last hour (+35 at ≥ 4)
//   repeated_targeting   +15  this phone reported this plant ≥ 2 times in 7 days (+25 at ≥ 4), or
//                             ≥ 3 plants of the same named operator in 7 days
//   reporter_history     +10…+30  ≥ 50 % of this phone's decided reports were rejected (min. 2 decided)
//   reporter_history_good −5   ≥ 3 confirmed and none rejected
//   reporter_restricted  +25   / reporter_blocked +50
//   unverified_phone     +5   only when SMS verification is actually available; never enough on its own
//   proximity_near       −10  shared location within 500 m of the plant's exact position
//                        −5   within the area radius (min 500 m) of an approximate area centre
//   proximity_far          0  shared and far — recorded for context, no penalty
const { getDb } = require('./db');
const { sha256 } = require('./crypto');
const { normalizeSearch } = require('./text');
const { nowIso, addDays } = require('./time');

const reviewThreshold = () => {
  const n = Number(process.env.RISK_REVIEW_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 40;
};

function riskLevel(score) {
  const t = reviewThreshold();
  if (score >= t) return 'high';
  if (score >= t / 2) return 'medium';
  return 'low';
}

// ───────────── text similarity ─────────────
const words = (text) => normalizeSearch(text).split(' ').filter(Boolean);

/** Stable fingerprint of the normalised text (case, punctuation, spacing and diacritics ignored). */
function fingerprint(text) {
  const w = words(text);
  return w.length ? sha256('fp|' + w.join(' ')).slice(0, 32) : null;
}

/** Word 2-shingles (single words for one-word texts). */
function shingles(text) {
  const w = Array.isArray(text) ? text : words(text);
  const set = new Set();
  if (w.length < 2) { w.forEach((x) => set.add(x)); return set; }
  for (let i = 0; i < w.length - 1; i++) set.add(w[i] + ' ' + w[i + 1]);
  return set;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const NEAR_DUP = 0.8;
const MIN_WORDS_NEAR = 5;

/**
 * Reports whose text is similar to `text`, within [sinceIso, untilIso], excluding `excludeId`.
 * Returns [{ id, reference, plantId, reporterId, status, createdAt, similarity, exact }], best first.
 */
function findSimilar(text, { sinceIso, untilIso = null, excludeId = null, minSimilarity = NEAR_DUP, limit = 20 } = {}) {
  const w = words(text);
  const fp = fingerprint(text);
  const mine = shingles(w);
  const rows = getDb().prepare(`SELECT id, reference, plant_id, reporter_id, status, created_at, description, text_fingerprint
      FROM reports WHERE created_at >= ? AND (? IS NULL OR created_at <= ?) AND redacted_at IS NULL AND (? IS NULL OR id != ?)
      ORDER BY created_at DESC LIMIT 3000`)
    .all(sinceIso, untilIso, untilIso, excludeId, excludeId);
  const out = [];
  for (const r of rows) {
    const exact = fp !== null && r.text_fingerprint === fp;
    let similarity = exact ? 1 : 0;
    if (!exact) {
      const other = words(r.description);
      if (Math.min(w.length, other.length) < MIN_WORDS_NEAR && minSimilarity >= NEAR_DUP) continue;
      similarity = jaccard(mine, shingles(other));
    }
    if (similarity >= minSimilarity) {
      out.push({ id: r.id, reference: r.reference, plantId: r.plant_id, reporterId: r.reporter_id, status: r.status,
        createdAt: r.created_at, similarity: Math.round(similarity * 100) / 100, exact });
    }
  }
  out.sort((a, b) => b.similarity - a.similarity || (a.createdAt < b.createdAt ? 1 : -1));
  return out.slice(0, limit);
}

// ───────────── geometry ─────────────
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from a shared position to the plant. Uses the plant's exact position when it has one,
 * otherwise its area centre (approximate). The caller discards the coordinates afterwards.
 * → { distanceM, basis: 'exact'|'area_centre', radiusM } or null when the plant has no position at all.
 */
function proximityToPlant(plant, lat, lng) {
  const exact = ['source', 'verified'].includes(plant.coord_status) && plant.latitude != null && plant.longitude != null;
  if (exact) return { distanceM: Math.round(haversineM(lat, lng, plant.latitude, plant.longitude)), basis: 'exact', radiusM: null };
  if (plant.area_id) {
    const area = getDb().prepare(`SELECT latitude, longitude, radius_m FROM areas WHERE id = ? AND latitude IS NOT NULL
                                  AND longitude IS NOT NULL AND geocode_status IN ('matched', 'manual')`).get(plant.area_id);
    if (area) return { distanceM: Math.round(haversineM(lat, lng, area.latitude, area.longitude)), basis: 'area_centre', radiusM: area.radius_m || null };
  }
  return null;
}

// ───────────── report assessment ─────────────
const HOUR = 3600e3;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

/**
 * ctx: { plant (row), reporter (row|null), description, photoHashes: [sha256], proximity: {distanceM, basis, radiusM}|null,
 *        phoneVerified, smsEnabled, honeypot }
 * → { score, reasons, reviewQueue, fingerprint }
 */
function assessReport(ctx) {
  const db = getDb();
  const reasons = [];
  const add = (code, weight, detail) => reasons.push({ code, detail, weight });
  const reporterId = ctx.reporter ? ctx.reporter.id : null;
  const since30d = addDays(nowIso(), -30);

  if (ctx.honeypot) add('honeypot', 60, 'A hidden form field that people cannot see was filled in (typical of automated submissions).');

  // Duplicate / near-duplicate text
  const w = words(ctx.description);
  const similar = findSimilar(ctx.description, { sinceIso: since30d, limit: 50 });
  const exact = similar.filter((s) => s.exact);
  const near = similar.filter((s) => !s.exact);
  const refs = (list) => list.slice(0, 3).map((s) => s.reference).join(', ') + (list.length > 3 ? ', …' : '');
  const fromOthers = (list) => list.filter((s) => s.reporterId !== reporterId || reporterId === null).length;
  if (exact.length) {
    const weight = w.length < 6 ? 20 : 40;
    add('duplicate_text', weight, `Same text as ${exact.length} report(s) in the last 30 days (${refs(exact)}); ${fromOthers(exact)} from other phones.` +
      (w.length < 6 ? ' Short text, so matches may be coincidental.' : ''));
  } else if (near.length) {
    add('near_duplicate_text', 30, `Text is ${Math.round(near[0].similarity * 100)}% similar to ${near.length} report(s) in the last 30 days (${refs(near)}).`);
  }

  // Duplicate image (hash of the metadata-stripped bytes)
  const hashes = [...new Set(ctx.photoHashes || [])];
  if (hashes.length) {
    const dup = db.prepare(`SELECT DISTINCT r.reference FROM files f JOIN report_photos rp ON rp.file_id = f.id
                            JOIN reports r ON r.id = rp.report_id
                            WHERE f.kind = 'report_photo' AND f.sha256 IN (${hashes.map(() => '?').join(',')})`).all(...hashes);
    if (dup.length) add('duplicate_image', 25, `A photo is identical to one attached to ${dup.length} earlier report(s) (${dup.slice(0, 3).map((d) => d.reference).join(', ')}).`);
  }

  // Burst on this plant from different phones in the last hour
  const burst = db.prepare(`SELECT COUNT(*) AS c, COUNT(DISTINCT reporter_id) AS phones FROM reports
                            WHERE plant_id = ? AND created_at >= ? AND (? IS NULL OR reporter_id IS NULL OR reporter_id != ?)`)
    .get(ctx.plant.id, isoAgo(HOUR), reporterId, reporterId);
  if (burst.phones >= 3) {
    add('plant_burst', burst.phones >= 6 ? 25 : 15, `${burst.c} other report(s) from ${burst.phones} different phones about this plant in the last hour. A real outage can also cause this.`);
  }

  if (reporterId) {
    const r = ctx.reporter;
    // Burst by this reporter across plants
    const plants1h = db.prepare('SELECT COUNT(DISTINCT plant_id) AS n FROM reports WHERE reporter_id = ? AND created_at >= ? AND plant_id != ?')
      .get(reporterId, isoAgo(HOUR), ctx.plant.id).n;
    if (plants1h >= 2) add('reporter_burst', plants1h >= 4 ? 35 : 20, `This phone reported ${plants1h} other plant(s) in the last hour.`);

    // Repeated targeting of the same plant / operator within 7 days
    const since7d = addDays(nowIso(), -7);
    const samePlant = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND plant_id = ? AND created_at >= ?')
      .get(reporterId, ctx.plant.id, since7d).n;
    let operatorCount = 0;
    if (ctx.plant.operator_name) {
      operatorCount = db.prepare(`SELECT COUNT(DISTINCT r.plant_id) AS n FROM reports r JOIN plants p ON p.id = r.plant_id
                                  WHERE r.reporter_id = ? AND r.created_at >= ? AND r.plant_id != ? AND p.operator_name = ? COLLATE NOCASE`)
        .get(reporterId, since7d, ctx.plant.id, ctx.plant.operator_name).n;
    }
    if (samePlant >= 2) {
      add('repeated_targeting', samePlant >= 4 ? 25 : 15, `This phone already reported this plant ${samePlant} time(s) in the last 7 days.`);
    } else if (operatorCount >= 2) {
      add('repeated_targeting', 15, `This phone reported ${operatorCount} other plant(s) of the same operator in the last 7 days.`);
    }

    // History
    const decided = r.confirmed_reports + r.rejected_reports;
    if (decided >= 2 && r.rejected_reports / decided >= 0.5) {
      const ratio = r.rejected_reports / decided;
      add('reporter_history', Math.round(10 + 20 * (ratio - 0.5) * 2), `${r.rejected_reports} of ${decided} earlier decided report(s) from this phone were rejected.`);
    } else if (r.confirmed_reports >= 3 && r.rejected_reports === 0) {
      add('reporter_history_good', -5, `${r.confirmed_reports} earlier report(s) from this phone were confirmed and none rejected.`);
    }
    if (r.status === 'restricted') add('reporter_restricted', 25, 'A moderator restricted this reporter' + (r.status_reason ? `: ${r.status_reason}` : '.'));
    if (r.status === 'blocked') add('reporter_blocked', 50, 'A moderator blocked this reporter' + (r.status_reason ? `: ${r.status_reason}` : '.'));
  }

  if (ctx.smsEnabled && !ctx.phoneVerified) add('unverified_phone', 5, 'Phone number not verified by SMS (verification is optional; this alone never triggers review).');

  if (ctx.proximity) {
    const { distanceM, basis, radiusM } = ctx.proximity;
    if (basis === 'exact' && distanceM <= 500) {
      add('proximity_near', -10, `Reporter shared a location about ${distanceM} m from the plant.`);
    } else if (basis === 'area_centre' && distanceM <= Math.max(500, radiusM || 0)) {
      add('proximity_near', -5, `Reporter shared a location about ${distanceM} m from the plant's area centre (approximate: the plant has no exact position).`);
    } else {
      add('proximity_far', 0, `Reporter shared a location about ${distanceM} m from the plant${basis === 'area_centre' ? "'s area centre (approximate)" : ''}. Not penalised: people often report after leaving.`);
    }
  }

  const sum = reasons.reduce((s, x) => s + x.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(sum)));
  return { score, reasons, reviewQueue: Boolean(ctx.honeypot) || score >= reviewThreshold(), fingerprint: fingerprint(ctx.description) };
}

// ───────────── rating assessment ─────────────
/**
 * Ratings: low-risk ratings are accepted immediately; bursts or a phone rating many plants quickly → pending.
 * ctx: { plant, reporter, ipSubject, honeypot, heldWithReport } → { score, reasons, status: 'accepted'|'pending' }
 */
function assessRating(ctx) {
  const db = getDb();
  const reasons = [];
  const add = (code, weight, detail) => reasons.push({ code, detail, weight });
  const reporterId = ctx.reporter ? ctx.reporter.id : null;
  const since = isoAgo(HOUR);

  if (ctx.honeypot) add('honeypot', 60, 'A hidden form field was filled in.');
  if (ctx.heldWithReport) add('report_flagged', 40, 'Sent together with a report that was placed in the review queue.');

  const plantBurst = db.prepare(`SELECT COUNT(*) AS n FROM ratings WHERE plant_id = ? AND created_at >= ? AND (? IS NULL OR reporter_id IS NULL OR reporter_id != ?)`)
    .get(ctx.plant.id, since, reporterId, reporterId).n;
  if (plantBurst >= 5) add('rating_plant_burst', 40, `${plantBurst} other rating(s) for this plant in the last hour.`);

  if (reporterId) {
    const spree = db.prepare('SELECT COUNT(DISTINCT plant_id) AS n FROM ratings WHERE reporter_id = ? AND created_at >= ? AND plant_id != ?')
      .get(reporterId, since, ctx.plant.id).n;
    if (spree >= 3) add('rating_spree', 40, `This phone rated ${spree} other plant(s) in the last hour.`);
    if (ctx.reporter.status === 'restricted') add('reporter_restricted', 40, 'A moderator restricted this reporter.');
    if (ctx.reporter.status === 'blocked') add('reporter_blocked', 60, 'A moderator blocked this reporter.');
  }
  if (ctx.ipRecent >= 5) add('rating_ip_burst', 40, `${ctx.ipRecent} rating(s) from the same connection in the last hour.`);

  const score = Math.max(0, Math.min(100, reasons.reduce((s, x) => s + x.weight, 0)));
  return { score, reasons, status: score >= reviewThreshold() ? 'pending' : 'accepted' };
}

module.exports = {
  reviewThreshold, riskLevel, fingerprint, shingles, jaccard, findSimilar, haversineM, proximityToPlant,
  assessReport, assessRating, NEAR_DUP,
};
