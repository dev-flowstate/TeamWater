'use strict';
// GET /api/search ranking (docs/ARCHITECTURE.md §6).
//
// Groups:
//   exact — plants with an exact position (coord_status source|verified), within 30 km of the origin
//           (SQL bounding-box prefilter, then haversine). Ranked by straight-line distance; when routing is
//           available for the mode, the top 25 are re-ranked by route duration from one table/matrix call.
//   area  — plants without an exact position whose area has a usable centroid. Ranked by the distance to
//           the AREA CENTRE (method 'area_centre'); capped at `limit`. Never presented as plant positions.
// Excluded: permanently_closed / decommissioned (counted), plants with no location at all (counted; reachable
// via the text list). temporarily_closed stays (flagged) unless hideTemporarilyClosed. Demo plants only when
// config.demoData. Every ordering ends with a plantCode tie-break, so the same inputs give the same order.
//
// Recommended score (0–1): proximity 0.45 · verified operational status 0.20 · dated test evidence 0.15 ·
// no confirmed unresolved issues 0.10 · adjusted rating 0.10 (only with ≥3 accepted ratings, else neutral).
// Missing test data is NEUTRAL (0.5) — never treated as "safe". Ratings never speak to water safety.
//
// Privacy: the origin is used for this computation only. It is not logged and not stored.
const config = require('../config');
const { getDb } = require('./db');
const { haversineM, bboxAround, inBounds } = require('./geo');
const routing = require('./routing');
const { toSummary, loadAggregates, isAreaUsable } = require('./plant-view');
const { openingHoursView } = require('./hours');

const EXACT_RADIUS_M = 30_000;
const ROUTE_RERANK_N = 25;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const NEARBY_M = 2000;
const FARTHER_M = 8000;
const DIST_SCALE_M = 5000; // proximity = exp(-d / 5 km)
// Same 5 km expressed as typical urban travel time per mode, so time- and distance-based scores agree.
const TIME_SCALE_S = { driving: 720, two_wheeler: 720, cycling: 1500, walking: 4000 };

const WEIGHTS = { proximity: 0.45, status: 0.2, tests: 0.15, issues: 0.1, rating: 0.1 };

const LABELS = {
  straight_line: 'Approximate straight-line distance',
  route: 'Estimated road distance and travel time from the routing provider',
  area_centre: "Approximate distance to the centre of the listed area — the plant's exact site is not recorded",
};

const byCode = (a, b) => (a.row.plant_code < b.row.plant_code ? -1 : a.row.plant_code > b.row.plant_code ? 1 : 0);
const byDistance = (a, b) => a.distanceM - b.distanceM || byCode(a, b);
const nullLast = (x, y) => (x === null && y === null ? 0 : x === null ? 1 : y === null ? -1 : x - y);
const byDuration = (a, b) => nullLast(a.durationS, b.durationS) || a.distanceM - b.distanceM || byCode(a, b);
const byScore = (a, b) => b.recommendation.score - a.recommendation.score || a.distanceM - b.distanceM || byCode(a, b);

function formatKm(m) {
  const km = m / 1000;
  return km < 10 ? km.toFixed(1) : String(Math.round(km));
}

function daysBetween(isoDate, now) {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(t) ? Infinity : (now.getTime() - t) / 86400e3;
}

