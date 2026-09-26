'use strict';
// Row normalisation & validation for spreadsheet imports. Pure functions (no database access).
//
//   const { normalizeRow } = require('./normalize');
//   const entry = normalizeRow(values, mapping, { sourceFile, sheet, rowNumber });
//   entry = { code, plant: {<plants column>: value}, provided: ['name','capacity',...], issues: ['no_coordinates',...],
//             errors: [{field,code,message,value}], warnings: [...], missingFields, incomplete, needsReview,
//             tests: [{ sampleDate, laboratory, results: [...] }], sources: [{ title, url }], areaKey, geocode }
//
// Rules (docs/ARCHITECTURE.md §0, §5): raw values are preserved verbatim; nothing is invented or silently corrected;
// capacity is a production rate and never a collection allowance; water tests are never assessed as pass/fail here.
const config = require('../config');
const { parseAreaRaw, areaKey, normalizeSearch } = require('../lib/text');
const { karachiParts } = require('../lib/time');
const { DATA_ISSUES, DATASET_WIDE_ISSUES, headerHint, isParamKey, PARAM_PREFIX } = require('./fields');

const DATASET_WIDE = new Set(DATASET_WIDE_ISSUES);
const US_GALLON_L = 3.785411784;
const CAPACITY_HIGH_GPH = 20000;
const BOUNDS_MARGIN_DEG = 0.1;
const MAX_TEXT = 2000;

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const text = (v) => (isBlank(v) ? null : String(v).trim());

// ───────────────────────── Units (capacity & collection limit) ─────────────────────────
const GALLON_TOKENS = new Map([['g', null], ['gal', null], ['gals', null], ['gallon', null], ['gallons', null], ['usg', 'us'], ['usgal', 'us'], ['igal', 'imperial'], ['impgal', 'imperial']]);
const LITRE_TOKENS = new Set(['l', 'lt', 'lts', 'ltr', 'ltrs', 'lit', 'litre', 'litres', 'liter', 'liters']);
const HOUR_TOKENS = new Set(['h', 'hr', 'hrs', 'hour', 'hours', 'hourly']);
const DAY_TOKENS = new Set(['d', 'day', 'days', 'daily']);
const MINUTE_TOKENS = new Set(['m', 'min', 'mins', 'minute', 'minutes']);
const US_TOKENS = new Set(['us', 'usa']);
const IMPERIAL_TOKENS = new Set(['imp', 'imperial', 'uk', 'british']);
const VISIT_TOKENS = new Set(['visit', 'visits', 'fill', 'fills', 'trip', 'trips', 'turn']);

/** Parse a unit phrase ("GPH", "L/hr", "US gallons per day", "Gallons Per Hour") into its parts. */
function parseUnitText(input) {
  const t = String(input || '').toLowerCase().replace(/u\.s\./g, 'us').replace(/\bu\.k\./g, 'uk');
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  const out = { volume: null, time: null, gallonType: null, visit: false, perDayHint: false };
  for (const tok of tokens) {
    const compact = tok.match(/^(us|usg|imp|uk|i)?([gl])p([hdm])$/);
    if (compact) {
      out.volume = compact[2] === 'g' ? 'gallon' : 'litre';
      out.time = { h: 'hour', d: 'day', m: 'minute' }[compact[3]];
      if (compact[1] === 'us' || compact[1] === 'usg') out.gallonType = 'us';
      else if (compact[1]) out.gallonType = 'imperial';
      continue;
    }
    if (GALLON_TOKENS.has(tok)) { out.volume = 'gallon'; if (GALLON_TOKENS.get(tok)) out.gallonType = GALLON_TOKENS.get(tok); continue; }
    if (LITRE_TOKENS.has(tok)) { out.volume = 'litre'; continue; }
    if (HOUR_TOKENS.has(tok)) { out.time = out.time || 'hour'; continue; }
    if (DAY_TOKENS.has(tok)) { out.time = out.time || 'day'; continue; }
    if (MINUTE_TOKENS.has(tok)) { out.time = out.time || 'minute'; continue; }
    if (US_TOKENS.has(tok)) { out.gallonType = 'us'; continue; }
    if (IMPERIAL_TOKENS.has(tok)) { out.gallonType = 'imperial'; continue; }
    if (VISIT_TOKENS.has(tok)) out.visit = true;
  }
  return out;
}

