'use strict';
// Plant row → public JSON shapes (docs/ARCHITECTURE.md §6 PlantSummary / PlantDetail).
//   toSummary(row, area, { aggregates?, ranking?, now? })  → PlantSummary (ranking fields only if `ranking` given)
//   toDetail(row, area, { now? })                          → PlantDetail
//   loadAggregates(plantIds)                               → batched ratings / tests / confirmed-issue lookups
// Accuracy rules enforced here:
//   * lat/lng are exposed ONLY for exact locations (coord_status source|verified). Area centroids are
//     exposed under location.area and never as the plant's position; geocoded_pending coords stay private.
//   * litres are computed only when the gallon type is known (us / imperial) — never assumed.
//   * water quality comes only from published water tests; ratings never affect it.
//   * no reporter data (ids, phones, descriptions) is ever included.
const { getDb, parseJson } = require('./db');
const { addDays, nowIso } = require('./time');
const { openingHoursView } = require('./hours');

const EXACT_STATUSES = new Set(['source', 'verified']);
const USABLE_AREA_STATUSES = new Set(['matched', 'manual']);
const LITRES_PER_GALLON = { us: 3.785411784, imperial: 4.54609 };
const RATING_PRIOR_C = 5;
const RATING_PRIOR_M = 3.0;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;

function gazetteer() {
  try { return require('./gazetteer'); } catch { return {}; }
}

/** { lat, lng } when the plant has an exact (source / admin-verified) position, else null. */
function exactPosition(row) {
  if (row && EXACT_STATUSES.has(row.coord_status) && isNum(row.latitude) && isNum(row.longitude)) {
    return { lat: row.latitude, lng: row.longitude };
  }
  return null;
}

/** Contract §5.1: an area position is usable when it has lat/lng and geocode_status matched|manual. */
function isAreaUsable(area) {
  if (!area || !isNum(area.latitude) || !isNum(area.longitude) || !USABLE_AREA_STATUSES.has(area.geocode_status)) return false;
  const g = gazetteer();
  if (typeof g.isUsable === 'function') {
    try { return g.isUsable(area) !== false; } catch { return true; }
  }
  return true;
}

function areaView(area) {
  if (!area) return null;
  const usable = isAreaUsable(area);
  return {
    id: area.id,
    name: area.name,
    lat: usable ? area.latitude : null,
    lng: usable ? area.longitude : null,
    radiusM: usable && isNum(area.radius_m) ? area.radius_m : null,
  };
}

function locationView(row, area) {
  const exact = exactPosition(row);
  const av = areaView(area);
  const precision = exact ? 'exact' : av && av.lat !== null ? 'area' : 'none';
  return { precision, lat: exact ? exact.lat : null, lng: exact ? exact.lng : null, coordStatus: row.coord_status, area: av };
}

const precisionOf = (row, area) => (exactPosition(row) ? 'exact' : isAreaUsable(area) ? 'area' : 'none');

function statusView(row) {
  return {
    code: row.status,
    raw: row.status_raw ?? null,
    source: row.status_source,
    updatedAt: row.status_updated_at ?? null,
    verified: row.status_source === 'admin_verified' && !!row.last_verified_at,
  };
}

function capacityView(row) {
  const hasAny = row.capacity_raw != null || row.capacity_value != null || row.capacity_unit != null;
  if (!hasAny) return null;
  const value = isNum(row.capacity_value) ? row.capacity_value : null;
  const gallonType = row.capacity_gallon_type || 'unspecified';
  const factor = LITRES_PER_GALLON[gallonType] || null;
  let litresPerHour = null;
  let litresPerDay = null;
  if (value !== null) {
    // Gallons are converted ONLY when the gallon type is known. Litre units are already litres.
    if (row.capacity_unit === 'gallons_per_hour' && factor) litresPerHour = Math.round(value * factor);
    else if (row.capacity_unit === 'litres_per_hour') litresPerHour = value;
    else if (row.capacity_unit === 'gallons_per_day' && factor) litresPerDay = Math.round(value * factor);
    else if (row.capacity_unit === 'litres_per_day') litresPerDay = value;
  }
  return {
    raw: row.capacity_raw ?? null,
    value,
    unit: row.capacity_unit ?? null,
    unitLabel: row.capacity_unit_label ?? null,
    gallonType,
    basis: row.capacity_basis ?? null,
    litresPerHour,
    litresPerDay,
  };
}

