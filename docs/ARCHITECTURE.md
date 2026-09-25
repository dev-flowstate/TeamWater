# Team Water — Architecture & Team Contract

**Team Water** is a mobile-friendly site that helps people in and around Faisalabad find water filtration plants, compare them, get directions, and report problems. The flow is: choose a location, find a plant, read its details, get directions.

This file is the **contract** between workstreams. If you need something outside your area, code against this contract. Don't edit files another workstream owns. If the contract is wrong or missing something, say so in your final report and don't work around it quietly.

---

## 0. Non-negotiable accuracy rules

1. **The Excel file is the source.** Preserve its original values verbatim (`*_raw` columns and `plants.source_values_json`). Flag inconsistencies. Never correct them silently.
2. **Never fabricate** plants, coordinates, names, addresses, treatment steps, capacities, hours, test results, ratings, reviews, or verification badges. If a value is unknown, show **"Not provided"**. If something is unconfirmed, show **"Not verified"**. If water quality has no evidence, show **"Unknown"**.
3. **Capacity is not a collection allowance.** `5000 GPH` is a production rate in gallons per hour. It is not a per-person or per-day allowance. The gallon type (US or imperial) is **not stated**, so don't convert to litres unless `capacity_gallon_type` is set.
4. **Location precision is explicit.** Only `coord_status IN ('source','verified')` with lat/lng counts as an **exact** plant location. Area centroids are **approximate**. Draw them as circles or area labels, never as pins, and never present them as a plant's exact position.
5. **Water testing evidence and community ratings are separate.** Ratings never imply safety. There's no "cleanliness %".
6. **Reports aren't findings.** An unverified report never changes a plant's official status. Changing status requires an administrator's documented assessment (`plant_status_history.assessment`).
7. **Phone numbers are private.** They're stored encrypted. Only the `admin` role can reveal one, and every reveal is audited. They never appear in public APIs, logs, exports (unless an admin explicitly asks), or `audit_log` payloads.
8. **Never silently replace live data with fiction.** If a provider is down, return an explicit `available:false` / `unavailable` and let the UI show a clear failure state.
9. **Demo data** (`plants.is_demo = 1`, codes `DEMO-####`) exists only when `DEMO_DATA=1`. Every demo plant is labelled "DEMO — not a real plant", and every page shows a banner.

## 1. Source data findings (spreadsheet `data/source/Filter_palnts_in_Faisalabad_1000_1.xlsx`)