/** Rate unit for capacity: 'gallons_per_hour' | 'gallons_per_day' | 'litres_per_hour' | 'litres_per_day' | null. */
function rateUnit(parts) {
  if (!parts.volume || !parts.time || parts.time === 'minute') return null;
  return `${parts.volume}s_per_${parts.time}`;
}

const NUMBER_PREFIX = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[+-]?\.\d+)\s*(.*)$/s;

/** Split "5,000 gph" into { value: 5000, rest: 'gph' }; null when it doesn't start with a single number. */
function splitNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, rest: '' } : null;
  const s = String(raw).trim();
  const m = s.match(NUMBER_PREFIX);
  if (!m) return null;
  const rest = m[2].trim();
  if (/^(?:[-–—~]|to\b)\s*\d/i.test(rest) || /\d/.test(rest.replace(/\b(?:m3|m³|24\s*h(?:ou)?rs?)\b/gi, ''))) return null; // ranges / several numbers
  return { value: Number(m[1].replace(/,/g, '')), rest };
}

/** Gallons-per-hour equivalent used only for the plausibility check (US gallons for litre units: flags earlier). */
function gphEquivalent(value, unit) {
  if (value === null || !unit) return null;
  switch (unit) {
    case 'gallons_per_hour': return value;
    case 'gallons_per_day': return value / 24;
    case 'litres_per_hour': return value / US_GALLON_L;
    case 'litres_per_day': return value / 24 / US_GALLON_L;
    default: return null;
  }
}

/**
 * Parse a production capacity cell. Never changes the recorded number; never converts gallons to litres.
 * Returns null when the cell is blank; otherwise { raw, value, unit, unitLabel, gallonType, basis, warnings, issues }.
 */
function parseCapacity(raw, header) {
  if (isBlank(raw)) return null;
  const res = {
    raw: String(raw).trim(), value: null, unit: null, unitLabel: null, gallonType: 'unspecified',
    basis: `As recorded in source column '${header}'; whether this is rated or measured output is not stated.`,
    warnings: [], issues: [],
  };
  const warn = (code, message) => res.warnings.push({ field: 'capacity', code, message, value: res.raw });
  const num = splitNumber(raw);
  if (!num) { warn('capacity_not_numeric', 'Capacity is not a single number; the recorded text is kept and no value is used.'); return res; }
  res.value = num.value;

  const headerParts = parseUnitText(header);
  const headerUnit = rateUnit(headerParts);
  let cellParts = null;
  if (num.rest) {
    cellParts = parseUnitText(num.rest);
    res.unitLabel = num.rest;
    res.unit = rateUnit(cellParts);
    if (!res.unit) warn('capacity_unit_unrecognised', `Capacity unit "${num.rest}" is not recognised (supported: gallons or litres per hour or per day).`);
    else if (headerUnit && headerUnit !== res.unit) {
      warn('capacity_unit_conflict', `Capacity unit in the cell (${num.rest}) differs from the column header (${header}); the cell's unit is used.`);
    }
  } else if (headerUnit) {
    res.unit = headerUnit;
    res.unitLabel = headerHint(header) || String(header);
  } else {
    warn('capacity_unit_missing', 'Capacity has no unit in the cell or the column header; the number is kept without a unit.');
  }

  const cellType = cellParts && cellParts.gallonType;
  if (cellType && headerParts.gallonType && cellType !== headerParts.gallonType) {
    warn('capacity_unit_conflict', `Gallon type in the cell (${cellType}) differs from the column header (${headerParts.gallonType}); the cell's value is used.`);
  }
  if (res.unit && res.unit.startsWith('litres')) res.gallonType = 'not_applicable';
  else if (res.unit && res.unit.startsWith('gallons')) {
    res.gallonType = cellType || (!cellParts || !cellParts.volume || cellParts.volume === 'gallon' ? headerParts.gallonType : null) || 'unspecified';
    if (res.gallonType === 'unspecified') res.issues.push('capacity_gallon_type_unspecified');
  }
  if (res.value <= 0) warn('capacity_not_positive', 'Capacity is zero or negative; it is kept as recorded.');
  const gph = gphEquivalent(res.value, res.unit);
  if (gph !== null && gph > CAPACITY_HIGH_GPH) {
    res.issues.push('capacity_unusually_high');
    warn('capacity_unusually_high', `Capacity of ${res.raw} is above ${CAPACITY_HIGH_GPH.toLocaleString('en-US')} gallons per hour (or equivalent), which is unusually high for a community filtration point. Kept as recorded for plausibility review.`);
  }
  return res;
}

