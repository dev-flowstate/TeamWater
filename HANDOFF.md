# HANDOFF — read this first (for the next Claude Code session)

This file gets you up to speed quickly. Read it, then `docs/ARCHITECTURE.md`, which is the contract and the rules.

## What this project is

**Team Water — Faisalabad Water Finder.** It's a mobile-friendly website that helps people in and around Faisalabad, Pakistan:

- **find** nearby water filtration plants
- **compare** them
- **get directions**
- **report problems**

The flow is: choose a location, find a plant, understand its details, get directions. Search works in English, Urdu (right-to-left) and Roman Urdu.

It has three parts:

- **Public site:**
  - `/` is search, the map, and a plant card with ← / → arrows ("Plant 2 of 8"). The card shows a small 3D treatment diagram, water-test evidence (kept separate from ratings), and directions.
  - `/report.html` is the problem report form: optional photos, phone, consent, SMS verification, and a separate rating.
  - `/status.html` shows report status and handles appeals and deletion requests.
  - `/about.html` and `/privacy.html`.
- **Admin dashboard (`/admin/`):**
  - spreadsheet import wizard
  - plant editing and map pins
  - status changes (a written assessment is required)
  - water-test upload
  - moderation queue (risk reasons, photo review, decisions)
  - ratings, appeals, investigations, users, audit log, exports
- **Owner's rules (non-negotiable):**
  - Never invent plants, coordinates, tests, ratings or badges. Show "Not provided", "Not verified" or "Unknown".
  - Capacity is never shown as a per-person allowance.
  - Water tests stay separate from ratings.
  - Reports aren't findings.
  - Phone numbers stay private.
  - Demo data is always labelled.

  All of this is in `docs/ARCHITECTURE.md` §0.

## Where things are

- **Repo:** `dev-flowstate/TeamWater`, branch `claude/compassionate-albattani-bgi6iq`. It's the only branch.
- **Live demo:** https://team-water.vercel.app/ (Vercel Hobby).
  - **Vercel env vars** (set in the Vercel project): `PHONE_ENC_KEY`, `HMAC_KEY`, `ADMIN_PASSWORD`. The admin username is `admin`.
  - **Vercel limitation:** the disk is temporary. `api/index.js` rebuilds the SQLite DB in `/tmp` from the bundled spreadsheet on every cold start, so reports and admin edits don't persist. For durable data, deploy to a host with a disk (see `render.yaml` and the README).
- **Stack:** Node ≥ 22.13, Express 5, and SQLite via built-in `node:sqlite`. No bundler; the public folder is plain ES modules.
  - **Run it:** `npm install && npm run setup && npm start`
  - **Tests:** `npm test` (95 unit/API tests) and `npm run test:e2e` (4 Playwright suites). Everything passed at handoff.
- **Docs:**
  - `README.md`: setup, providers, production env vars
  - `docs/ARCHITECTURE.md`: the contract (API shapes, schema meaning, rules)
  - `docs/DATA_AUDIT.md`: issues in the original spreadsheet
  - `docs/MAP_SOURCES.md`: map, geocoding and licensing
  - `docs/VISUAL_BUDGET.md`: Higgsfield spend (0.15 of 10 credits) plus other costs
  - `docs/env-example.txt`: all settings
- **Code map:**
  - `server/app.js`: the app, CSP, route mounting
  - `server/db/schema.sql`, plus migrations in `server/lib/db.js`
  - `server/import/`: the spreadsheet pipeline
  - `server/lib/ranking.js`: nearest/recommended ranking
  - `server/lib/plant-view.js`: API shapes
  - `server/lib/risk.js`: abuse scoring
  - `server/routes/*.js`
  - `public/js/*` (the site), `public/admin/*` (the dashboard)
  - `data/gazetteer/faisalabad.json`: sourced area positions
  - `scripts/setup.js`

## Current data state

