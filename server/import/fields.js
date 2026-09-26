'use strict';
// Import target fields, header auto-mapping and the data-issue vocabulary.
//
//   const { TARGET_FIELDS, DATA_ISSUES, suggestMapping } = require('./fields');
//   suggestMapping(['Plant ID', 'Town/Tehsil', 'TDS (mg/L)'])
//     -> { plant_code: 'Plant ID', town: 'Town/Tehsil', ..., 'param:TDS': 'TDS (mg/L)' }
//
// Matching is case- and punctuation-insensitive ("Town/Tehsil" == "town tehsil" == "TOWN-TEHSIL").
// A header's parenthetical part is ignored as a fallback ("Capacity (Gallons Per Hour)" -> capacity),
// and is read separately as a unit hint by the normaliser.

/** Every field a source column can be mapped to. `param:<Name>` keys are also accepted (water-test parameters). */
const TARGET_FIELDS = [
  { key: 'plant_code', label: 'Plant ID', required: true, description: 'Stable plant identifier from the source, e.g. FSD-WFP-0001. Rows without it are rejected; later rows repeating an ID are held for duplicate review.' },
  { key: 'name', label: 'Plant name', required: false, description: 'Name of the plant or site as recorded.' },
  { key: 'town', label: 'Town / Tehsil', required: false, description: 'Town or tehsil as recorded. Used with the area to link an area record.' },
  { key: 'area_raw', label: 'Area / Union Council', required: false, description: 'Area exactly as recorded. A trailing "- Sector N" is split into area name and sector.' },
  { key: 'address', label: 'Street address', required: false, description: 'Street address. When coordinates are missing it may be geocoded at commit; any match stays hidden until an administrator verifies it.' },
  { key: 'neighborhood', label: 'Neighbourhood / Mohalla', required: false, description: 'Neighbourhood or mohalla as recorded.' },
  { key: 'landmark', label: 'Landmark', required: false, description: 'Nearby landmark as recorded.' },
  { key: 'latitude', label: 'Latitude', required: false, description: 'WGS84 decimal degrees (about 31.4 for Faisalabad). Values outside the district or that look swapped are flagged and not stored.' },
  { key: 'longitude', label: 'Longitude', required: false, description: 'WGS84 decimal degrees (about 73.1 for Faisalabad).' },
  { key: 'operator_type', label: 'Operator type', required: false, description: 'Kind of operator as recorded, e.g. "Government (WASA)".' },
  { key: 'operator_name', label: 'Operator name', required: false, description: 'Actual name of the operating organisation.' },
  { key: 'water_source', label: 'Water source', required: false, description: 'Raw water source as recorded, e.g. "Groundwater (Tube Well)".' },
  { key: 'technology_raw', label: 'Filtration technology', required: false, description: 'Treatment technology as recorded. Mapped to treatment stages only for known values; nothing else is inferred.' },
  { key: 'capacity', label: 'Production capacity', required: false, description: 'Production rate with unit, e.g. "5000 GPH". If the cell has no unit, the unit in the column header is used. This is NOT a per-person allowance.' },
  { key: 'collection_limit', label: 'Collection limit (per person)', required: false, description: 'Per-person collection limit, e.g. "20 litres per visit". Kept separate from capacity and never derived from it.' },
  { key: 'opening_hours_text', label: 'Opening hours', required: false, description: 'Opening hours as recorded (text).' },
  { key: 'status_raw', label: 'Operational status', required: false, description: 'Status as recorded. Mapped conservatively; unclear values become "unknown" and are flagged.' },
  { key: 'status_date', label: 'Status date', required: false, description: 'Date the status was observed (YYYY-MM-DD or DD/MM/YYYY). Without it the status is treated as undated.' },
  { key: 'public_phone', label: 'Public phone', required: false, description: "The plant's own public contact number (never a reporter's number)." },
  { key: 'accessibility', label: 'Accessibility', required: false, description: 'Accessibility notes as recorded.' },
  { key: 'last_verified_at', label: 'Last verified (source)', required: false, description: 'Date the source says the record was last verified. Stored for new plants only; never overwrites an administrator verification.' },
  { key: 'water_test_date', label: 'Water test date', required: false, description: 'Sample date of a water test. A test is recorded only when this date and at least one parameter value are present.' },
  { key: 'water_test_lab', label: 'Water test laboratory', required: false, description: 'Laboratory or organisation that tested the sample.' },
  { key: 'source_document_url', label: 'Source document URL', required: false, description: 'Link to a document supporting the record (http/https).' },
];
const TARGET_KEYS = new Set(TARGET_FIELDS.map((f) => f.key));
const PARAM_PREFIX = 'param:';