/**
 * Parse a per-person collection limit (separate from capacity; never derived from it).
 * Returns null when blank; otherwise { raw, value, unit: 'litres'|'gallons'|null, period: 'per_visit'|'per_day'|null, warnings }.
 */
function parseCollectionLimit(raw, header) {
  if (isBlank(raw)) return null;
  const res = { raw: String(raw).trim(), value: null, unit: null, period: null, warnings: [] };
  const warn = (code, message) => res.warnings.push({ field: 'collection_limit', code, message, value: res.raw });
  const num = splitNumber(raw);
  if (!num) { warn('collection_limit_not_numeric', 'Collection limit is not a single number; the recorded text is kept and no value is used.'); return res; }
  res.value = num.value;
  const cell = parseUnitText(num.rest);
  const head = parseUnitText(header);
  const volume = cell.volume || head.volume;
  res.unit = volume === 'gallon' ? 'gallons' : volume === 'litre' ? 'litres' : null;
  const periodOf = (p) => (p.visit ? 'per_visit' : p.time === 'day' ? 'per_day' : null);
  res.period = periodOf(cell) || periodOf(head);
  if (!res.unit) warn('collection_limit_unit_missing', 'Collection limit has no recognised unit (litres or gallons).');
  if ((cell.time === 'hour' || cell.time === 'minute') && !cell.visit) {
    warn('collection_limit_looks_like_rate', 'Collection limit is expressed per hour or per minute, which looks like a production rate. Check the column mapping.');
  }
  return res;
}

// ───────────────────────── Status & technology ─────────────────────────
const statusKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STATUS_MAP = new Map([
  ...['fully functional', 'functional', 'operational', 'fully operational', 'working', 'open'].map((s) => [s, 'operational']),
  ...['temporarily closed', 'under maintenance', 'under repair'].map((s) => [s, 'temporarily_closed']),
  ...['permanently closed', 'closed permanently'].map((s) => [s, 'permanently_closed']),
  ...['decommissioned', 'abandoned'].map((s) => [s, 'decommissioned']),
]);
/** Conservative status mapping. Anything not listed (including "Non-Functional") is 'unknown'. */
function mapStatus(raw) {
  const s = STATUS_MAP.get(statusKey(raw));
  return s ? { status: s, recognised: true } : { status: 'unknown', recognised: false };
}

const techKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Recorded technology -> treatment stage keys (ARCHITECTURE.md §5.3). Case/punctuation-insensitive; infers nothing else. */
const TECHNOLOGY_STAGES = new Map([
  ['reverseosmosisro', ['reverse_osmosis']],
  ['reverseosmosis', ['reverse_osmosis']],
  ['heavydutybrackishromembranehightds', ['reverse_osmosis']],
  ['activatedcarbonuv', ['activated_carbon', 'uv']],
  ['ultrafiltrationuf', ['ultrafiltration']],
  ['ultrafiltration', ['ultrafiltration']],
]);
TECHNOLOGY_STAGES.set('ro', ['reverse_osmosis']);
TECHNOLOGY_STAGES.set('roplant', ['reverse_osmosis']);
TECHNOLOGY_STAGES.set('uf', ['ultrafiltration']);
function mapTechnology(raw) {
  // "RO (2000 LPH)": the parenthetical is a capacity, not part of the technology name.
  const stages = TECHNOLOGY_STAGES.get(techKey(raw)) || TECHNOLOGY_STAGES.get(techKey(String(raw || '').replace(/\([^)]*\)/g, '')));
  return stages ? { stages: [...stages], recognised: true } : { stages: [], recognised: false };
}