/** Score + reason codes + plain-language text for one candidate. */
function recommend(c, agg, { mode, now, group }) {
  const row = c.row;
  const reasons = [];
  const text = [];
  const dist = c.routeDistanceM ?? c.distanceM;

  // Proximity (distance, or travel time when routed)
  const proximity = c.durationS !== null && c.durationS !== undefined
    ? Math.exp(-c.durationS / (TIME_SCALE_S[mode] || TIME_SCALE_S.driving))
    : Math.exp(-dist / DIST_SCALE_M);
  const area = group === 'area';
  if (dist <= NEARBY_M) { reasons.push('nearby'); text.push(area ? 'The listed area is nearby' : 'Nearby'); }
  else if (dist > FARTHER_M) { reasons.push('farther'); text.push(area ? `Farther away (about ${formatKm(dist)} km to the area centre)` : `Farther away (about ${formatKm(dist)} km)`); }
  else text.push(area ? `About ${formatKm(dist)} km to the area centre` : `About ${formatKm(dist)} km away`);
  if (area) { reasons.push('location_approximate'); text.push('exact site not recorded'); }

  // Operating status
  let status;
  const verifiedStatus = row.status_source === 'admin_verified' && !!row.last_verified_at;
  if (row.status === 'temporarily_closed') { status = 0; reasons.push('temporarily_closed'); text.push('temporarily closed'); }
  else if (row.status === 'operational' && verifiedStatus) { status = 1; reasons.push('status_verified_operational'); text.push(`operating status verified by an administrator on ${row.last_verified_at}`); }
  else if (row.status === 'operational') {
    status = 0.5;
    reasons.push('status_listed_unverified');
    text.push(row.status_source === 'spreadsheet' ? 'listed as operational in the source spreadsheet (not verified)' : 'listed as operational (not verified)');
  } else { status = 0.25; reasons.push('status_unknown'); text.push('operating status unknown'); }

  // Opening hours (reason only; not weighted)
  const oh = openingHoursView(row, now);
  if (oh.openNow === true) { reasons.push('open_now'); text.push('open now according to recorded hours'); }
  else if (oh.openNow === false) { reasons.push('closed_now'); text.push('closed now according to recorded hours'); }
  else reasons.push('hours_unknown');

  // Water-test evidence (dated, published tests only)
  const wq = agg.waterQuality(row.id);
  let tests;
  if (wq.state === 'unknown') { tests = 0.5; reasons.push('no_test_data'); text.push('no verified water-test data'); }
  else if (wq.state === 'issue_detected') { tests = 0; reasons.push('test_issue_detected'); text.push(`the latest water test (${wq.latestSampleDate}) detected an issue`); }
  else if (wq.state === 'met_limits') {
    const recent = daysBetween(wq.latestSampleDate, now) <= 365;
    tests = recent ? 1 : 0.7;
    if (recent) reasons.push('recent_test_met_limits');
    text.push(`${recent ? 'the latest' : 'an older'} water test (${wq.latestSampleDate}) met the limits of the stated standard`);
  } else { tests = 0.5; text.push(`water-test results recorded (${wq.latestSampleDate}) without a pass/fail assessment`); }

  // Confirmed unresolved issues
  const issuesN = agg.confirmedIssues(row.id);
  const issues = issuesN ? 0 : 1;
  if (issuesN) { reasons.push('confirmed_open_issue'); text.push(issuesN === 1 ? 'has a confirmed unresolved problem report' : `has ${issuesN} confirmed unresolved problem reports`); }

  // Ratings (experience only — never water safety)
  const rating = agg.rating(row.id);
  let ratingScore = 0.5;
  if (rating.count >= 3) {
    ratingScore = Math.min(1, Math.max(0, (rating.adjusted - 1) / 4));
    if (rating.adjusted >= 4) { reasons.push('well_rated'); text.push('well rated by visitors for their experience (ratings do not measure water safety)'); }
  } else reasons.push('few_ratings');

  // Verification recency
  if (row.last_verified_at) {
    if (daysBetween(row.last_verified_at, now) <= 180) { reasons.push('recently_verified'); if (!verifiedStatus) text.push(`details verified on ${row.last_verified_at}`); }
  } else reasons.push('not_verified');

  const score = WEIGHTS.proximity * proximity + WEIGHTS.status * status + WEIGHTS.tests * tests + WEIGHTS.issues * issues + WEIGHTS.rating * ratingScore;
  const sentence = text.join('; ');
  return {
    score: Math.round(score * 1000) / 1000,
    reasons,
    text: sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.',
  };
}

/**
 * @param {object} p { lat, lng, sort, mode, technology, operatorType, hideTemporarilyClosed, limit, now }
 */