function collectionLimitView(row) {
  if (row.collection_limit_raw == null && row.collection_limit_value == null) return null;
  return {
    raw: row.collection_limit_raw ?? null,
    value: isNum(row.collection_limit_value) ? row.collection_limit_value : null,
    unit: row.collection_limit_unit ?? null,
    period: row.collection_limit_period ?? null,
  };
}

function ratingView(count, sum) {
  if (!count) return { average: null, adjusted: null, count: 0 };
  return {
    average: round2(sum / count),
    adjusted: round2((RATING_PRIOR_C * RATING_PRIOR_M + sum) / (RATING_PRIOR_C + count)),
    count,
  };
}

function waterQualityView(testCount, latest) {
  if (!testCount || !latest) return { state: 'unknown', latestSampleDate: null, testCount: 0 };
  const state = latest.outcome === 'met_limits' ? 'met_limits' : latest.outcome === 'issue_detected' ? 'issue_detected' : 'results_available';
  return { state, latestSampleDate: latest.sample_date, testCount };
}

/** Batched lookups for many plants at once (ratings, published tests, confirmed open issues). */
function loadAggregates(ids) {
  const db = getDb();
  const list = JSON.stringify([...new Set(ids)].map(Number));
  const IN = 'plant_id IN (SELECT value FROM json_each(?))';
  const ratings = new Map();
  for (const r of db.prepare(`SELECT plant_id, COUNT(*) AS n, SUM(stars) AS s FROM ratings WHERE status = 'accepted' AND ${IN} GROUP BY plant_id`).all(list)) {
    ratings.set(r.plant_id, { n: r.n, s: r.s });
  }
  const tests = new Map();
  for (const t of db.prepare(`SELECT plant_id, sample_date, outcome FROM water_tests WHERE published = 1 AND ${IN} ORDER BY plant_id, sample_date DESC, id DESC`).all(list)) {
    const cur = tests.get(t.plant_id);
    if (cur) cur.n++;
    else tests.set(t.plant_id, { n: 1, latest: { sample_date: t.sample_date, outcome: t.outcome } });
  }
  const confirmed = new Map();
  for (const c of db.prepare(`SELECT plant_id, COUNT(*) AS n FROM reports WHERE status = 'confirmed' AND ${IN} GROUP BY plant_id`).all(list)) {
    confirmed.set(c.plant_id, c.n);
  }
  return {
    rating: (id) => { const r = ratings.get(id); return ratingView(r ? r.n : 0, r ? r.s : 0); },
    waterQuality: (id) => { const t = tests.get(id); return waterQualityView(t ? t.n : 0, t ? t.latest : null); },
    confirmedIssues: (id) => confirmed.get(id) || 0,
  };
}

/** PlantSummary. Ranking fields (rank, distanceM, durationS, distanceMethod, recommendation) only when extras.ranking is given. */
function toSummary(row, area, extras = {}) {
  const agg = extras.aggregates || loadAggregates([row.id]);
  const out = {
    code: row.plant_code,
    name: row.name ?? null,
    town: row.town ?? null,
    areaRaw: row.area_raw ?? null,
    areaName: row.area_name ?? null,
    address: row.address ?? null,
    landmark: row.landmark ?? null,
    isDemo: row.is_demo === 1,
    location: locationView(row, area),
    status: statusView(row),
    openingHours: openingHoursView(row, extras.now || new Date()),
    technology: { raw: row.technology_raw ?? null, stages: parseJson(row.treatment_stages_json, []) },
    waterSource: row.water_source ?? null,
    capacity: capacityView(row),
    collectionLimit: collectionLimitView(row),
    operator: { type: row.operator_type ?? null, name: row.operator_name ?? null },
    waterQuality: agg.waterQuality(row.id),
    rating: agg.rating(row.id),
    lastVerifiedAt: row.last_verified_at ?? null,
  };
  if (extras.ranking) {
    const r = extras.ranking;
    out.rank = r.rank;
    out.distanceM = isNum(r.distanceM) ? Math.round(r.distanceM) : null;
    out.durationS = isNum(r.durationS) ? Math.round(r.durationS) : null;
    out.distanceMethod = r.distanceMethod;
    out.recommendation = r.recommendation ?? null;
  }
  return out;
}