/** Normalise a header or synonym for comparison: lower-case letters and digits only. */
const normHeader = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** Header without any parenthetical / bracketed part: "Capacity (Gallons Per Hour)" -> "Capacity". */
const headerBase = (s) => String(s ?? '').replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ').trim();
/** Parenthetical / bracketed part of a header, e.g. "Gallons Per Hour" or "mg/L". */
function headerHint(s) {
  const m = String(s ?? '').match(/\(([^)]*)\)|\[([^\]]*)\]/);
  return m ? (m[1] ?? m[2] ?? '').trim() || null : null;
}

const SYNONYMS = {
  plant_code: ['plant id', 'plant code', 'plant no', 'plant number', 'plant #', 'id', 'code', 'site id', 'site code', 'facility id', 'facility code', 'station id', 'wfp id', 'filter plant id', 'plant ref', 'reference', 'ref'],
  name: ['name', 'plant name', 'plant / project name', 'plant project name', 'project name', 'site name', 'facility name', 'filter plant name', 'station name', 'title'],
  town: ['town', 'tehsil', 'tehsil / area', 'tehsil area', 'town/tehsil', 'town tehsil', 'tehsil/town', 'city', 'sub division', 'subdivision', 'town name'],
  area_raw: ['area', 'area/union council', 'area / uc', 'area/uc', 'union council', 'uc', 'locality', 'area name', 'location', 'area union council'],
  address: ['address', 'address / location', 'address location', 'street address', 'full address', 'location address', 'site address', 'plant address'],
  neighborhood: ['neighborhood', 'neighbourhood', 'mohalla', 'mohallah', 'colony', 'block'],
  landmark: ['landmark', 'nearby landmark', 'near', 'nearest landmark', 'land mark'],
  latitude: ['lat', 'latitude', 'y', 'lat dd', 'gps lat', 'gps latitude', 'latitude dd', 'lat (n)', 'northing'],
  longitude: ['lng', 'lon', 'long', 'longitude', 'x', 'gps lng', 'gps lon', 'gps long', 'gps longitude', 'longitude dd', 'easting'],
  operator_type: ['operator type', 'operating entity type', 'entity type', 'ownership', 'ownership type', 'owner type', 'operator category', 'managed by type', 'sector type', 'type of operator'],
  operator_name: ['operator', 'operator name', 'operating entity', 'operating entity name', 'managed by', 'owner', 'owner name', 'organisation', 'organization', 'agency'],
  water_source: ['water source', 'source', 'source water', 'raw water source', 'source of water', 'intake', 'water supply source'],
  technology_raw: ['technology', 'plant type', 'filtration technology', 'treatment technology', 'treatment', 'filtration type', 'filtration', 'treatment type', 'filter type', 'plant technology'],
  capacity: ['capacity', 'plant capacity', 'production capacity', 'rated capacity', 'output', 'production', 'flow rate', 'design capacity'],
  collection_limit: ['collection limit', 'per person limit', 'limit per person', 'allowance', 'quota', 'max collection', 'maximum collection', 'collection limit per person', 'per visit limit', 'daily limit'],
  opening_hours_text: ['opening hours', 'hours', 'timings', 'timing', 'operating hours', 'open hours', 'schedule', 'working hours', 'hours of operation'],
  status_raw: ['status', 'operational status', 'operating status', 'functional status', 'plant status', 'condition', 'current status', 'functionality'],
  status_date: ['status date', 'status as of', 'status updated', 'status updated at', 'status checked', 'status checked on', 'status verified on', 'date of status', 'status observed', 'status observed on'],
  public_phone: ['phone', 'public phone', 'contact', 'contact number', 'contact no', 'phone number', 'phone no', 'telephone', 'tel', 'mobile', 'helpline'],
  accessibility: ['accessibility', 'wheelchair access', 'access', 'accessible', 'disabled access'],
  last_verified_at: ['last verified', 'last verified at', 'last verified on', 'verified on', 'verification date', 'date verified', 'survey date', 'last surveyed', 'date of survey'],
  water_test_date: ['test date', 'water test date', 'sample date', 'sampling date', 'date of test', 'lab test date', 'date sampled', 'testing date'],
  water_test_lab: ['lab', 'laboratory', 'testing lab', 'test lab', 'tested by', 'water test lab', 'testing laboratory', 'lab name'],
  source_document_url: ['source url', 'source document', 'source document url', 'document url', 'document', 'source link', 'reference url', 'url', 'link', 'document link'],
};

