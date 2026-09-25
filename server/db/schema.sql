-- Team Water — Faisalabad Water Finder
-- SQLite schema (single source of truth). Applied idempotently on start by server/lib/db.js.
-- Conventions:
--   * Timestamps are ISO-8601 UTC strings: strftime('%Y-%m-%dT%H:%M:%fZ','now') — use lib/time.js nowIso().
--   * Plain dates (sample dates, verification dates) are 'YYYY-MM-DD'.
--   * *_json columns hold JSON text; *_raw columns hold values exactly as received from the source.
--   * NULL means "not provided / unknown". Never store placeholders such as 'N/A' or 0 for unknown.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ───────────────────────── Administrators ─────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'moderator')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,               -- sha256 of the cookie token; raw token never stored
  user_id    INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- ───────────────────────── Area gazetteer ─────────────────────────
-- Areas named in the spreadsheet (e.g. "Model Town" in "Jinnah Town"). Positions are APPROXIMATE
-- area centroids used only for area-level browsing, never presented as a plant's exact location.
CREATE TABLE IF NOT EXISTS areas (
  id              INTEGER PRIMARY KEY,
  area_key        TEXT NOT NULL UNIQUE,      -- lib/text.areaKey(name, town), e.g. 'model-town|jinnah-town'
  kind            TEXT NOT NULL DEFAULT 'area' CHECK (kind IN ('area', 'town', 'landmark')),
  name            TEXT NOT NULL,             -- base area name as it appears in the spreadsheet
  town            TEXT,                      -- Town/Tehsil as it appears in the spreadsheet
  name_ur         TEXT,                      -- Urdu name (search alias; not an official translation)
  aliases_json    TEXT NOT NULL DEFAULT '[]',-- extra search aliases (English variants, Roman Urdu, Urdu)
  latitude        REAL,
  longitude       REAL,
  radius_m        REAL,                      -- rough extent of the area; drawn as a circle, not a pin
  geocode_status  TEXT NOT NULL DEFAULT 'not_attempted'
                  CHECK (geocode_status IN ('not_attempted', 'matched', 'ambiguous', 'not_found', 'not_geocodable', 'manual')),
  geocode_source  TEXT,                      -- e.g. 'OpenStreetMap Nominatim (ODbL)'
  geocode_ref     TEXT,                      -- provider reference, e.g. 'osm:node/123456'
  geocode_note    TEXT,
  reviewed_by     INTEGER REFERENCES admin_users(id),
  reviewed_at     TEXT,
  updated_at      TEXT NOT NULL
);