// ───────────────────────── Area & operator heuristics (data-driven, conservative) ─────────────────────────
const NOT_GEOCODABLE_AREAS = [/^saline\s*zone\b/i, /^kachi\s*abadi$/i, /^factory\s*area$/i, /^industrial\s*(?:area|estate|zone)$/i];
const AREA_TYPOS = [{ re: /^chalk(\s+\d+\b.*)$/i, suggest: (m) => `Chak${m[1]}` }];

const ORG_WORDS = /\b(government|govt|ngo|private|pvt|company|foundation|trust|authority|department|society|welfare|community|municipal|corporation|committee|council|wasa|tma|phed|mosque|masjid|school|hospital|individual|commercial|public|cooperative)\b/i;
const PLANT_WORDS = /\b(plant|treatment|ro|uf|uv|filtration|filter|membrane|reverse osmosis|ultrafiltration|purification)\b/i;
const OPERATOR_TECH = [
  { re: /\bro\b|reverse\s*osmosis/i, stage: 'reverse_osmosis' },
  { re: /\buf\b|ultra\s*filtration/i, stage: 'ultrafiltration' },
  { re: /\buv\b|ultra\s*violet/i, stage: 'uv' },
];
const KNOWN_ACRONYMS = new Set(['NGO', 'NGOS', 'RO', 'UF', 'UV', 'WASA', 'TMA', 'PHED', 'MCF', 'PVT', 'LTD', 'CO', 'PK', 'UC']);

// ───────────────────────── Coordinates & dates ─────────────────────────
function parseCoordinate(v) {
  if (isBlank(v)) return { value: null, decimals: 0, blank: true };
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, decimals: (String(v).split('.')[1] || '').length } : { value: null, invalid: true };
  const s = String(v).trim().replace(/\s+/g, '');
  const m = s.match(/^([+-]?\d+(?:\.(\d+))?)°?([NSEW])?$/i);
  if (!m) return { value: null, invalid: true };
  let n = Number(m[1]);
  if (m[3] && /[SW]/i.test(m[3])) n = -Math.abs(n);
  return { value: n, decimals: (m[2] || '').length };
}

function inBounds(lat, lng, margin = BOUNDS_MARGIN_DEG) {
  const [[s, w], [n, e]] = config.map.bounds;
  return lat >= s - margin && lat <= n + margin && lng >= w - margin && lng <= e + margin;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Parse a date cell. Day-first for numeric dates (Pakistani convention). Returns { date, ambiguous, invalid, future }. */
function parseDate(v, today = karachiParts().date) {
  if (isBlank(v)) return { date: null };
  let y, m, d, ambiguous = false;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return { date: null, invalid: true };
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  } else {
    const s = String(v).trim();
    let mm;
    if ((mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) [y, m, d] = [+mm[1], +mm[2], +mm[3]];
    else if ((mm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
      [d, m, y] = [+mm[1], +mm[2], +mm[3]];
      ambiguous = d <= 12 && m <= 12 && d !== m;
    } else if ((mm = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]+(\d{4})$/))) {
      [d, m, y] = [+mm[1], MONTHS[mm[2].slice(0, mm[2].toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()], +mm[3]];
    } else if ((mm = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/))) {
      [m, d, y] = [MONTHS[mm[1].slice(0, 3).toLowerCase()], +mm[2], +mm[3]];
    } else return { date: null, invalid: true };
  }
  if (!m || !validYmd(y, m, d) || y < 1950) return { date: null, invalid: true };
  const date = ymd(y, m, d);
  if (date > today) return { date: null, invalid: true, future: true };
  return { date, ambiguous };
}