/** Water-quality parameter names recognised for auto-mapping to `param:<Canonical>`. */
const PARAMETERS = {
  pH: ['ph', 'ph value', 'ph level'],
  TDS: ['tds', 'total dissolved solids'],
  Turbidity: ['turbidity'],
  'E. coli': ['e coli', 'ecoli', 'e. coli', 'escherichia coli'],
  'Total coliforms': ['total coliform', 'total coliforms', 'coliform', 'coliforms'],
  'Faecal coliforms': ['faecal coliform', 'faecal coliforms', 'fecal coliform', 'fecal coliforms'],
  Arsenic: ['arsenic'],
  Fluoride: ['fluoride'],
  Nitrate: ['nitrate', 'nitrates', 'no3'],
  Nitrite: ['nitrite', 'no2'],
  Chloride: ['chloride', 'chlorides'],
  'Residual chlorine': ['residual chlorine', 'free chlorine', 'chlorine residual', 'chlorine'],
  Hardness: ['hardness', 'total hardness'],
  Alkalinity: ['alkalinity', 'total alkalinity'],
  Conductivity: ['conductivity', 'ec', 'electrical conductivity'],
  Iron: ['iron', 'fe'],
  Lead: ['lead', 'pb'],
  Sulphate: ['sulphate', 'sulfate', 'so4'],
  Sodium: ['sodium'],
  Calcium: ['calcium'],
  Magnesium: ['magnesium'],
  Manganese: ['manganese'],
  Colour: ['colour', 'color'],
  Odour: ['odour', 'odor'],
  Taste: ['taste'],
};

const SYN_INDEX = new Map();
for (const [key, list] of Object.entries(SYNONYMS)) for (const s of list) if (!SYN_INDEX.has(normHeader(s))) SYN_INDEX.set(normHeader(s), key);
const PARAM_INDEX = new Map();
for (const [name, list] of Object.entries(PARAMETERS)) for (const s of [name, ...list]) PARAM_INDEX.set(normHeader(s), name);

/** Which target a single header would map to (or null). */
function matchHeader(header) {
  const full = normHeader(header);
  if (!full) return null;
  if (SYN_INDEX.has(full)) return SYN_INDEX.get(full);
  const base = normHeader(headerBase(header));
  if (base && SYN_INDEX.has(base)) return SYN_INDEX.get(base);
  const param = PARAM_INDEX.get(full) || (base && PARAM_INDEX.get(base));
  return param ? PARAM_PREFIX + param : null;
}

/**
 * Suggest a mapping for a sheet's headers. Returns { <targetKey>: header|null } for every target field,
 * plus `param:<Name>` entries for recognised parameter columns. First matching header wins.
 */
function suggestMapping(headers) {
  const columns = Object.fromEntries(TARGET_FIELDS.map((f) => [f.key, null]));
  for (const h of headers || []) {
    const target = matchHeader(h);
    if (target && !columns[target]) columns[target] = h;
  }
  return columns;
}