-- ───────────────────────── Plants ─────────────────────────
CREATE TABLE IF NOT EXISTS plants (
  id                       INTEGER PRIMARY KEY,
  plant_code               TEXT NOT NULL UNIQUE,       -- stable plant ID from source, e.g. 'FSD-WFP-0001'
  name                     TEXT,                       -- NULL = "Not provided"
  town                     TEXT,                       -- Town/Tehsil as recorded
  area_raw                 TEXT,                       -- Area/Union Council exactly as recorded
  area_name                TEXT,                       -- parsed base area, e.g. 'Model Town'
  area_sector              TEXT,                       -- parsed suffix, e.g. 'Sector 9'
  area_id                  INTEGER REFERENCES areas(id),
  address                  TEXT,
  neighborhood             TEXT,
  landmark                 TEXT,

  -- Exact position only. Area-level approximations live in `areas`, NOT here.
  latitude                 REAL,
  longitude                REAL,
  coord_status             TEXT NOT NULL DEFAULT 'missing'
                           CHECK (coord_status IN ('missing', 'source', 'geocoded_pending', 'verified')),
                           -- source: provided by the imported file (unverified)
                           -- geocoded_pending: address geocoder match awaiting admin review (NOT public)
                           -- verified: confirmed by an administrator
  coord_source             TEXT,                       -- e.g. 'spreadsheet', 'admin map pin', 'Nominatim'
  coord_accuracy_m         REAL,
  coord_note               TEXT,

  operator_type            TEXT,                       -- e.g. 'Government (WASA)' as recorded
  operator_name            TEXT,
  water_source             TEXT,                       -- as recorded
  technology_raw           TEXT,                       -- as recorded, e.g. 'Activated Carbon + UV'
  treatment_stages_json    TEXT NOT NULL DEFAULT '[]', -- stage keys supported by the record (see ARCHITECTURE.md)

  capacity_raw             TEXT,                       -- as recorded, e.g. '5000 GPH'
  capacity_value           REAL,
  capacity_unit            TEXT,                       -- 'gallons_per_hour' | 'gallons_per_day' | 'litres_per_hour' | 'litres_per_day'
  capacity_unit_label      TEXT,                       -- unit text as recorded, e.g. 'GPH'
  capacity_basis           TEXT,                       -- e.g. 'Rated production capacity as recorded in source'
  capacity_gallon_type     TEXT NOT NULL DEFAULT 'unspecified'
                           CHECK (capacity_gallon_type IN ('unspecified', 'us', 'imperial', 'not_applicable')),

  collection_limit_raw     TEXT,                       -- per-person limit, kept separate from capacity
  collection_limit_value   REAL,
  collection_limit_unit    TEXT,                       -- 'litres' | 'gallons'
  collection_limit_period  TEXT,                       -- 'per_visit' | 'per_day'

  opening_hours_text       TEXT,                       -- as recorded
  opening_hours_json       TEXT,                       -- structured: {"mon":[["08:00","20:00"]],...}; NULL if unknown

  status                   TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (status IN ('operational', 'temporarily_closed', 'permanently_closed', 'decommissioned', 'unknown')),
  status_raw               TEXT,                       -- as recorded, e.g. 'Fully Functional'
  status_source            TEXT NOT NULL DEFAULT 'none'
                           CHECK (status_source IN ('none', 'spreadsheet', 'admin', 'admin_verified')),
  status_updated_at        TEXT,
  status_note              TEXT,

  public_phone             TEXT,                       -- plant's PUBLIC contact only (never reporter data)
  public_contact_note      TEXT,
  accessibility            TEXT,

  last_verified_at         TEXT,                       -- 'YYYY-MM-DD'
  last_verified_by         INTEGER REFERENCES admin_users(id),
  verification_note        TEXT,

  needs_review             INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  review_reasons_json      TEXT NOT NULL DEFAULT '[]',

  source_file              TEXT,
  source_sheet             TEXT,
  source_row               INTEGER,                    -- spreadsheet row number (header row = 1)
  source_values_json       TEXT,                       -- original row values, verbatim, keyed by header
  import_batch_id          INTEGER REFERENCES import_batches(id),
  imported_at              TEXT,

  is_demo                  INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plants_town ON plants(town);
CREATE INDEX IF NOT EXISTS idx_plants_area ON plants(area_id);
CREATE INDEX IF NOT EXISTS idx_plants_coord ON plants(coord_status);
CREATE INDEX IF NOT EXISTS idx_plants_latlng ON plants(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_plants_demo ON plants(is_demo);

CREATE TABLE IF NOT EXISTS plant_sources (
  id          INTEGER PRIMARY KEY,
  plant_id    INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  url         TEXT,
  file_id     INTEGER REFERENCES files(id),
  note        TEXT,
  added_by    INTEGER REFERENCES admin_users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plant_status_history (
  id                     INTEGER PRIMARY KEY,
  plant_id               INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  old_status             TEXT,
  new_status             TEXT NOT NULL,
  assessment             TEXT NOT NULL,              -- documented administrator assessment (required)
  evidence_report_ids_json TEXT NOT NULL DEFAULT '[]',
  investigation_id       INTEGER REFERENCES investigations(id),
  actor_user_id          INTEGER NOT NULL REFERENCES admin_users(id),
  created_at             TEXT NOT NULL
);

-- ───────────────────────── Water testing (evidence) ─────────────────────────
CREATE TABLE IF NOT EXISTS water_tests (
  id                 INTEGER PRIMARY KEY,
  plant_id           INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  sample_date        TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  laboratory         TEXT,                           -- lab or source organisation
  source_description TEXT,
  report_file_id     INTEGER REFERENCES files(id),
  standard_name      TEXT,                           -- required for any pass/fail comparison
  standard_version   TEXT,
  standard_source    TEXT,                           -- citation / URL of the standard
  outcome            TEXT NOT NULL DEFAULT 'not_assessed'
                     CHECK (outcome IN ('met_limits', 'issue_detected', 'not_assessed')),
  notes              TEXT,
  published          INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)),
  created_by         INTEGER REFERENCES admin_users(id),
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tests_plant ON water_tests(plant_id, sample_date);

CREATE TABLE IF NOT EXISTS water_test_results (
  id           INTEGER PRIMARY KEY,
  test_id      INTEGER NOT NULL REFERENCES water_tests(id) ON DELETE CASCADE,
  parameter    TEXT NOT NULL,                        -- as recorded: 'pH', 'Turbidity', 'TDS', 'E. coli', ...
  value_text   TEXT NOT NULL,                        -- as recorded: '7.2', 'Absent', '<1'
  value_num    REAL,
  unit         TEXT,
  limit_text   TEXT,                                 -- threshold from the referenced standard, as written
  within_limit INTEGER CHECK (within_limit IN (0, 1))-- NULL = not assessed
);

-- ───────────────────────── Files (uploads) ─────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('report_photo', 'test_report', 'source_document', 'import_upload')),
  storage_path      TEXT NOT NULL,                   -- relative to config.uploadDir
  original_name     TEXT,
  mime              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  perceptual_hash   TEXT,                            -- optional near-duplicate image hash
  metadata_stripped INTEGER NOT NULL DEFAULT 0 CHECK (metadata_stripped IN (0, 1)),
  uploaded_by_user  INTEGER REFERENCES admin_users(id),
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);