// ───────────────────────── Names (for duplicate detection) ─────────────────────────
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
/** Similarity of two plant names in [0,1] (Dice coefficient on character bigrams of the normalised names). */
function nameSimilarity(a, b) {
  const x = normalizeSearch(a).replace(/\s+/g, ' '), y = normalizeSearch(b).replace(/\s+/g, ' ');
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x), by = bigrams(y);
  let overlap = 0;
  for (const [g, n] of bx) overlap += Math.min(n, by.get(g) || 0);
  return (2 * overlap) / (x.length - 1 + y.length - 1);
}

// ───────────────────────── Row normalisation ─────────────────────────
const GROUPS = {
  name: ['name'],
  town: ['town'],
  area: ['area_raw', 'area_name', 'area_sector'],
  address: ['address'],
  neighborhood: ['neighborhood'],
  landmark: ['landmark'],
  coords: ['latitude', 'longitude', 'coord_status', 'coord_source', 'coord_accuracy_m', 'coord_note'],
  operator_type: ['operator_type'],
  operator_name: ['operator_name'],
  water_source: ['water_source'],
  technology: ['technology_raw', 'treatment_stages_json'],
  capacity: ['capacity_raw', 'capacity_value', 'capacity_unit', 'capacity_unit_label', 'capacity_basis', 'capacity_gallon_type'],
  collection_limit: ['collection_limit_raw', 'collection_limit_value', 'collection_limit_unit', 'collection_limit_period'],
  opening_hours: ['opening_hours_text'],
  status: ['status', 'status_raw', 'status_source', 'status_updated_at'],
  public_phone: ['public_phone'],
  accessibility: ['accessibility'],
  last_verified: ['last_verified_at', 'verification_note'],
};
const TRACE_COLUMNS = ['source_file', 'source_sheet', 'source_row', 'source_values_json'];
const SIMPLE_TEXT = ['name', 'town', 'address', 'neighborhood', 'landmark', 'operator_type', 'operator_name', 'water_source', 'public_phone', 'accessibility'];

const CODE_OK = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Normalise one source row.
 * @param {object} values   verbatim { header: primitive } for the row
 * @param {object} mapping  { targetKey|param:<Name>: header|null }
 * @param {object} ctx      { sourceFile, sheet, rowNumber, today? }
 */