- **Original file:** `data/source/Filter_palnts_in_Faisalabad_1000_1.xlsx` has 1,000 plants with **no coordinates, names or addresses.** They can only be placed at area level: 347 plants sit in areas with a known centre, and 653 can only be browsed by town or area.
- **The owner supplied better data**, saved in `data/source/incoming/`:
  1. `Faisalabad_Water_Plants_100Plus_Expanded.xlsx`. Sheet "All Locations" has 139 records and 122 have coordinates.
     - Columns: `Plant ID, Plant / Project Name, Ownership, Tehsil / Area, Address / Location, Contact, Latitude, Longitude, Plant Type (e.g. "RO (2000 LPH)"), Verification, Source URL, Notes`.
     - The source is the Punjab Saaf Pani rehabilitation list. Its own note says: *"Status is from rehabilitation list; re-check after rehabilitation before enabling on public nearest-plant map."* Respect that: import the coordinates as `coord_status='source'` and the status as `unknown` or temporarily closed, never as verified operational. Put the Notes and Verification text into `status_note` / `verification_note`.
     - "RO (2000 LPH)" means technology RO with a capacity of 2000 **litres per hour**. Parse it into `technology_raw` plus capacity; the importer supports mapping.
  2. **DONE:** `UMAR_AFZAL_RO_SHEET.xlsx`. Sheet1 has 221 rows with columns `SR#, LOCATIONS, GOOGLE LOCATION`.
     - `scripts/convert-umar.js` turns it into `UMAR_AFZAL_RO_SHEET.converted.csv`, which setup imports through `imports.json`. **Re-run the converter and commit the CSV whenever the .xlsx changes**; a test fails if they drift apart.
     - IDs are `UMAR-<8 hex of the LOCATIONS text>`, with `-2`, `-3` for repeats (e.g. "CENTRAL JAIL JARHANWALA ROAD" appears 6 times with the same link). `SR#` is a `SUBTOTAL()` formula that renumbers when the sheet is filtered or sorted, so it is not used. Editing a LOCATIONS text changes that plant's ID.
     - Coordinates come only from a place pin `!3d…!4d…` (145 rows) or a dropped pin `?q=lat,lng` (2). Three Chiniot links only give a map view centre `@lat,lng`; those are not used. 71 rows have no link or an address-only link (some are plus codes such as `C356+F4P`); an admin can pin them.
     - Result: 142 exact locations. 5 are rejected as outside the bounds (row 3 points to India; four "SHMALI … DISTRICT SARGODHA"). The two "OKARA ARMY CANT" rows sit just inside the importer's 0.1° margin and are stored; ask the owner if they belong.
     - Many place pins are a village or landmark pin, not the plant itself. They stay `coord_status='source'` (unverified).
     - Imported as RO (the file is titled "RO SHEET") with status `unknown`. 17 likely duplicates (same pin, similar name) are in the duplicate-review queue.
  3. **DONE:** `/water-estimates.html` (linked in the nav as "Area water estimates") shows all 34 areas from this PDF, with its warnings. The data is also in `data/source/incoming/estimated-tds-ph-by-area.json`. It is NOT attached to plants as test results. Still to do: Urdu text for that page, and optionally an "area estimate" line on plant cards, clearly labelled as groundwater context.
     `faisalabad_estimated_tds_ph_by_area.pdf` is the newer version and adds **estimated pH** by area. The older `faisalabad_estimated_tds_by_area.pdf` is kept too. The same rules apply to both: these are estimates, not lab tests.
     Older file: `faisalabad_estimated_tds_by_area.pdf` holds **estimated** TDS by area. It is **not** a lab test. Don't put it into `water_tests` as measured results, and never show it as "met limits". At most, show it as area context: "Estimated TDS for this area (not a measurement of this plant)", with its source cited. That would need a new small table or `about.html` content; decide carefully.