- One sheet, `Faisalabad_1000_Water_Filtratio` (the name is truncated at Excel's 31-character limit), with 1,000 data rows and 8 columns: `Plant ID`, `Town/Tehsil`, `Area/Union Council`, `Operating Entity Type`, `Water Source`, `Filtration Technology`, `Capacity (Gallons Per Hour)`, `Operational Status`.
- **Missing entirely:** plant name, street address, landmark, **latitude/longitude**, opening hours, per-person collection limit, operator's actual name (only a type), contact details, accessibility, water-test results or dates, source documents, and verification dates.
- **So no plant has an exact location.** Nearest-plant results can only be **area-level approximations** until an admin pins a plant or a future file supplies coordinates.
- Plant IDs `FSD-WFP-0001…1000` are unique and well formed.
- `Area/Union Council` always follows `<Area> - Sector <1–14>`. There are 39 base areas, each in exactly one town. No union-council numbers are given. The "Sector N" suffix is applied the same way to cities and rural *chaks*, and it isn't a known official subdivision.
- Areas that can't be geocoded: `Saline Zone-A/B/C/D` (not place names), `Kachi Abadi` (a generic term for an informal settlement), and `Factory Area` (generic).
- Likely typo: `Chalk 224 RB` probably means `Chak 224 RB`. Keep the original and add a search alias.
- `Town/Tehsil` mixes city administrative towns (Lyallpur, Jinnah, Iqbal, Madina) with tehsils (Jaranwala, Samundri, Tandlianwala, Chak Jhumra). Faisalabad Sadar/City tehsil is absent.
- `Operating Entity Type` mixes kinds of values. `Saline Water Treatment RO` (161 rows) describes a plant type, not an operator. `Private Commercial RO` appears with UF and Carbon+UV technologies. `PSPA` is an unexplained acronym (possibly the Punjab Saaf Pani / Aab-e-Pak authority), so don't expand it.
- `Operational Status` is `Fully Functional` in all 1,000 rows, with no date. Treat it as *listed as operational in the source spreadsheet (undated, not verified)*.
- Capacities are exactly 1,000, 2,000, 5,000, 10,000, or 25,000 GPH. The gallon type isn't stated. 25,000 GPH is unusually large for a community filtration point, so flag it for plausibility review but keep it.
- The very even distributions suggest the file may be modelled or generated rather than surveyed. Say this neutrally and recommend verifying against the issuing authority.

## 2. Stack & running

- Node ≥ 22.13, **Express 5**, and SQLite via built-in **`node:sqlite`**. There is no native build step.
- The frontend has no framework and no bundler. It uses native **ES modules** served from `public/`.
- Vendor assets are served from `node_modules`:
  - `/vendor/leaflet/` (Leaflet 1.9 `dist`)
  - `/vendor/fontsource/<pkg>/files/*.woff2`
  - `/vendor/animejs/anime.esm.min.js` (anime.js v4, about 40 KB gzip; **lazy-load only**)
  - `/vendor/motion/…` (Motion 12 `dist`)
- Available npm packages: `express`, `exceljs`, `multer`, `leaflet`, `animejs`, `motion`, `@fontsource/{dm-serif-display,gochi-hand,inter,noto-nastaliq-urdu}`, and `playwright-core` (dev).
- **Don't modify `package.json` or run `npm install`.** Ask the lead if you need a package.
- Commands: `npm run setup` (DB, gazetteer, spreadsheet import, admin user), `npm start`, `npm test` (node:test, `test/**/*.test.js`), and `npm run test:e2e`.
- For parallel development, give every agent its own `PORT` and `DATA_DIR` (see your brief) so databases and ports don't collide.
- Network: the build sandbox **can't reach** OSM tiles, Nominatim, OSRM, or mapcarta.com (egress policy). Code must handle provider failure gracefully. Tests use `GEOCODER_PROVIDER=none` and `ROUTING_PROVIDER=none`.
- Chromium for Playwright: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (use `playwright-core` with `executablePath`).

## 3. File ownership

| Workstream | Owns (create/edit only these) |
|---|---|
| **Lead (foundation)** | `package.json`, `server/app.js`, `server/index.js`, `server/config.js`, `server/db/schema.sql`, `server/lib/{db,auth,audit,http,crypto,ratelimit,time,text}.js`, `server/routes/admin-auth.js`, `scripts/{setup,create-admin}.js`, `test/helpers.js`, `test/foundation.test.js`, `public/css/tokens.css`, `public/js/i18n.js`, `docs/ARCHITECTURE.md`, `README.md` |
| **Geo** | `data/gazetteer/**`, `server/lib/gazetteer.js`, `docs/MAP_SOURCES.md`, `test/gazetteer.test.js` |
| **Import** | `server/import/**`, `server/routes/admin-imports.js`, `scripts/import-xlsx.js`, `docs/DATA_AUDIT.md`, `test/import.test.js` |
| **Core API** | `server/routes/public.js`, `server/routes/admin-plants.js`, `server/routes/admin-system.js`, `server/lib/{geo,ranking,routing,geocoder,plant-view,hours,demo,providers}.js` (and `server/lib/providers/**`), `test/api-core.test.js` |
| **Reports** | `server/routes/reports.js`, `server/routes/admin-reports.js`, `server/lib/{risk,images,sms,reporters,retention,moderation}.js`, `test/reports.test.js` |
| **Public UI** | `public/index.html`, `public/about.html`, `public/privacy.html`, `public/css/app.css`, `public/js/{app,api,shell,state,results,card,search,util}.js`, `public/js/map/**`, `public/i18n/{common,search,about}.{en,ur}.json` |
| **Report UI** | `public/report.html`, `public/status.html`, `public/css/report.css`, `public/js/{report-form,status,appeal}.js`, `public/i18n/report.{en,ur}.json` |
| **Visuals** | `public/js/diagram.js`, `public/css/diagram.css`, `public/img/**`, `public/diagram-preview.html`, `docs/VISUAL_BUDGET.md` |
| **Admin UI** | `public/admin/**` |

Shared frontend modules that others may import:

- `/js/i18n.js` is owned by the Lead.
- `/js/api.js`, `/js/shell.js` and `/js/util.js` are owned by Public UI.
- `/js/diagram.js` is owned by Visuals.

**Report UI** and **Admin UI** must not depend on the Public UI modules being finished. Use `fetch` directly, and use `/js/i18n.js` and `/css/tokens.css`, which already exist.

## 4. Shared server libraries (already implemented — use them)

```js
const config = require('../config');                       // see server/config.js
const { getDb, tx, parseJson, plain } = require('../lib/db');
const { HttpError, validate, str, num, int, oneOf, bool, date, paginate } = require('../lib/http');
const { requirePermission, requireAuth, can } = require('../lib/auth');
const { audit, diff } = require('../lib/audit');
const { normalizePhone, hashPhone, encryptPhone, decryptPhone, maskPhone, hashSubject, randomToken, sha256, reference } = require('../lib/crypto');
const { rateCheck, rateRecord, rateCount, ratePurge } = require('../lib/ratelimit');
const { nowIso, addDays, karachiParts, isIsoDate } = require('../lib/time');
const { normalizeSearch, slug, areaKey, parseAreaRaw } = require('../lib/text');
```

- Errors use the shape `{ error: { code, message, details? } }`. Throw `HttpError`, which Express 5 forwards from async handlers.
- **Permissions:** `admin` has `*`. `editor` has `plants:read`, `plants:write`, `plants:status`, `imports`, `tests:write`, `areas:write`, `duplicates`, `export:plants`, `audit:read`, and `stats`. `moderator` has `plants:read`, `plants:status`, `reports:read`, `reports:moderate`, `reporters:manage`, `appeals`, `investigations`, `export:reports`, `audit:read`, and `stats`. Admin-only permissions are `users:manage`, `contact:reveal`, `export:contacts`, and `maintenance`.
- All mutating admin requests need the `X-CSRF-Token` header. The token comes from `POST /api/admin/login` or `GET /api/admin/me`.
- **Audit** every admin change with `audit(req, {...})` and put the admin's `reason` into it where the API requires one.
- **Tests:** `test/helpers.js` has `startTestServer()`, which provides a temp DB, `login(role)`, and `insertPlant()`.

## 5. Domain semantics

### 5.1 Location precision (computed; never stored as a single field)

- `exact` means `coord_status IN ('source','verified')` and lat/lng are not null. Directions and routing are only allowed for exact locations.
- `area` means the location isn't exact and `plants.area_id → areas` has lat/lng with `geocode_status IN ('matched','manual')`. These plants appear only in the **area** results group, which ranks them by distance to the area centre. They're drawn as a circle with a count, not as individual pins.
- `none` means neither applies. These plants are reachable through the text list (`/api/plants?area=` or `?town=`), never through geographic ranking.

### 5.2 Status

- `plants.status` is one of `operational`, `temporarily_closed`, `permanently_closed`, `decommissioned`, or `unknown`.
- Spreadsheet `Fully Functional` maps to `status='operational'` with `status_source='spreadsheet'` and `status_updated_at=NULL`. The UI then says "Listed as operational in source data (undated, not verified)".
- `status_source='admin_verified'` together with `last_verified_at` is the only case that counts as **verified operating status**.
- Normal results exclude `permanently_closed` and `decommissioned`. `temporarily_closed` plants stay in results but are flagged. `unknown` is flagged as well.

### 5.3 Treatment stage keys (for `treatment_stages_json` and the diagram)

The stage keys are `sediment`, `activated_carbon`, `ultrafiltration`, `reverse_osmosis`, `uv`, `chlorination`, `remineralization`, `storage`, and `dispensing`.

Mapping from recorded technology (the importer applies this; it infers nothing else):

| Recorded technology | Stages |
|---|---|
| `Reverse Osmosis (RO)` | `["reverse_osmosis"]` |
| `Heavy-Duty Brackish RO Membrane (High TDS)` | `["reverse_osmosis"]` |
| `Activated Carbon + UV` | `["activated_carbon","uv"]` |
| `Ultrafiltration (UF)` | `["ultrafiltration"]` |
| anything unrecognised | `[]`, plus a warning |

The recorded **water source** is shown as the diagram's intake node, using the recorded text. The diagram must say **"Illustrative treatment diagram"**. Because the spreadsheet never records the full sequence, it must also say "Other treatment stages, if any, are not recorded."

### 5.4 Capacity display

`{ raw: '5000 GPH', value: 5000, unit: 'gallons_per_hour', unitLabel: 'GPH', gallonType: 'unspecified', basis: '…', litresPerHour: null }`

The UI shows: **"5,000 gallons per hour (GPH) — production capacity as recorded; gallon type not specified. This is not a per-person allowance."** Show litres only if `litresPerHour` is non-null, which requires `gallonType` to be `us` or `imperial`.

### 5.5 Ratings

- Stars run from 1 to 5. Only `status='accepted'` ratings count.
- The adjusted score is a Bayesian mean: `(C·m + Σstars) / (C + n)` with `C = 5` and `m = 3.0`. Always show the review count alongside it.
- With fewer than 3 ratings, show "Too few ratings".

## 6. Public API (no account required)

All responses are JSON. Coordinates are WGS84 decimal degrees. `lat`/`lng` are never rounded in responses.

### `GET /api/config` — Core API
```json
{ "appName": "Team Water",
  "map": { "provider": "osm|google", "providerName": "OpenStreetMap", "tileUrl": "…", "attribution": "…html…", "maxZoom": 19,
           "googleBrowserKey": "(only when provider=google)", "googleMapId": "", "bounds": [[30.75,72.6],[31.85,73.65]],
           "center": [31.418,73.079], "defaultZoom": 11,
           "coverageNote": "Streets, shops and landmarks come from the map provider and may be incomplete.",
           "updatedNote": "OpenStreetMap is continuously edited; tiles reflect the provider's current data." },
  "geocoder": { "provider": "nominatim|google|none" },
  "routing": { "provider": "osrm|google|none", "modes": { "driving": true, "walking": false, "cycling": false } },
  "sms": { "enabled": false },
  "demoMode": false,
  "stats": { "plantsTotal": 1000, "plantsExact": 0, "plantsArea": 700, "plantsNoLocation": 300, "lastImportAt": "…", "sourceFile": "…" },
  "reportCategories": ["closed_during_hours","no_water","broken_equipment","color_odor_taste","dirty_surroundings","incorrect_details","unexpected_charges","other"],
  "limits": { "maxPhotos": 3, "maxPhotoMb": 5, "descriptionMin": 10, "descriptionMax": 2000 } }
```

### `GET /api/geocode?q=<text>&lang=en|ur` — Core API (uses `gazetteer.search` first, then the external provider)
```json
{ "query": "model town",
  "results": [ { "id": "area:12", "label": "Model Town", "sublabel": "Jinnah Town · Faisalabad", "lat": 31.4, "lng": 73.1,
                 "kind": "area|town|landmark|address|place", "precision": "area|street|exact|unknown",
                 "source": "gazetteer|nominatim|google", "bbox": null, "matchedAlias": "ماڈل ٹاؤن", "plantCount": 22, "areaId": 12 } ],
  "ambiguous": false,
  "providers": { "gazetteer": "ok", "external": "ok|unavailable|disabled" } }
```
A gazetteer area with no position has `lat`/`lng` set to `null`. The UI offers "Show plants listed in this area" via `/api/plants?area=` and "Choose on map".

### `GET /api/reverse?lat=&lng=` — Core API
Returns `{ "label": "Near Model Town (approximate)", "source": "gazetteer|nominatim|google", "precision": "area|street" }` or `{ "label": null }`. It isn't cached and the coordinates aren't stored.

### `GET /api/search` — Core API

Query parameters: `lat`, `lng`, `sort=nearest|recommended`, `mode=driving|walking|cycling`, `technology=<raw>`, `operatorType=<raw>`, `hideTemporarilyClosed=1`, `limit=20`.

```json
{ "origin": { "lat": 31.41, "lng": 73.07 }, "sort": "nearest",
  "distance": { "method": "route|straight_line", "mode": "driving", "label": "Approximate straight-line distance",
                "routingAvailable": false, "routingReason": "provider_unavailable|mode_unsupported|disabled|null" },
  "exact": [ PlantSummary, … ],
  "area":  [ PlantSummary, … ],
  "excluded": { "closedPermanently": 0, "noLocation": 300 },
  "notice": null }
```

- **Nearest (default):**
  - In `exact`, candidates are ranked by straight-line (haversine) distance.
  - If routing is available for `mode`, the top 25 candidates are re-ranked by route duration using a table/matrix call. The method is then `route`, and `durationS` is filled in.
  - In `area`, plants are ranked by distance to their area centre. The method is `area_centre`.
  - Ties break on `plantCode`. The order is deterministic for the same inputs.
- **Recommended:**
  - Each plant gets a score in 0–1 from these weights: distance or time 0.45, verified operational status 0.2, dated test evidence 0.15, absence of confirmed unresolved issues 0.1, and adjusted rating 0.1 (only when count ≥ 3).
  - Each plant also gets `recommendation.reasons` codes and a plain-English `text`.
  - Missing test data scores as neutral-unknown, never as "safe".
- Reason codes are: `nearby`, `farther`, `status_verified_operational`, `status_listed_unverified`, `status_unknown`, `temporarily_closed`, `open_now`, `closed_now`, `hours_unknown`, `recent_test_met_limits`, `test_issue_detected`, `no_test_data`, `confirmed_open_issue`, `well_rated`, `few_ratings`, `recently_verified`, `not_verified`, and `location_approximate`.

### PlantSummary (Core API → UI)
```json
{ "code": "FSD-WFP-0009", "name": null, "town": "Madina Town", "areaRaw": "Kohinoor City - Sector 12", "areaName": "Kohinoor City",
  "address": null, "landmark": null, "isDemo": false,
  "location": { "precision": "exact|area|none", "lat": null, "lng": null, "coordStatus": "missing|source|verified|geocoded_pending",
                "area": { "id": 7, "name": "Kohinoor City", "lat": 31.4, "lng": 73.1, "radiusM": 1500 } },
  "status": { "code": "operational", "raw": "Fully Functional", "source": "spreadsheet", "updatedAt": null, "verified": false },
  "openingHours": { "text": null, "structured": null, "openNow": null },
  "technology": { "raw": "Reverse Osmosis (RO)", "stages": ["reverse_osmosis"] },
  "waterSource": "Groundwater (Tube Well)",
  "capacity": { "raw": "10000 GPH", "value": 10000, "unit": "gallons_per_hour", "unitLabel": "GPH", "gallonType": "unspecified", "basis": "…", "litresPerHour": null },
  "collectionLimit": null,
  "operator": { "type": "Government (PSPA)", "name": null },
  "waterQuality": { "state": "unknown|results_available|met_limits|issue_detected", "latestSampleDate": null, "testCount": 0 },
  "rating": { "average": null, "adjusted": null, "count": 0 },
  "lastVerifiedAt": null,
  "rank": 1, "distanceM": 1830, "durationS": null, "distanceMethod": "straight_line|route|area_centre",
  "recommendation": null }
```

### `GET /api/plants/:code` — Core API
Returns a PlantDetail: everything in PlantSummary (without the ranking fields) plus these fields.

```json
{ "operatorName": null, "neighborhood": null, "publicPhone": null, "publicContactNote": null, "accessibility": null,
  "waterTests": [ { "id": 1, "sampleDate": "2026-05-01", "laboratory": "…", "sourceDescription": "…", "standard": { "name": "…", "version": "…", "source": "…" } | null,
                    "outcome": "met_limits|issue_detected|not_assessed", "reportUrl": "/api/files/12" | null,
                    "results": [ { "parameter": "pH", "valueText": "7.4", "unit": null, "limitText": "6.5–8.5", "withinLimit": true|false|null } ] } ],
  "sources": [ { "title": "…", "url": "…" } ],
  "traceability": { "sourceFile": "Filter_palnts_in_Faisalabad_1000_1.xlsx", "sheet": "Faisalabad_1000_Water_Filtratio", "row": 10, "importedAt": "…" },
  "sourceValues": { "Plant ID": "FSD-WFP-0009", "…": "…" },
  "dataIssues": [ "operator_type_is_plant_type", "capacity_gallon_type_unspecified", "status_undated" ],
  "missingFields": [ "name", "address", "coordinates", "openingHours", "collectionLimit", "contact", "accessibility", "waterTests" ],
  "reportsSummary": { "unverifiedOpen": 2, "underReview": 1, "confirmedOpenIssues": [ { "category": "no_water", "confirmedAt": "…", "publicNote": "…" } ], "resolvedLast90d": 0 } }
```

### `GET /api/plants?area=<areaId>|town=<name>&q=&page=&pageSize=` — Core API
This is a text list for no-map, no-location, and area browsing. It returns `{ items: [PlantSummary without ranking], total, page, pageSize }`, ordered by `plantCode`.

### `GET /api/route?from=<lat>,<lng>&to=<plantCode>&mode=driving` — Core API
The destination is **always the plant's stored exact coordinates**, looked up on the server.

Returns `{ available: true, provider, mode, distanceM, durationS, geometry: { type: 'LineString', coordinates: [[lng,lat],…] } }`, or `{ available: false, reason: 'no_exact_location|provider_unavailable|mode_unsupported|disabled' }`.

### `GET /api/files/:id` — Core API
Serves published water-test report files only.

### Reports & ratings — Reports workstream

- `POST /api/reports` is a multipart form.
  - Fields: `plantCode`, `category`, `description` (10–2000 characters), `observedAt` (`YYYY-MM-DDTHH:MM`, local time, not in the future, at most 90 days ago), `phone` (Pakistani number), `consent=true` (required), optional `rating` (1–5, stored as a separate `ratings` row), `photos` (0–3 files, JPEG/PNG/WebP, ≤ 5 MB each), optional `shareProximity=true` with `proximityLat`/`proximityLng` (the server stores only the distance to the plant), optional `verificationToken`, `lang`, and the honeypot `website`, which must be empty.
  - Returns 201 with `{ reference: "TW-XXXX-XXXX", status: "pending", phoneVerified: false, ratingRecorded: true, statusUrl: "/status.html?ref=TW-XXXX-XXXX" }`.
  - Failures are 400 or 422 with a field in `details`. A cooldown returns 429 with `retryAfterSec`.
- `POST /api/ratings` takes JSON `{ plantCode, stars, phone, consent: true, verificationToken? }` and returns `{ status: "accepted|pending" }`. There's one rating per phone per plant; a newer rating replaces the older one.
- `POST /api/verify/start` takes `{ phone }` and returns `{ enabled, sent, expiresInSec }`. If `SMS_PROVIDER=console` and the server isn't in production, the response also includes `devCode`.
- `POST /api/verify/confirm` takes `{ phone, code }` and returns `{ verified: true, token }`.
- `GET /api/reports/status?reference=&last4=` returns `{ reference, plant: { code, name, town, areaRaw }, category, status, createdAt, updatedAt, timeline: [ { status, at, publicNote } ], canReply, canAppeal }`. It's rate-limited. Both the reference and the last 4 digits of the phone are required.
- `POST /api/reports/reply` takes `{ reference, last4, message }` and answers a clarification request.
- `POST /api/appeals` takes `{ kind: 'correction|appeal|deletion_request', reference?, plantCode?, phone, message }` and returns `{ reference: "AP-XXXX-XXXX" }`.
- `GET /api/photos/:id` serves a photo only when it has been approved **and** marked public. EXIF and GPS metadata are always stripped at upload.

Public report status labels are `pending`, `under_review`, `needs_clarification`, `confirmed`, `resolved`, and `rejected`.

## 7. Admin API (`/api/admin/*`, session cookie + CSRF)

**Auth (Lead):** `POST /login`, `POST /logout`, `GET /me` returns `{ user: { id, username, role, displayName }, csrfToken, permissions: [...] }`.

**Plants & areas (Core API):**
- `GET /plants?q=&town=&coord=missing|exact|area|pending&status=&needsReview=1&demo=0|1&page=&pageSize=` returns `{ items, total, page, pageSize }`.
- `GET /plants/:code` returns the full admin view: all columns, `sourceValues`, traceability, `statusHistory`, `waterTests`, `sources`, the last 50 `audit` entries, and report counts.
- `POST /plants` creates a plant.
- `PATCH /plants/:code` takes `{ ...fields, reason }`. The reason is required and the change is audited with a diff.
- `POST /plants/:code/coordinates` takes `{ lat, lng, note }` and sets `coord_status='verified'` and `coord_source='admin map pin'`. Sending `{ clear: true, reason }` removes the coordinates.
- `POST /plants/:code/status` takes `{ status, assessment, evidenceReportIds?, investigationId?, verified?: bool }`. `assessment` is required, at least 20 characters. The call writes `plant_status_history`.
- `POST /plants/:code/verify` takes `{ verifiedAt: 'YYYY-MM-DD', note }`.
- `POST /plants/:code/tests` is multipart: `sampleDate`, `laboratory`, `sourceDescription`, `standardName`, `standardVersion`, `standardSource`, `outcome`, `notes`, `results` (a JSON string of `[{ parameter, valueText, valueNum?, unit?, limitText?, withinLimit? }]`), and optionally `report` (PDF/JPEG/PNG). `met_limits` or `issue_detected` requires `standardName`. `met_limits` also requires every result to have `withinLimit === true`.
- `DELETE /tests/:id` takes `{ reason }`.
- `POST /plants/:code/sources` takes `{ title, url?, note? }`.
- `GET /areas` lists areas. `PATCH /areas/:id` takes `{ latitude, longitude, radiusM, nameUr, aliases, reason }` and sets `geocode_status='manual'` and `reviewed_at`.
- `GET /incomplete` returns `{ counts: { noExactLocation, noLocationAtAll, noName, noHours, noTests, needsReview }, items… }`.

**System (Core API):**
- `GET /stats`
- `GET /audit?entityType=&entityId=&actor=&action=&page=`
- `GET /users`, `POST /users`, `PATCH /users/:id` (`users:manage`)
- `GET /export/plants.csv`, `GET /export/plants.json`
- `POST /maintenance/retention`

**Imports & duplicates (Import):**
- `POST /imports` (multipart `file`) returns `{ batchId, filename, sheets: [{ name, rowCount, headers }], suggestedMapping: { sheet, columns: { <targetField>: <header>|null } }, targetFields: [{ key, label, required, description }] }`.
- `POST /imports/:id/preview` takes `{ sheet, mapping, options: { updateExisting: true } }` and returns `{ summary: { total, new, update, unchanged, rejected, incomplete, duplicateReview }, rows: [...] }`.
- `GET /imports/:id/rows?outcome=&page=`
- `GET /imports/:id/errors.csv`
- `POST /imports/:id/commit`
- `POST /imports/:id/cancel`
- `GET /imports`
- `GET /duplicates?status=open`
- `POST /duplicates/:id/resolve` takes `{ action: 'merge|keep_separate|dismiss', note }`.

**Reports & moderation (Reports):**
- `GET /reports?status=&queue=1&plantCode=&severity=&page=` returns `{ items: [{ id, reference, plant, category, severity, status, riskScore, riskLevel: 'low|medium|high', reviewQueue, phoneVerified, photoCount, createdAt }], total }`.
- `GET /reports/:id` returns everything, including `riskReasons: [{ code, detail, weight }]` and `reporter: { id, alias, phoneMasked, verified, confirmedReports, rejectedReports, status, reports30d }`, plus `photos`, `events`, `proximityDistanceM`, `similarReports`.
- `POST /reports/:id/decision` takes `{ action: 'start_review|request_clarification|confirm|resolve|reject', reason, publicNote? }`. `reason` is required.
- `POST /reports/:id/reveal-contact` takes `{ reason }` and returns `{ phone }`. Admin only, audited.
- `GET /photos/:id` and `POST /photos/:id/moderate`, which takes `{ action: 'approve|reject', public: bool, note }`.
- `GET /reporters/:id` and `POST /reporters/:id/status`, which takes `{ status: 'active|restricted|blocked', reason }`.
- `GET /ratings?status=pending` and `POST /ratings/:id/decision`, which takes `{ action: 'accept|reject', reason }`.
- `GET /appeals?status=` and `POST /appeals/:id/resolve`, which takes `{ status, resolution }`. Completing a `deletion_request` erases the phone number and redacts that reporter's reports.
- `GET /investigations?plantCode=`, `POST /investigations`, `PATCH /investigations/:id`.
- `GET /moderation/stats`
- `GET /export/reports.csv?includeContact=0|1`. `includeContact=1` requires `export:contacts` and a `reason`, and is audited.

## 8. Frontend conventions

- **Pages:**
  - `/` is the homepage plus search, results, map and card. State lives in the URL: `?lat=&lng=&sort=&mode=&plant=&lang=`.
  - `/report.html?plant=CODE` is the report form. `/status.html?ref=` shows report status, the clarification reply, and appeals.
  - `/about.html` covers data sources, map attribution, coverage limits, and spreadsheet caveats. `/privacy.html` covers retention and deletion requests.
  - `/admin/` is the dashboard.
- **i18n:** use `initI18n(['search'])` from `/js/i18n.js`. Strings live in `/i18n/<namespace>.<lang>.json` as flat maps.
  - Urdu text is RTL. Use CSS logical properties (`margin-inline-start`, `inset-inline-end`) everywhere.
  - Arrows flip in RTL: "next" points left in Urdu.
  - Numbers use Western digits.
  - Every user-visible string must have both an `en` and a `ur` entry. Roman Urdu is a *search* alias only.
- **Theme:** use `/css/tokens.css`. The look should be:
  - a light cream or foam background with sand and teal accents
  - cobalt primary buttons with a slight offset shadow, the "Côte Bleu" pill style
  - DM Serif Display headlines, with Gochi Hand for a single handwritten accent line
  - a wavy cobalt ribbon, and a top-down shoreline motif (sand, foam, water) as decoration
- **Motion:** use Motion or anime.js only for small UI transitions (card change, wave shimmer, diagram water flow). Lazy-load them. Respect `prefers-reduced-motion` with no animation and a static fallback. Keep total JS for the first view under 150 KB gzip, excluding the map library.
- **Accessibility:**
  - touch targets of at least 48 px
  - a visible focus ring (the token already provides it)
  - `aria-live="polite"` for result and card changes
  - labels on all inputs
  - Arrow keys (Left/Right, mirrored in RTL) change plants while the card region has focus.
- **Map:** in the Public UI, `public/js/map/adapter.js` exposes `createMap(el, config)` with Leaflet and Google implementations. The Admin UI uses Leaflet directly.
- **Failure states:** show a text list when the map fails to load, and provide copy for each of these: no nearby plants, location permission denied, ambiguous address, missing coordinates, routing unavailable, photo upload failed, and verification failed.