-- ───────────────────────── Community: reporters, reports, ratings ─────────────────────────
CREATE TABLE IF NOT EXISTS reporters (
  id                  INTEGER PRIMARY KEY,
  phone_hash          TEXT NOT NULL UNIQUE,          -- HMAC-SHA256(normalized phone); lookup key
  phone_enc           TEXT,                          -- AES-256-GCM ciphertext; NULL after retention purge
  phone_last4         TEXT,
  phone_verified_at   TEXT,
  public_alias        TEXT NOT NULL,                 -- privacy-preserving display name, e.g. 'Community member 4821'
  confirmed_reports   INTEGER NOT NULL DEFAULT 0,
  rejected_reports    INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'blocked')),
  status_reason       TEXT,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id                    INTEGER PRIMARY KEY,
  reference             TEXT NOT NULL UNIQUE,        -- public reference, e.g. 'TW-8K2M-4QXZ'
  plant_id              INTEGER NOT NULL REFERENCES plants(id),
  reporter_id           INTEGER REFERENCES reporters(id) ON DELETE SET NULL,
  category              TEXT NOT NULL CHECK (category IN (
                          'closed_during_hours', 'no_water', 'broken_equipment', 'color_odor_taste',
                          'dirty_surroundings', 'incorrect_details', 'unexpected_charges', 'other')),
  description           TEXT NOT NULL,
  observed_at           TEXT NOT NULL,               -- 'YYYY-MM-DDTHH:MM' local (Asia/Karachi), approximate
  consent_contact       INTEGER NOT NULL CHECK (consent_contact IN (0, 1)),
  phone_verified        INTEGER NOT NULL DEFAULT 0 CHECK (phone_verified IN (0, 1)),
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'under_review', 'needs_clarification', 'confirmed', 'resolved', 'rejected')),
  severity              TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal', 'serious')),
  risk_score            INTEGER NOT NULL DEFAULT 0,  -- internal only; never exposed publicly
  risk_reasons_json     TEXT NOT NULL DEFAULT '[]',  -- internal only
  review_queue          INTEGER NOT NULL DEFAULT 0 CHECK (review_queue IN (0, 1)),
  proximity_shared      INTEGER NOT NULL DEFAULT 0 CHECK (proximity_shared IN (0, 1)),
  proximity_distance_m  REAL,                        -- distance to plant if shared; raw coordinates NOT stored
  proximity_basis       TEXT CHECK (proximity_basis IN ('plant', 'area_centre')), -- what the distance was measured to
  text_fingerprint      TEXT,
  lang                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  retention_until       TEXT,
  redacted_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_plant ON reports(plant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, review_queue);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_fp ON reports(text_fingerprint);

CREATE TABLE IF NOT EXISTS report_photos (
  id                INTEGER PRIMARY KEY,
  report_id         INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  file_id           INTEGER NOT NULL REFERENCES files(id),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  moderation_note   TEXT,
  public            INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1))
);

