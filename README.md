# Team Water — Faisalabad Water Finder

Team Water is a mobile-friendly site for people in and around Faisalabad. It helps them:

- find nearby water filtration plants
- compare the alternatives
- get directions
- report problems

The user flow is: **choose a location → find a plant → understand its details → get directions.**

- **Public site:** homepage search (area names in English, Urdu or Roman Urdu), the "Use my location" button, and picking a point on the map.
  - Results show a map and a plant card with **→ / ←** arrows ("Plant 2 of 8").
  - Each card has a small illustrative 3D treatment diagram, water-testing evidence kept separate from community ratings, directions, and a problem-report form with a status tracker.
  - Available in English and Urdu (right-to-left).
- **Admin dashboard (`/admin/`):**
  - spreadsheet import (column mapping, preview, validation, duplicates, errors CSV)
  - plant editing and map pins
  - status changes backed by a documented assessment
  - water-test uploads
  - report moderation, with risk reasons, photo review, appeals and investigations
  - users, audit log, and exports

## Quick start

Needs Node.js 22.13 or later. There's no native build step: the database is Node's built-in SQLite.

```bash
npm install
cp .env.example .env        # optional for local dev; REQUIRED values are marked for production
npm run setup               # creates DB, loads area gazetteer, imports data/source/*.xlsx, creates admin (prints password)
npm start                   # http://localhost:3000   admin: http://localhost:3000/admin/
```

Useful variants:

```bash
DEMO_DATA=1 npm start                      # adds clearly-labelled DEMO plants with exact pins (never real)
SMS_PROVIDER=console npm start             # dev only: verification codes printed to the server log
npm run import:xlsx -- path/to/file.xlsx --dry-run --errors errors.csv
npm run admin:create -- <username> <admin|editor|moderator> [password]
npm test                                   # unit/API tests (node:test)
npm run test:e2e                           # browser tests (Playwright + Chromium)
```

## What the supplied data supports

`data/source/Filter_palnts_in_Faisalabad_1000_1.xlsx` contains 1,000 plants in 8 columns: ID, town, area, operator type, water source, technology, capacity, and status. It has **no coordinates, names, addresses, hours, contacts or test results.** So:

- **No plant has an exact location yet.** Nearest-plant results are **area-level approximations**. The distance is measured to the centre of the listed area, and the site says so clearly. The map draws these areas as circles, never as pins. There are no plant-level directions until an admin pins the plant (Admin → Plants → Coordinates) or a future spreadsheet supplies latitude and longitude.
- **Area positions.** 17 of the 49 gazetteer entries have a sourced position (Who's On First, GeoNames, Wikidata). With those, 347 plants can be ranked by area. The other 653 plants sit in areas that are generic ("Saline Zone-C", "Kachi Abadi"), ambiguous, or not yet located. They're reachable through the town/area list. Admins can set area centres in Admin → Areas.
- **Data problems are kept as recorded and flagged, not silently corrected.** Examples:
  - "Chalk 224 RB"
  - operator types that describe plant types
  - the gallon type isn't stated, so capacities aren't converted to litres
  - the status is undated
  - capacities are implausibly high

  See [`docs/DATA_AUDIT.md`](docs/DATA_AUDIT.md).
- **Missing facts** show as "Not provided", "Not verified" or "Unknown". Nothing is invented.

## Layers & providers

| Layer | Default | Production option |
|---|---|---|
| Base map (streets, shops, landmarks) | OpenStreetMap tiles via Leaflet | A commercial or self-hosted tile service, or **Google Maps** (`MAP_PROVIDER=google` plus a key and billing) |
| Location search | Local area gazetteer (English/Urdu/Roman Urdu) plus Nominatim on explicit submit | Google Geocoding (only with a Google map) |
| Routing / travel time | OSRM (the demo server is car-only and not for production) | A self-hosted OSRM, or Google Routes |
| Plant database | The imported spreadsheet plus admin verification | — |

Map data is never scraped or bulk-copied. Mapcarta turned out to be built on OpenStreetMap and Wikidata, so the app uses those sources directly, with attribution. Details, licences, and coverage limits are in [`docs/MAP_SOURCES.md`](docs/MAP_SOURCES.md).

## Production dependencies that still need credentials or configuration

| What | Env vars | Without it |
|---|---|---|
| Secrets (required) | `PHONE_ENC_KEY`, `HMAC_KEY` (64 hex characters each) | The server refuses to start in production |
| Tile provider for real traffic | `MAP_TILE_URL`, `MAP_ATTRIBUTION`, or Google keys | OSM's public tiles, which are for light use only |
| Nominatim contact | `GEOCODER_USER_AGENT`, `GEOCODER_EMAIL` | The policy requires an identifying user agent |
| Routing server | `OSRM_URL` (plus `OSRM_FOOT_URL` / `OSRM_BIKE_URL`) or Google | Straight-line distance, labelled as such |
| SMS verification | `SMS_PROVIDER=twilio`, `TWILIO_*` | Reports are accepted but marked unverified |
| Reverse proxy | `TRUST_PROXY=1`, `NODE_ENV=production`, HTTPS | Rate limits see the proxy's IP |
| Review threshold (keep private) | `RISK_REVIEW_THRESHOLD` (default 40) | Default is used |

These carry costs of their own (hosting, tiles, Google Maps, SMS, backups), separate from the visual budget. See [`docs/VISUAL_BUDGET.md`](docs/VISUAL_BUDGET.md).

**Visual generation budget:** Higgsfield spent **0.15 of the 10-credit budget** on one image. The image couldn't be downloaded because the build sandbox blocks Higgsfield's image host (egress policy). All artwork shipped is therefore hand-made SVG in the style of the reference images. The log is in `docs/VISUAL_BUDGET.md`.

## Privacy, safety & moderation (summary)

- **Phone numbers** are encrypted at rest (AES-256-GCM). Only the `admin` role can reveal one, a reason is required, and every reveal is audited. Numbers never appear in public APIs or the audit log.
- **Search location** isn't stored. **Photos** are optional, have EXIF/GPS metadata stripped, and aren't public until a moderator approves them and marks them public.
- **Reports and ratings** are separate records, and reports are unverified until reviewed. Changing a plant's official status requires an administrator's written assessment.
- **Abuse checks** combine several signals: rate limits, duplicate text and images, bursts, repeated targeting, reporter history, and optional proximity. These produce a private risk score that routes a report to human review. Nothing is deleted or rejected automatically. New reporters, reporters without photos, and remote reporters aren't penalised.
- **Retention:** report text and photos are redacted after 2 years, and phone numbers are erased 180 days after last activity. People can request deletion from `/status.html#appeal`.

## Project layout

```
server/            Express 5 app, routes, domain libs (node:sqlite)
  db/schema.sql    database schema (single source of truth)
  import/          spreadsheet import pipeline
public/            static site (ES modules, no bundler); public/admin/ = dashboard
data/source/       supplied spreadsheet    data/gazetteer/  sourced area positions
docs/              ARCHITECTURE (contract), DATA_AUDIT, MAP_SOURCES, VISUAL_BUDGET
test/              node:test suites; test/e2e/ Playwright suites + runner
```