// ── Detail-only pieces ──

function waterTestsFor(plantId, { includeUnpublished = false } = {}) {
  const db = getDb();
  const tests = db.prepare(`SELECT * FROM water_tests WHERE plant_id = ? ${includeUnpublished ? '' : 'AND published = 1'} ORDER BY sample_date DESC, id DESC`).all(plantId);
  if (!tests.length) return [];
  const results = db.prepare('SELECT * FROM water_test_results WHERE test_id IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(JSON.stringify(tests.map((t) => t.id)));
  const byTest = new Map();
  for (const r of results) {
    if (!byTest.has(r.test_id)) byTest.set(r.test_id, []);
    byTest.get(r.test_id).push({
      parameter: r.parameter, valueText: r.value_text, unit: r.unit ?? null, limitText: r.limit_text ?? null,
      withinLimit: r.within_limit === null || r.within_limit === undefined ? null : r.within_limit === 1,
      ...(includeUnpublished ? { valueNum: r.value_num ?? null } : {}),
    });
  }
  return tests.map((t) => ({
    id: t.id,
    sampleDate: t.sample_date,
    laboratory: t.laboratory ?? null,
    sourceDescription: t.source_description ?? null,
    standard: t.standard_name ? { name: t.standard_name, version: t.standard_version ?? null, source: t.standard_source ?? null } : null,
    outcome: t.outcome,
    reportUrl: t.report_file_id ? `/api/files/${t.report_file_id}` : null,
    results: byTest.get(t.id) || [],
    ...(includeUnpublished ? { published: t.published === 1, notes: t.notes ?? null, reportFileId: t.report_file_id ?? null, createdAt: t.created_at } : {}),
  }));
}

/**
 * Public report counts for a plant. Prefers the Reports workstream's moderation.plantReportsSummary()
 * (single source of truth for which reports are public-countable). The fallback excludes reports held in
 * the review queue (review_queue = 1: honeypot / flagged) from the unverified and under-review counts.
 */
function reportsSummary(plantId, now = nowIso()) {
  let moderation = null;
  try { moderation = require('./moderation'); } catch { /* Reports module not present */ }
  if (moderation && typeof moderation.plantReportsSummary === 'function') {
    const r = moderation.plantReportsSummary(plantId);
    if (r && typeof r === 'object') {
      return {
        unverifiedOpen: Number(r.unverifiedOpen) || 0,
        underReview: Number(r.underReview) || 0,
        confirmedOpenIssues: Array.isArray(r.confirmedOpenIssues)
          ? r.confirmedOpenIssues.map((c) => ({ category: c.category, confirmedAt: c.confirmedAt ?? null, publicNote: c.publicNote ?? null }))
          : [],
        resolvedLast90d: Number(r.resolvedLast90d) || 0,
      };
    }
  }
  const db = getDb();
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM reports WHERE plant_id = ? AND review_queue = 0 GROUP BY status').all(plantId).map((r) => [r.status, r.n]));
  const confirmed = db.prepare(`
    SELECT r.category, r.updated_at,
      (SELECT e.created_at FROM report_events e WHERE e.report_id = r.id AND e.to_status = 'confirmed' ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS confirmed_at,
      (SELECT e.public_note FROM report_events e WHERE e.report_id = r.id AND e.public_note IS NOT NULL AND trim(e.public_note) <> ''
         ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS public_note
    FROM reports r WHERE r.plant_id = ? AND r.status = 'confirmed'
    ORDER BY COALESCE(confirmed_at, r.updated_at) DESC, r.id DESC`).all(plantId);
  const resolved = db.prepare(`
    SELECT COUNT(*) AS n FROM reports r WHERE r.plant_id = ? AND r.status = 'resolved'
      AND COALESCE((SELECT MAX(e.created_at) FROM report_events e WHERE e.report_id = r.id AND e.to_status = 'resolved'), r.updated_at) >= ?`)
    .get(plantId, addDays(now, -90)).n;
  return {
    unverifiedOpen: (counts.pending || 0) + (counts.needs_clarification || 0),
    underReview: counts.under_review || 0,
    confirmedOpenIssues: confirmed.map((c) => ({ category: c.category, confirmedAt: c.confirmed_at || c.updated_at, publicNote: c.public_note ?? null })),
    resolvedLast90d: resolved,
  };
}

function dataIssues(row) {
  const reasons = parseJson(row.review_reasons_json, []);
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((r) => (typeof r === 'string' ? r : r && typeof r === 'object' ? r.code || r.key || null : null))
    .filter((r) => typeof r === 'string' && r);
}

function missingFields(row, area, testCount) {
  const missing = [];
  if (!row.name) missing.push('name');
  if (!row.address) missing.push('address');
  if (!exactPosition(row)) missing.push('coordinates');
  if (!row.opening_hours_text && !row.opening_hours_json) missing.push('openingHours');
  if (row.collection_limit_raw == null && row.collection_limit_value == null) missing.push('collectionLimit');
  if (!row.public_phone && !row.public_contact_note) missing.push('contact');
  if (!row.accessibility) missing.push('accessibility');
  if (!testCount) missing.push('waterTests');
  return missing;
}

/** PlantDetail = PlantSummary (without ranking) + detail fields. */
function toDetail(row, area, extras = {}) {
  const db = getDb();
  const summary = toSummary(row, area, { now: extras.now });
  const waterTests = waterTestsFor(row.id);
  const sources = db.prepare('SELECT title, url FROM plant_sources WHERE plant_id = ? ORDER BY created_at, id').all(row.id)
    .map((s) => ({ title: s.title, url: s.url ?? null }));
  return {
    ...summary,
    operatorName: row.operator_name ?? null,
    neighborhood: row.neighborhood ?? null,
    publicPhone: row.public_phone ?? null,
    publicContactNote: row.public_contact_note ?? null,
    accessibility: row.accessibility ?? null,
    waterTests,
    sources,
    traceability: { sourceFile: row.source_file ?? null, sheet: row.source_sheet ?? null, row: row.source_row ?? null, importedAt: row.imported_at ?? null },
    sourceValues: parseJson(row.source_values_json, null),
    dataIssues: dataIssues(row),
    missingFields: missingFields(row, area, waterTests.length),
    reportsSummary: reportsSummary(row.id),
  };
}

// ── Technology → treatment stages (contract §5.3; same mapping as the importer) ──
const TECHNOLOGY_STAGES = {
  'reverse osmosis (ro)': ['reverse_osmosis'],
  'heavy-duty brackish ro membrane (high tds)': ['reverse_osmosis'],
  'activated carbon + uv': ['activated_carbon', 'uv'],
  'ultrafiltration (uf)': ['ultrafiltration'],
};
/** Returns { stages, recognised }. Unrecognised technology → [] (callers should warn). Nothing else is inferred. */
function stagesForTechnology(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { stages: [], recognised: false };
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  const stages = TECHNOLOGY_STAGES[key];
  return stages ? { stages: [...stages], recognised: true } : { stages: [], recognised: false };
}

/** Loads the area row for a plant (or null). */
function areaFor(row) {
  if (!row || !row.area_id) return null;
  return getDb().prepare('SELECT * FROM areas WHERE id = ?').get(row.area_id) || null;
}

module.exports = {
  LITRES_PER_GALLON, exactPosition, isAreaUsable, areaView, locationView, precisionOf, statusView, capacityView,
  collectionLimitView, ratingView, waterQualityView, loadAggregates, toSummary, toDetail, waterTestsFor,
  reportsSummary, dataIssues, missingFields, stagesForTechnology, areaFor,
};