CREATE TABLE IF NOT EXISTS report_events (
  id            INTEGER PRIMARY KEY,
  report_id     INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES admin_users(id), -- NULL = system or reporter
  action        TEXT NOT NULL,                      -- 'submitted','auto_flagged','status_change','note','clarification_requested','reporter_reply','appeal'
  from_status   TEXT,
  to_status     TEXT,
  reason        TEXT,                               -- internal reason (required for moderator decisions)
  public_note   TEXT,                               -- visible to the reporter on the status page
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_events ON report_events(report_id, created_at);

-- Experience ratings are SEPARATE from complaint reports. A complaint never creates a rating.
CREATE TABLE IF NOT EXISTS ratings (
  id                INTEGER PRIMARY KEY,
  plant_id          INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  reporter_id       INTEGER REFERENCES reporters(id) ON DELETE SET NULL,
  stars             INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  risk_score        INTEGER NOT NULL DEFAULT 0,
  risk_reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ratings_plant ON ratings(plant_id, status);

CREATE TABLE IF NOT EXISTS investigations (
  id          INTEGER PRIMARY KEY,
  plant_id    INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  findings    TEXT,
  resolution  TEXT,
  opened_by   INTEGER REFERENCES admin_users(id),
  opened_at   TEXT NOT NULL,
  closed_by   INTEGER REFERENCES admin_users(id),
  closed_at   TEXT
);

CREATE TABLE IF NOT EXISTS investigation_reports (
  investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  report_id        INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  PRIMARY KEY (investigation_id, report_id)
);

-- Corrections, appeals and deletion requests from the public.
CREATE TABLE IF NOT EXISTS appeals (
  id          INTEGER PRIMARY KEY,
  reference   TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('correction', 'appeal', 'deletion_request')),
  report_id   INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  plant_id    INTEGER REFERENCES plants(id),
  reporter_id INTEGER REFERENCES reporters(id) ON DELETE SET NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'accepted', 'declined', 'completed')),
  resolution  TEXT,
  resolved_by INTEGER REFERENCES admin_users(id),
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS phone_verifications (
  id          INTEGER PRIMARY KEY,
  phone_hash  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  verified_at TEXT,
  token_hash  TEXT,                                 -- short-lived token issued after a correct code
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phone_ver ON phone_verifications(phone_hash, created_at);

-- Rate limiting / burst detection. `subject` is always a keyed hash (never a raw IP or phone).
CREATE TABLE IF NOT EXISTS rate_events (
  id         INTEGER PRIMARY KEY,
  bucket     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at INTEGER NOT NULL                       -- unix epoch milliseconds
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(bucket, subject, created_at);

-- ───────────────────────── Spreadsheet imports ─────────────────────────
CREATE TABLE IF NOT EXISTS import_batches (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER REFERENCES files(id),
  source_filename TEXT NOT NULL,
  file_sha256     TEXT NOT NULL,
  sheet_name      TEXT,
  mapping_json    TEXT,
  status          TEXT NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded', 'previewed', 'committed', 'cancelled', 'failed')),
  summary_json    TEXT,
  created_by      INTEGER REFERENCES admin_users(id), -- NULL = command-line seed
  created_at      TEXT NOT NULL,
  committed_at    TEXT
);

CREATE TABLE IF NOT EXISTS import_rows (
  id              INTEGER PRIMARY KEY,
  batch_id        INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number      INTEGER NOT NULL,
  raw_json        TEXT NOT NULL,
  normalized_json TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('new', 'update', 'unchanged', 'rejected', 'duplicate_review')),
  incomplete      INTEGER NOT NULL DEFAULT 0 CHECK (incomplete IN (0, 1)),
  errors_json     TEXT NOT NULL DEFAULT '[]',
  warnings_json   TEXT NOT NULL DEFAULT '[]',
  plant_id        INTEGER REFERENCES plants(id)
);
CREATE INDEX IF NOT EXISTS idx_import_rows ON import_rows(batch_id, row_number);

CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id              INTEGER PRIMARY KEY,
  batch_id        INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  import_row_id   INTEGER REFERENCES import_rows(id) ON DELETE SET NULL,
  plant_id        INTEGER REFERENCES plants(id) ON DELETE CASCADE,
  other_plant_id  INTEGER REFERENCES plants(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL,
  score           REAL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'kept_separate', 'dismissed')),
  resolution_note TEXT,
  resolved_by     INTEGER REFERENCES admin_users(id),
  resolved_at     TEXT
);

-- ───────────────────────── Caches & audit ─────────────────────────
-- Forward-geocoding cache keyed by normalized query TEXT. User coordinates are never stored.
CREATE TABLE IF NOT EXISTS geocode_cache (
  query_key     TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES admin_users(id),
  actor_label   TEXT NOT NULL,                      -- username snapshot, or 'system' / 'cli'
  action        TEXT NOT NULL,                      -- e.g. 'plant.update', 'report.decision', 'contact.reveal'
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before_json   TEXT,
  after_json    TEXT,
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