async function search(p) {
  const { lat, lng } = p;
  const sort = p.sort === 'recommended' ? 'recommended' : 'nearest';
  const mode = p.mode || 'driving';
  const limit = Math.min(MAX_LIMIT, Math.max(1, p.limit || DEFAULT_LIMIT));
  const now = p.now || new Date();
  const db = getDb();

  // ── Filters shared by every query ──
  const where = [];
  const params = [];
  if (!config.demoData) where.push('p.is_demo = 0');
  if (p.technology) { where.push('p.technology_raw = ?'); params.push(p.technology); }
  if (p.operatorType) { where.push('p.operator_type = ?'); params.push(p.operatorType); }
  const filterSql = where.length ? `AND ${where.join(' AND ')}` : '';
  const openSql = `p.status NOT IN ('permanently_closed','decommissioned')${p.hideTemporarilyClosed ? " AND p.status <> 'temporarily_closed'" : ''}`;
  const exactSql = "p.coord_status IN ('source','verified') AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL";

  const closedPermanently = db.prepare(`SELECT COUNT(*) AS n FROM plants p WHERE p.status IN ('permanently_closed','decommissioned') ${filterSql}`).get(...params).n;
  const areas = new Map(db.prepare('SELECT * FROM areas').all().map((a) => [a.id, a]));
  const areaOf = (row) => (row.area_id ? areas.get(row.area_id) || null : null);

  // ── Exact group: bbox prefilter in SQL, then haversine ≤ 30 km ──
  const bb = bboxAround(lat, lng, EXACT_RADIUS_M);
  const exactRows = db.prepare(`SELECT p.* FROM plants p WHERE ${openSql} AND ${exactSql}
      AND p.latitude BETWEEN ? AND ? AND p.longitude BETWEEN ? AND ? ${filterSql}`)
    .all(bb.minLat, bb.maxLat, bb.minLng, bb.maxLng, ...params);
  let exact = exactRows
    .map((row) => ({ row, area: areaOf(row), distanceM: haversineM(lat, lng, row.latitude, row.longitude), durationS: null, routeDistanceM: null, method: 'straight_line' }))
    .filter((c) => c.distanceM <= EXACT_RADIUS_M)
    .sort(byDistance);
  const anyExact = exact.length > 0 || db.prepare(`SELECT 1 FROM plants p WHERE ${openSql} AND ${exactSql} ${filterSql} LIMIT 1`).get(...params) !== undefined;

  // ── Area group + no-location count ──
  const nonExactRows = db.prepare(`SELECT p.* FROM plants p WHERE ${openSql} AND NOT (${exactSql}) ${filterSql}`).all(...params);
  let noLocation = 0;
  let areaGroup = [];
  for (const row of nonExactRows) {
    const area = areaOf(row);
    if (!isAreaUsable(area)) { noLocation++; continue; }
    areaGroup.push({ row, area, distanceM: haversineM(lat, lng, area.latitude, area.longitude), durationS: null, routeDistanceM: null, method: 'area_centre' });
  }
  areaGroup.sort(byDistance);

  // ── Routing re-rank of the top 25 exact candidates ──
  const av = routing.availability(mode);
  let method = 'straight_line';
  let routingAvailable = av.available;
  let routingReason = av.available ? null : av.reason;
  if (av.available && exact.length) {
    const top = exact.slice(0, ROUTE_RERANK_N);
    const t = await routing.table({ lat, lng }, top.map((c) => c.row), mode);
    if (t.available) {
      method = 'route';
      top.forEach((c, i) => {
        const r = t.results[i];
        if (r && r.durationS !== null && r.durationS !== undefined) {
          c.durationS = r.durationS;
          c.routeDistanceM = r.distanceM;
          c.method = 'route';
        }
      });
      top.sort(byDuration);
      exact = [...top, ...exact.slice(ROUTE_RERANK_N)];
    } else {
      routingAvailable = false;
      routingReason = t.reason;
    }
  }

  // ── Recommended ordering ──
  let agg;
  if (sort === 'recommended') {
    agg = loadAggregates([...exact, ...areaGroup].map((c) => c.row.id));
    for (const c of exact) c.recommendation = recommend(c, agg, { mode, now, group: 'exact' });
    for (const c of areaGroup) c.recommendation = recommend(c, agg, { mode, now, group: 'area' });
    exact.sort(byScore);
    areaGroup.sort(byScore);
  }

  exact = exact.slice(0, limit);
  areaGroup = areaGroup.slice(0, limit);
  if (!agg) agg = loadAggregates([...exact, ...areaGroup].map((c) => c.row.id));

  const summarize = (c, i) => toSummary(c.row, c.area, {
    aggregates: agg,
    now,
    ranking: {
      rank: i + 1,
      distanceM: c.method === 'route' && c.routeDistanceM !== null ? c.routeDistanceM : c.distanceM,
      durationS: c.durationS,
      distanceMethod: c.method,
      recommendation: c.recommendation || null,
    },
  });

  let notice = null;
  if (!inBounds(lat, lng)) notice = 'origin_outside_coverage';
  else if (!anyExact) notice = 'no_exact_locations_recorded';
  else if (!exact.length) notice = 'no_exact_nearby';

  return {
    origin: { lat, lng },
    sort,
    distance: {
      method,
      mode,
      label: LABELS[method],
      areaMethod: 'area_centre',
      areaLabel: LABELS.area_centre,
      routingAvailable,
      routingReason,
    },
    exact: exact.map(summarize),
    area: areaGroup.map(summarize),
    excluded: { closedPermanently, noLocation },
    notice,
  };
}

module.exports = { EXACT_RADIUS_M, ROUTE_RERANK_N, DEFAULT_LIMIT, MAX_LIMIT, LABELS, WEIGHTS, search, recommend };