const isParamKey = (k) => typeof k === 'string' && k.startsWith(PARAM_PREFIX) && k.slice(PARAM_PREFIX.length).trim().length > 0;

/**
 * Data-issue codes stored in plants.review_reasons_json (the public UI translates them).
 * `datasetWide` issues describe limitations shared by (nearly) every row of a typical file; on their own
 * they do not put a plant in the review queue.
 */
const DATA_ISSUES = {
  no_coordinates: { datasetWide: true, description: 'The source gives no usable latitude/longitude for this plant, so its exact location is unknown.' },
  area_not_geocodable: { datasetWide: false, description: 'The recorded area is a generic or administrative label (for example "Saline Zone-C", "Kachi Abadi" or "Factory Area"), not a place name that can be located on a map.' },
  area_name_possible_typo: { datasetWide: false, description: 'The recorded area name may contain a spelling mistake (for example "Chalk 224 RB" for "Chak 224 RB"). The original spelling is kept.' },
  sector_suffix_unverified: { datasetWide: true, description: 'The area includes a "Sector N" suffix that does not correspond to a known official subdivision; it is shown as recorded but not used for location.' },
  operator_type_is_plant_type: { datasetWide: false, description: 'The recorded operator type describes a kind of plant (for example "Saline Water Treatment RO") rather than who operates it, so the operator is unknown.' },
  operator_type_technology_mismatch: { datasetWide: false, description: 'The operator type names a technology (for example "Private Commercial RO") that differs from the recorded filtration technology.' },
  operator_acronym_unexplained: { datasetWide: true, description: 'The operator type contains an acronym (for example "PSPA") that the source does not explain. It is shown as recorded and not expanded.' },
  capacity_gallon_type_unspecified: { datasetWide: true, description: 'Capacity is recorded in gallons without saying US or imperial gallons, so it is not converted to litres.' },
  capacity_unusually_high: { datasetWide: false, description: 'The recorded capacity is unusually high for a community filtration point (above 20,000 gallons per hour or equivalent). It is shown as recorded and needs a plausibility check.' },
  status_undated: { datasetWide: true, description: 'The source gives an operational status without a date, so it is not known when the status applied.' },
  coordinates_out_of_bounds: { datasetWide: false, description: 'The source coordinates fall outside the Faisalabad district area, so they were not used.' },
  coordinates_possibly_swapped: { datasetWide: false, description: 'The source latitude and longitude look swapped. They were not used and were not swapped automatically.' },
  unrecognised_technology: { datasetWide: false, description: 'The recorded filtration technology is not one the importer recognises, so no treatment stages are shown.' },
  unrecognised_status: { datasetWide: false, description: 'The recorded status could not be mapped with confidence (for example "Non-Functional" may be temporary or permanent), so the status is shown as unknown.' },
  // Additions beyond the original list (see final report): raised only on paths this spreadsheet never takes.
  duplicate_plant_code: { datasetWide: false, description: 'Another row used the same Plant ID. This record was kept separately by an administrator under a derived code.' },
  geocoded_location_unverified: { datasetWide: false, description: 'The location was estimated from the street address by a geocoder and is awaiting administrator verification. It is not shown publicly.' },
  geocode_ambiguous: { datasetWide: false, description: 'The geocoder returned several possible places for the address; the first was kept for review.' },
  geocode_approximate: { datasetWide: false, description: 'The geocoder matched the address only approximately (for example to a street or area rather than a building).' },
};
const DATASET_WIDE_ISSUES = Object.keys(DATA_ISSUES).filter((k) => DATA_ISSUES[k].datasetWide);

module.exports = {
  TARGET_FIELDS, TARGET_KEYS, PARAM_PREFIX, PARAMETERS, SYNONYMS, DATA_ISSUES, DATASET_WIDE_ISSUES,
  normHeader, headerBase, headerHint, matchHeader, suggestMapping, isParamKey,
};
