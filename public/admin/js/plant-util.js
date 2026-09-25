// Accessors and badges for plant records. Admin endpoints may return DB columns (snake_case), PlantSummary
// objects (camelCase, nested location/status) or a mix — these helpers accept all of them.
import { h, pick, badge, maybeJson } from './ui.js';

export const STATUS_LABEL = {
  operational: 'Operational',
  temporarily_closed: 'Temporarily closed',
  permanently_closed: 'Permanently closed',
  decommissioned: 'Decommissioned',
  unknown: 'Unknown',
};
export const STATUS_TONE = { operational: 'success', temporarily_closed: 'warn', permanently_closed: 'danger', decommissioned: 'danger', unknown: 'unknown' };
export const STATUS_SOURCE_LABEL = {
  spreadsheet: 'Listed in source data (undated, not verified)',
  admin: 'Set by an administrator (not verified)',
  admin_verified: 'Verified by an administrator',
  none: 'No status source',
};
export const COORD_LABEL = {
  missing: 'No exact location',
  source: 'From source file (unverified)',
  geocoded_pending: 'Geocoded — awaiting review',
  verified: 'Verified by admin',
};
export const PRECISION = {
  exact: { label: 'Exact location', tone: 'success' },
  area: { label: 'Area only (approximate)', tone: 'info' },
  none: { label: 'No location', tone: 'unknown' },
  pending: { label: 'Location pending review', tone: 'warn' },
};

export const plantCode = (p) => pick(p, 'code', 'plant_code', 'plantCode');
export const plantName = (p) => pick(p, 'name');
export const plantTown = (p) => pick(p, 'town');
export const plantArea = (p) => pick(p, 'areaRaw', 'area_raw');
export const isDemo = (p) => !!pick(p, 'isDemo', 'is_demo');
export const needsReview = (p) => !!pick(p, 'needsReview', 'needs_review');

export function coordStatus(p) {
  return pick(p, 'location.coordStatus', 'coord_status', 'coordStatus') || null;
}

export function latLng(p) {
  const lat = pick(p, 'location.lat', 'latitude', 'lat');
  const lng = pick(p, 'location.lng', 'longitude', 'lng');
  return { lat: lat === null || lat === undefined || lat === '' ? null : Number(lat), lng: lng === null || lng === undefined || lng === '' ? null : Number(lng) };
}

export function precisionOf(p) {
  const explicit = pick(p, 'location.precision', 'precision', 'locationPrecision');
  if (explicit) return explicit;
  const cs = coordStatus(p);
  const { lat, lng } = latLng(p);
  if ((cs === 'source' || cs === 'verified') && lat !== null && lng !== null) return 'exact';
  if (cs === 'geocoded_pending') return 'pending';
  const area = pick(p, 'location.area', 'area');
  if (area && typeof area === 'object' && area.lat !== null && area.lat !== undefined) return 'area';
  return null;
}

export function statusCode(p) {
  const s = pick(p, 'status');
  if (s && typeof s === 'object') return s.code || null;
  return s || null;
}
export function statusSource(p) {
  const s = pick(p, 'status');
  if (s && typeof s === 'object') return s.source || null;
  return pick(p, 'status_source', 'statusSource') || null;
}

export function precisionBadge(p) {
  const pr = precisionOf(p);
  if (pr && PRECISION[pr]) return badge(PRECISION[pr].label, PRECISION[pr].tone);
  const cs = coordStatus(p);
  return cs ? badge(COORD_LABEL[cs] || cs, cs === 'verified' ? 'success' : cs === 'missing' ? 'unknown' : 'warn') : badge('Unknown', 'unknown');
}

export function statusBadge(p) {
  const code = statusCode(p);
  const src = statusSource(p);
  const b = badge(STATUS_LABEL[code] || code || 'Unknown', STATUS_TONE[code] || 'unknown');
  if (src === 'admin_verified') b.append(' · verified');
  else if (src === 'spreadsheet') b.append(' · listed');
  return b;
}

export const demoBadge = () => badge('DEMO — not a real plant', 'demo');

export function plantLink(code, text) {
  return h('a', { href: `#/plants/${encodeURIComponent(code)}` }, text || code);
}

/** Review reasons may be an array, a JSON string, or under different names. */
export function reviewReasons(p) {
  const r = maybeJson(pick(p, 'reviewReasons', 'review_reasons_json', 'reviewReasonsJson', 'dataIssues'));
  return Array.isArray(r) ? r : [];
}

export const ISSUE_LABEL = {
  no_coordinates: 'No coordinates in source',
  area_not_geocodable: 'Area is a generic label, not a place',
  area_name_possible_typo: 'Area name may contain a typo',
  sector_suffix_unverified: '“Sector N” suffix not an official subdivision',
  operator_type_is_plant_type: 'Operator type describes a plant type',
  operator_type_technology_mismatch: 'Operator type names a different technology',
  operator_acronym_unexplained: 'Operator acronym not explained',
  capacity_gallon_type_unspecified: 'Gallon type (US/imperial) not stated',
  capacity_unusually_high: 'Capacity unusually high — check plausibility',
  status_undated: 'Status has no date',
  coordinates_out_of_bounds: 'Source coordinates outside district',
  coordinates_possibly_swapped: 'Source lat/lng look swapped',
  unrecognised_technology: 'Technology not recognised',
  unrecognised_status: 'Status not recognised',
  duplicate_plant_code: 'Duplicate plant ID',
  geocoded_location_unverified: 'Geocoded location awaiting verification',
  geocode_ambiguous: 'Geocoder result ambiguous',
  geocode_approximate: 'Geocoder match approximate',
};
export const issueLabel = (code) => ISSUE_LABEL[code] || String(code).replace(/_/g, ' ');