function normalizeRow(values, mapping, ctx) {
  const errors = [], warnings = [], issues = new Set();
  const provided = new Set();
  const plant = {};
  const headerOf = (key) => (mapping && mapping[key]) || null;
  const get = (key) => { const h = headerOf(key); if (!h) return null; const v = values[h]; return isBlank(v) ? null : v; };
  const warn = (field, code, message, value) => warnings.push({ field, code, message, value: value === undefined ? null : value });
  const flag = (code, field, value, message) => { issues.add(code); warn(field, code, message || DATA_ISSUES[code].description, value); };
  const today = ctx.today || karachiParts().date;

  // Plant ID
  const code = text(get('plant_code'));
  if (!code) errors.push({ field: 'plant_code', code: 'required', message: 'Plant ID is missing, so the row was not imported.', value: null });
  else if (code.length > 100) errors.push({ field: 'plant_code', code: 'too_long', message: 'Plant ID is longer than 100 characters, so the row was not imported.', value: code });
  else if (!CODE_OK.test(code)) warn('plant_code', 'plant_code_malformed', 'Plant ID contains spaces or unusual characters. It was accepted as recorded.', code);

  // Plain text fields
  for (const key of SIMPLE_TEXT) {
    let v = text(get(key));
    if (v === null) continue;
    if (v.length > MAX_TEXT) { warn(key, 'value_truncated', `Value was longer than ${MAX_TEXT} characters and was shortened.`, v.slice(0, 200)); v = v.slice(0, MAX_TEXT); }
    plant[key] = v;
    provided.add(key);
  }
  const hours = text(get('opening_hours_text'));
  if (hours !== null) { plant.opening_hours_text = hours.slice(0, MAX_TEXT); provided.add('opening_hours'); }

  // Area
  let areaKeyValue = null;
  const areaRaw = text(get('area_raw'));
  if (areaRaw !== null) {
    const parsed = parseAreaRaw(areaRaw);
    Object.assign(plant, { area_raw: areaRaw, area_name: parsed.name, area_sector: parsed.sector });
    provided.add('area');
    if (parsed.sector) flag('sector_suffix_unverified', 'area_raw', areaRaw, `The "${parsed.sector}" suffix is not a known official subdivision; it is kept as recorded but not used for location.`);
    if (parsed.name && NOT_GEOCODABLE_AREAS.some((re) => re.test(parsed.name))) flag('area_not_geocodable', 'area_raw', areaRaw, `"${parsed.name}" is a generic or administrative label rather than a place name, so it cannot be located on a map.`);
    for (const t of AREA_TYPOS) {
      const m = parsed.name && parsed.name.match(t.re);
      if (m) flag('area_name_possible_typo', 'area_raw', areaRaw, `"${parsed.name}" may be a misspelling of "${t.suggest(m)}". The original spelling is kept.`);
    }
    if (parsed.name && plant.town) areaKeyValue = areaKey(parsed.name, plant.town);
  }

  // Coordinates
  const latIn = get('latitude'), lngIn = get('longitude');
  let hasCoords = false;
  if (latIn !== null || lngIn !== null) {
    const lat = parseCoordinate(latIn), lng = parseCoordinate(lngIn);
    const pair = `${latIn ?? ''}, ${lngIn ?? ''}`;
    if (lat.invalid || lng.invalid) warn('latitude', 'coordinates_invalid', 'Latitude/longitude is not a decimal number, so it was not used.', pair);
    else if (lat.blank || lng.blank) warn('latitude', 'coordinates_incomplete', 'Only one of latitude and longitude is given, so neither was used.', pair);
    else if (inBounds(lat.value, lng.value)) {
      Object.assign(plant, {
        latitude: lat.value, longitude: lng.value, coord_status: 'source', coord_source: 'spreadsheet', coord_accuracy_m: null,
        coord_note: `As recorded in '${ctx.sourceFile}', sheet '${ctx.sheet}', row ${ctx.rowNumber} (not verified).`,
      });
      provided.add('coords');
      hasCoords = true;
      if (Math.min(lat.decimals, lng.decimals) < 4) warn('latitude', 'coordinates_low_precision', 'Coordinates have fewer than 4 decimal places (precision worse than about 10 m).', pair);
    } else if (inBounds(lng.value, lat.value)) flag('coordinates_possibly_swapped', 'latitude', pair);
    else flag('coordinates_out_of_bounds', 'latitude', pair);
  }
  if (!hasCoords) flag('no_coordinates', 'latitude', latIn === null && lngIn === null ? null : `${latIn ?? ''}, ${lngIn ?? ''}`);

  // Operator type
  const opType = plant.operator_type || null;
  const tech = text(get('technology_raw'));
  const techMap = tech !== null ? mapTechnology(tech) : null;
  if (opType) {
    if (PLANT_WORDS.test(opType) && !ORG_WORDS.test(opType)) flag('operator_type_is_plant_type', 'operator_type', opType, `"${opType}" describes a kind of plant rather than who operates it.`);
    if (techMap && techMap.recognised) {
      const named = OPERATOR_TECH.filter((t) => t.re.test(opType) && !techMap.stages.includes(t.stage));
      if (named.length) flag('operator_type_technology_mismatch', 'operator_type', opType, `Operator type "${opType}" names a technology that differs from the recorded filtration technology "${tech}".`);
    }
    const acronyms = [...new Set((opType.match(/\b[A-Z]{2,6}\b/g) || []).filter((a) => !KNOWN_ACRONYMS.has(a)))];
    if (acronyms.length) flag('operator_acronym_unexplained', 'operator_type', opType, `Operator type contains an acronym the source does not explain (${acronyms.join(', ')}). It is shown as recorded and not expanded.`);
  }

  // Technology -> stages
  if (tech !== null) {
    plant.technology_raw = tech;
    plant.treatment_stages_json = JSON.stringify(techMap.stages);
    provided.add('technology');
    if (!techMap.recognised) flag('unrecognised_technology', 'technology_raw', tech, `Filtration technology "${tech}" is not recognised, so no treatment stages are shown.`);
  }

  // Capacity (production rate) — kept strictly separate from the collection limit
  const capHeader = headerOf('capacity');
  let cap = capHeader ? parseCapacity(get('capacity'), capHeader) : null;
  // No capacity column, but the technology cell records one in brackets, e.g. "RO (2000 LPH)".
  if (!cap && tech) {
    const m = String(tech).match(/\(([^)]*\d[^)]*)\)/);
    const techHeader = headerOf('technology_raw');
    if (m) {
      const parsed = parseCapacity(m[1], techHeader);
      if (parsed && parsed.unit) cap = { ...parsed, basis: `As recorded in brackets in source column '${techHeader}'; whether this is rated or measured output is not stated.` };
    }
  }
  if (cap) {
    Object.assign(plant, {
      capacity_raw: cap.raw, capacity_value: cap.value, capacity_unit: cap.unit, capacity_unit_label: cap.unitLabel,
      capacity_basis: cap.basis, capacity_gallon_type: cap.gallonType,
    });
    provided.add('capacity');
    warnings.push(...cap.warnings);
    for (const i of cap.issues) {
      issues.add(i);
      if (i === 'capacity_gallon_type_unspecified') warn('capacity', i, DATA_ISSUES[i].description, cap.raw);
    }
  }

  const limHeader = headerOf('collection_limit');
  const lim = limHeader ? parseCollectionLimit(get('collection_limit'), limHeader) : null;
  if (lim) {
    Object.assign(plant, { collection_limit_raw: lim.raw, collection_limit_value: lim.value, collection_limit_unit: lim.unit, collection_limit_period: lim.period });
    provided.add('collection_limit');
    warnings.push(...lim.warnings);
  }

  // Status
  const statusRaw = text(get('status_raw'));
  if (statusRaw !== null) {
    const mapped = mapStatus(statusRaw);
    Object.assign(plant, { status: mapped.status, status_raw: statusRaw, status_source: 'spreadsheet', status_updated_at: null });
    provided.add('status');
    if (!mapped.recognised) flag('unrecognised_status', 'status_raw', statusRaw, `Status "${statusRaw}" cannot be mapped with confidence, so it is shown as unknown.`);
    const sd = headerOf('status_date') ? parseDate(get('status_date'), today) : { date: null };
    if (sd.invalid) warn('status_date', sd.future ? 'date_in_future' : 'date_invalid', sd.future ? 'Status date is in the future, so it was not used.' : 'Status date is not a recognised date, so it was not used.', text(get('status_date')));
    if (sd.ambiguous) warn('status_date', 'date_ambiguous_format', 'Status date could be read day-first or month-first; it was read day-first (DD/MM/YYYY).', text(get('status_date')));
    if (sd.date) plant.status_updated_at = sd.date;
    else flag('status_undated', 'status_raw', statusRaw);
  }

  // Source-recorded verification date (applied to new plants only; never overwrites an administrator's)
  if (headerOf('last_verified_at') && get('last_verified_at') !== null) {
    const lv = parseDate(get('last_verified_at'), today);
    if (lv.date) {
      plant.last_verified_at = lv.date;
      plant.verification_note = `Verification date as recorded in source file '${ctx.sourceFile}' (row ${ctx.rowNumber}); not verified by a Team Water administrator.`;
      provided.add('last_verified');
      if (lv.ambiguous) warn('last_verified_at', 'date_ambiguous_format', 'Date could be read day-first or month-first; it was read day-first (DD/MM/YYYY).', text(get('last_verified_at')));
    } else warn('last_verified_at', lv.future ? 'date_in_future' : 'date_invalid', 'Last-verified date is not a valid past date, so it was not used.', text(get('last_verified_at')));
  }

  // Water tests: only with a sample date AND at least one parameter value. Never assessed here.
  const tests = [];
  const results = [];
  for (const key of Object.keys(mapping || {})) {
    if (!isParamKey(key) || !mapping[key]) continue;
    const v = values[mapping[key]];
    if (isBlank(v)) continue;
    const valueText = String(v).trim();
    results.push({
      parameter: key.slice(PARAM_PREFIX.length).trim().slice(0, 100),
      valueText: valueText.slice(0, 200),
      valueNum: /^[-+]?\d+(?:\.\d+)?$/.test(valueText) ? Number(valueText) : null,
      unit: headerHint(mapping[key]),
    });
  }
  const testDateIn = headerOf('water_test_date') ? get('water_test_date') : null;
  const td = parseDate(testDateIn, today);
  if (td.invalid) warn('water_test_date', td.future ? 'date_in_future' : 'date_invalid', 'Water test date is not a valid past date.', text(testDateIn));
  if (td.ambiguous) warn('water_test_date', 'date_ambiguous_format', 'Water test date could be read day-first or month-first; it was read day-first (DD/MM/YYYY).', text(testDateIn));
  if (results.length && td.date) tests.push({ sampleDate: td.date, laboratory: text(get('water_test_lab')), results });
  else if (results.length) warn('water_test_date', 'water_test_undated', 'Water test values are present without a valid sample date, so no test was recorded.', null);
  else if (td.date) warn('water_test_date', 'water_test_without_results', 'A water test date is present without any parameter values, so no test was recorded.', td.date);

  // Source document link
  const sources = [];
  const url = text(get('source_document_url'));
  if (url !== null) {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(url).protocol); } catch { ok = false; }
    if (ok) sources.push({ title: 'Source document (from import)', url: url.slice(0, 2000) });
    else warn('source_document_url', 'source_url_invalid', 'Source document link is not a valid http(s) URL, so it was not stored.', url);
  }

  // Traceability (always)
  Object.assign(plant, {
    source_file: ctx.sourceFile, source_sheet: ctx.sheet, source_row: ctx.rowNumber, source_values_json: JSON.stringify(values),
  });

  const issueList = [...issues];
  const needsReview = issueList.some((i) => !DATASET_WIDE.has(i));
  plant.needs_review = needsReview ? 1 : 0;
  plant.review_reasons_json = JSON.stringify(issueList);

  const missingFields = [];
  if (!plant.name) missingFields.push('name');
  if (!plant.town) missingFields.push('town');
  if (!plant.area_raw) missingFields.push('area');
  if (!plant.address) missingFields.push('address');
  if (!hasCoords) missingFields.push('coordinates');
  if (!plant.operator_type) missingFields.push('operatorType');
  if (!plant.operator_name) missingFields.push('operatorName');
  if (!plant.water_source) missingFields.push('waterSource');
  if (!plant.technology_raw) missingFields.push('technology');
  if (!cap || cap.value === null) missingFields.push('capacity');
  if (!plant.opening_hours_text) missingFields.push('openingHours');
  if (!lim || lim.value === null) missingFields.push('collectionLimit');
  if (!plant.status_raw) missingFields.push('status');
  if (!plant.public_phone) missingFields.push('contact');
  if (!plant.accessibility) missingFields.push('accessibility');
  if (!tests.length) missingFields.push('waterTests');

  const geocode = !hasCoords && plant.address ? { address: plant.address, town: plant.town || null } : null;

  const present = new Set(provided);
  if (latIn !== null || lngIn !== null) present.add('coords');

  return {
    code, plant, provided: [...provided], present: [...present], issues: issueList, errors, warnings, missingFields,
    incomplete: !hasCoords || !plant.name, needsReview, tests, sources, areaKey: areaKeyValue, geocode,
  };
}

module.exports = {
  normalizeRow, parseCapacity, parseCollectionLimit, parseUnitText, mapStatus, mapTechnology, parseDate, parseCoordinate,
  inBounds, nameSimilarity, gphEquivalent, GROUPS, TRACE_COLUMNS, CAPACITY_HIGH_GPH, DATASET_WIDE, isBlank,
};