- **Possible overlap:** plants in the new files may duplicate the 1,000-row file. Its IDs look modelled, not surveyed, so it has no matching IDs. Use the duplicate-review queue; don't auto-merge.

## Owner decisions (26 Sept 2026)
- The owner confirmed that **all plants in `Faisalabad_Water_Plants_100Plus_Expanded.xlsx` are operating and their data is verified**. This is recorded through `ownerConfirmation` in `data/source/incoming/imports.json` and applied by `scripts/setup.js`: status is operational (`admin_verified`), last verified 2026-09-26, and the coordinates are verified. An audit entry records it.
- "RO (2000 LPH)" now maps to the RO stage and a capacity of 2000 litres per hour.

## Next steps, in priority order

1. **DONE.** Both new files are imported by `scripts/setup.js` through `data/source/incoming/imports.json`: 122 exact plants from the 139-plant file and 142 from UMAR. "RO (2000 LPH)" parses to 2000 litres per hour with the RO stage. Setup's owner confirmation only touches plants whose status still comes from the file, so an admin's status change survives restarts.
2. **DONE (owner decision, 27 Sept 2026):** the original 1,000-row file is hidden from the public site (`PUBLIC_HIDDEN_SOURCE_FILES`, see `docs/env-example.txt`); admins still see it. Set the variable to empty to show it again.
   **Also DONE:** `scripts/enrich-locations.js` found positions and landmarks for the public plants and wrote `data/source/incoming/enrichment.json`, which setup applies (no network at start-up). Plus codes in the records are decoded exactly; other positions come from OpenStreetMap search, are flagged `coord_approximate=1` and shown as grey dashed pins labelled "approximate". Search hits must name the place (Nominatim fuzzy-matches "Chak 224 RB" to "Chak 234 GB"). Landmarks come from "Near X" in the record or the nearest named OpenStreetMap place within 250 m. Re-run the script after importing new files, check its output, and commit the JSON.
3. Translate `public/i18n/about.ur.json`, which has only 5 of 96 keys, so the About and Privacy pages are fully Urdu.
4. Compact the result controls on mobile (see the note in the Public UI report).
5. Durable hosting for reports: Render or Railway with a disk. Set `SMS_PROVIDER=twilio` for verification.
6. Optional: a security review with `/security-review`; the Google Maps provider (`MAP_PROVIDER=google` with keys).

## Hackathon demo features (27 Sept 2026, owner request)
- **Demo water-quality dot:** every plant card shows a green/yellow/red dot with a made-up TDS value (`demoWaterQuality` in `server/lib/plant-view.js`), labelled "Demo value made up for the hackathon — not a real water test". On by default; **turn it off after the hackathon** with `DEMO_WATER_QUALITY=0` (Vercel env var). The owner asked for real plants to carry these values; the alternative offered was area-groundwater colours from the TDS PDF, which were not chosen because RO plants treat that water.
- **Hand-picked searches** for named institutions live in `data/source/incoming/enrichment-queries.json`; each hit must contain every distinctive word and number of its query.

## Gotchas

- Don't run `pkill -f` with broad patterns; it can kill your own shell.
- The sandbox may block OSM, Nominatim, OSRM and vercel.app. The app degrades gracefully, and tests use `GEOCODER_PROVIDER=none` and `ROUTING_PROVIDER=none`.
- Commit messages must not name the model. Push to the branch above.
- Setup must stay fast: it runs inside every Vercel cold start, and the page gives up on `/api/config` after 12 s. It used to geocode addresses via Nominatim (1 request/s), which took about 27 s and showed "We couldn't load the plant list". Setup now passes `geocoder: null`; don't add network calls to it.
- On Windows, `core.autocrlf=true` used to corrupt the PDFs on checkout; `.gitattributes` now marks PDFs and spreadsheets as binary.
- E2E on Windows: set `CHROME_PATH` to a local Chrome. The runner's cleanup can hit EPERM after the suites finish; check the ✔ lines.
