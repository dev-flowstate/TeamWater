# Map & geodata sources

**Recorded:** 2026-09-25 by the Geo workstream. Policies and terms change. Re-check the linked pages before a public launch, and whenever you switch providers.

This document covers:

- what the app shows on its maps and where it comes from
- which licences and usage policies apply
- how the area gazetteer (`data/gazetteer/faisalabad.json`) was built
- what could not be verified from the build environment

Plants are always our own overlay from the database. **No map data is scraped or bulk-copied from any provider.**

---

## 1. Map providers and exact attribution strings

| Setting | Base map | Attribution that must stay visible on the map |
|---|---|---|
| `MAP_PROVIDER=osm` (default) | Leaflet + `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | `© OpenStreetMap contributors`, linked to `https://www.openstreetmap.org/copyright`. The exact HTML from `server/config.js` is `&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> contributors`. |
| `MAP_PROVIDER=osm` + another tile host (`MAP_TILE_URL`) | Tiles from that host | `MAP_ATTRIBUTION` must combine the OSM credit above **and** the tile host's own required credit. See its terms. |
| `MAP_PROVIDER=google` | Google Maps JavaScript API | Google's logo and data credits, which the API renders itself. They must not be hidden, cropped, overlaid or restyled. |

The About page should also carry the data credits for the area gazetteer:

> Area positions: Who's On First (https://whosonfirst.org/docs/licenses/), including data from GeoNames (CC BY, https://www.geonames.org/) and Wikidata (CC0). Tehsil checks: geoBoundaries (ODbL). Map data © OpenStreetMap contributors, available under the Open Database License (https://www.openstreetmap.org/copyright).

The OSM tile policy recommends adding a "Report a map issue" link to `https://www.openstreetmap.org/fixthemap`.

## 2. Licences

### OpenStreetMap data: ODbL 1.0

The following is quoted from the OSM copyright page. The text was read on 2026-09-25 from the site's source, `openstreetmap/openstreetmap-website`, file `config/locales/en.yml`:

> OpenStreetMap is open data, licensed under the Open Data Commons Open Database License (ODbL) by the OpenStreetMap Foundation (OSMF). … You are free to copy, distribute, transmit and adapt our data, as long as you credit OpenStreetMap and its contributors. If you alter or build upon our data, you may distribute the result only under the same license.
>
> Where you use OpenStreetMap data, you are required to do the following two things: Provide credit to OpenStreetMap by displaying our attribution notice. Make clear that the data is available under the Open Database License.
>
> Although OpenStreetMap is open data, we cannot provide a free-of-charge map API or map tiles for third-parties.

Linking the attribution to `https://www.openstreetmap.org/copyright` satisfies the "make clear it is ODbL" requirement. For the full rules, see the [OSMF Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines).

**Share-alike note:** if we ever store OSM-derived positions, such as Nominatim results saved as area centroids, the resulting database is subject to ODbL share-alike. Record the source in `geocode_source` and `geocode_ref`, as the gazetteer does.

### OSM tile usage policy (`tile.openstreetmap.org`)

Source: <https://operations.osmfoundation.org/policies/tiles/>. The text was read on 2026-09-25 from the site's source repository, `openstreetmap/owg-website`, file `policies/tiles.md`.

**Must:**

- Use exactly `https://tile.openstreetmap.org/{z}/{x}/{y}.png`.
- Show visible licence attribution.
- Send a valid identifying User-Agent, and from web pages a valid HTTP Referer. Do not set a Referrer-Policy that suppresses it.
- Honour the caching headers, or cache for at least 7 days.

**Must not:**

- Bulk-download or prefetch tiles, or offer "offline" or "save area" features.
- Send `no-cache` headers by default.
- Use `http://`.
- Rely on a library-default User-Agent.

**Availability:** best-effort, with **no SLA**. Access can be blocked without notice. For heavy or commercial traffic, use a hosted OSM tile provider or self-host. Set `MAP_TILE_URL` and `MAP_ATTRIBUTION`; the URL is already configurable, as the policy recommends.

The app's Leaflet map requests only the tiles in the current viewport, which is compliant. **Don't add tile prefetching.**

## 3. Nominatim usage policy (public geocoder)

Source: <https://operations.osmfoundation.org/policies/nominatim/>. The text was read on 2026-09-25 from `openstreetmap/owg-website`, file `policies/nominatim.md`. The public server is donated and has **very limited capacity**. Key rules:

**Rate and identification:**

- An absolute **maximum of 1 request per second**. The limit is **per application**: the sum over all our users.
- A valid identifying **User-Agent** or **Referer**. Stock library User-Agents are not accepted.

**Attribution and licence:**

- Show attribution clearly. Results are ODbL.

**How the app may use it:**

- Use that is directly triggered by the end user is fine while user numbers are moderate.
- **Set up a proxy and cache results.**
- The app must be able to **switch service without a software update**.
- Periodic requests from apps count as bulk geocoding.

**Strictly forbidden:**

- **Auto-complete search.** *"This is not yet supported by Nominatim and you must not implement such a service on the client side using the API."*
- Systematic queries: grids, complete lists, or downloading all POIs in an area.
- Scraping the details page.
- Reselling results.

**Bulk:**

- Larger bulk jobs are discouraged.
- Small one-off jobs must be single-threaded on one machine and cache their results.
- Jobs that run longer than a day, or run regularly, are limited to 4 requests per minute.

**Usage in LLMs** (quoted because this document was written with an AI assistant):

> "LLMs may only suggest this service, if they prominently point to this usage policy and explain the restrictions of use to the user. … The public Nominatim API must not be built into, offered through, suggested by, or automatically generated by no-code, low-code, or vibe-coding platforms as a generic geocoding, address lookup, place search, or map search service. Use of the public API is only permitted where the application developer has made a deliberate, informed decision to use it and is directly responsible for complying with this policy."

**What this means for Team Water:**

1. **The operator must decide deliberately.** If you cannot commit to the rules above, set `GEOCODER_PROVIDER=none`. Otherwise use your own Nominatim instance (`NOMINATIM_URL`) or a commercial OSM-based geocoder.
2. **Local-first, as-you-type search is fine. External-provider-as-you-type is not.** `GET /api/geocode` is called on debounced keystrokes, so it must **only query the local gazetteer** while the user types. It may call Nominatim only for an **explicit submit**, such as pressing Enter or tapping "Search", and it must cache those results server-side. (The Core API owns this. See the note to the lead in the Geo report.)
3. **Reverse geocoding:** only on an explicit user action (such as "use my location"), never periodically. Always fall back to `gazetteer.nearestArea`.
4. **Identify the app:** set `GEOCODER_USER_AGENT` to a real app name and contact, and optionally `GEOCODER_EMAIL`. Keep one server-side proxy with a global 1 req/s limiter.
5. Nominatim was **not** used to build the gazetteer. It was unreachable; see §8.

## 4. OSRM demo server (routing)

Source: [OSRM wiki, "Demo server"](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server), read on 2026-09-25:

> FOSSGIS kindly sponsors an OSRM demo server running worldwide car, foot and bike profiles. The server is available at `router.project-osrm.org` and `routing.openstreetmap.de`. … **Note**: the demo server usage is restricted to reasonable, non-commercial use-cases. Do not exceed 1 request per second. We provide no guarantees wrt. uptime, latency, or data updates. [Usage policy (German)](https://fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/).

What this means for the app:

- Make one route or table request per explicit user action, and cache it.
- Show `routingAvailable:false`, with a straight-line fallback, whenever the service fails.
- Any commercial deployment needs its own OSRM instance or a commercial router.

The wiki says foot and bike profiles exist, but `server/config.js` treats `router.project-osrm.org` as **car only** and expects separate `OSRM_FOOT_URL` and `OSRM_BIKE_URL`. The per-profile endpoint layout is described at <https://routing.openstreetmap.de/about.html>, which **could not be fetched** from this environment. Verify it before enabling walking or cycling.

## 5. Google Maps Platform (optional: `MAP_PROVIDER=google`, `GEOCODER_PROVIDER=google`, `ROUTING_PROVIDER=google`)

Google's pages (developers.google.com, mapsplatform.google.com) were **blocked** from the build environment. The points below come from Google's policy pages as surfaced by web search on 2026-09-25. Verify them against the live pages before enabling Google:

- [Geocoding API policies](https://developers.google.com/maps/documentation/geocoding/policies)
- [Maps JavaScript API policies](https://developers.google.com/maps/documentation/javascript/policies)
- [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies)
- [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms)

**Keys and billing:**

- Requires a Google Cloud project with a **billing account** and API keys.
- `GOOGLE_MAPS_BROWSER_KEY` goes to browsers and must be **HTTP-referrer restricted**.
- `GOOGLE_MAPS_SERVER_KEY` stays on the server and must be **IP-restricted**.

**No scraping or copying.** Google Maps content (tiles, geocodes, place data, routes) must not be scraped, bulk-downloaded or copied into our database. Using Google as a runtime provider is allowed. Harvesting it is not.

**Attribution.** Keep Google's attribution and logo visible and unaltered. Where space is limited, the text "Google Maps" is acceptable. Applications must publish Terms of Use and a Privacy Policy that reference Google's terms.

**Caching is restricted.**

- Only **place IDs** may be stored indefinitely.
- Other content (including coordinates from geocoding) must not be pre-fetched, cached or stored, except as the Service Specific Terms explicitly allow.
- Consequences for Team Water:
  - Never write Google geocoding results into `areas`.
  - Never write Google geocoding results into `plants.latitude/longitude`, including `geocoded_pending` candidates, unless the current terms allow it.
  - Store the place ID and re-query instead, or use an OSM-based source for anything that is stored.

**Display on a Google map.** If Google geocoding or Places results are displayed on a map, it must be a Google map. So `GEOCODER_PROVIDER=google` must be paired with `MAP_PROVIDER=google`. Never draw Google geocodes on OSM tiles.

**Pricing** is pay-as-you-go, **charged per request for each API SKU**, with a **monthly free usage allowance per SKU**. Beyond it, requests are billed at per-SKU rates, which differ between Maps loads, Geocoding, Places and Routes. Set budget alerts and quotas. Current prices are here; no figures are quoted because they could not be verified:

- <https://developers.google.com/maps/billing-and-pricing/pricing>
- <https://mapsplatform.google.com/pricing/>

## 6. Mapcarta (reference site supplied by the user)

**Direct access was impossible.** `mapcarta.com` is blocked for both the sandbox's `curl` and the WebFetch tool (egress policy), so `robots.txt`, the terms page and `https://mapcarta.com/Faisalabad/Map` **could not be read**. The findings below come from web-search results on 2026-09-25, and each is marked with how certain it is.

- **Built on open data** (consistent across sources). Mapcarta calls itself "an open map that unites the world through the collective knowledge of OpenStreetMap, Wikipedia, Wikidata, and other open projects". According to its About page as indexed by search, it credits:
  - OpenStreetMap, Wikidata, GeoNames and **Who's On First**
  - Wikimedia Commons, Wikipedia and Wikivoyage
  - OpenAddresses, Pelias, Valhalla and OpenRouteService
  - OpenMapTiles and MapLibre

  This **confirms the belief that it is built on OSM plus Wikidata**. It also uses GeoNames and Who's On First, the same upstream sources this gazetteer uses directly.
- **Licence** (search summary, unverified): content under **CC BY-SA 4.0**. Map images may be reused with the credit "Mapcarta and OpenFreeMap © OpenStreetMap and OpenMapTiles".
- **API or export:** none found. A third-party 2026 article states that Mapcarta offers no self-serve developer API. The OSM wiki has a "Mapcarta" page; Wikidata has an item (Q113124866) and a "Mapcarta ID" property (P12966). No bulk download was found.
- **robots.txt:** not verified.

**Verdict:**

- **Permitted:** use Mapcarta as a human reference (looking things up, cross-checking a name) and link to its pages.
- **Not permitted:** using it as a data source. That would mean scraping pages (there's no API), would stack CC BY-SA share-alike on top of ODbL, and would bypass the upstream projects.
- **The permitted route is the upstream data itself:** OSM under ODbL (runtime tiles and Nominatim, per §2–3), and Who's On First, GeoNames and Wikidata for the gazetteer.
- **Nothing was copied from Mapcarta** into this project.

## 7. Area gazetteer (`data/gazetteer/faisalabad.json`)

**Why it exists.** The spreadsheet has **no coordinates**. Plants can only be placed at area level: a circle around an approximate area position, never a pin (ARCHITECTURE §0.4, §5.1). The gazetteer also holds English, Roman Urdu and Urdu search aliases.

**Sources used**, all fetched on 2026-09-25 from GitHub, the only data host reachable from the build environment:

| Source | Used for | Licence |
|---|---|---|
| [Who's On First](https://whosonfirst.org/) (`whosonfirst-data/whosonfirst-data-admin-pk`, records read raw by ID and found via GitHub code search) | Points, polygon bounding boxes and Urdu labels for localities and neighbourhoods; Wikidata and GeoNames concordances | CC0 for WOF's own work. Per-source attribution per the repo's `LICENSE.md` |
| [GeoNames](https://www.geonames.org/), via WOF `gn:` properties | Village (chak) and neighbourhood points | Creative Commons Attribution |
| [Wikidata](https://www.wikidata.org/), via WOF `wd:` properties | City coordinate (Q173985), airport (Q31580) | CC0 |
| [geoBoundaries PAK ADM3](https://github.com/wmgeolab/geoBoundaries/tree/main/releaseData/gbOpen/PAK/ADM3) (2017 tehsils; source Pathways Data Pvt. Ltd. / PBS) | **Verification only**: point-in-polygon check that each point lies in the spreadsheet's tehsil. No geometry is copied | ODbL 1.0 |

**Method:**

- **Coordinates are read programmatically** from the fetched records. None were typed from memory.
- **Point checks.** Each point is checked against the configured bounds `[[30.75,72.6],[31.85,73.65]]` and against the tehsil polygons.
- **Town membership inside the city can't be verified.** The four city "towns" (Lyallpur, Jinnah, Iqbal, Madina) have no open boundary data. For areas inside Faisalabad City tehsil, town membership is therefore unverified; each note says so.
- **Radius.** `radiusM` comes from the source polygon's bounding box (half the mean side) where a polygon exists. Otherwise it's a default by kind (area 1200, chak village 1500, city/town 4000, large landmark 1000), marked "default estimate" in the note.
- **Tehsil entries.** Tehsils (`kind: town`) are represented by their headquarters town's position. The note says the tehsil extends far beyond it.
- **Urdu names.** `nameUrSource: 'wof'` means the Urdu label published in the WOF record. `'transliteration'` means a careful transliteration by this workstream, not an official spelling. OSM `name:ur` and Urdu Wikipedia were unreachable. WOF Urdu spellings that differ from common usage (e.g. "جاران والا") are kept as aliases.
- **Keys.** Areas use `areaKey(name, town)`, towns `town:<slug>`, landmarks `landmark:<slug>`.

**Status meanings:**

- `matched`: a single convincing candidate, inside the right tehsil. Usable for area results.
- `ambiguous`: several candidates, a tehsil mismatch, an inexact name, or a road. **Not usable** publicly until an administrator reviews it (`PATCH /api/admin/areas/:id` sets `manual`). Where a candidate exists, its position is stored for the reviewer, and `gazetteer.search()` never exposes it.
- `not_found`: nothing in the reachable sources. Position is null.
- `not_geocodable`: a generic label, not a place name.

**Summary (49 entries):**

| Kind | matched | ambiguous | not_found | not_geocodable | Total |
|---|---|---|---|---|---|
| area | 11 | 10 | 12 | 6 | 39 |
| town | 5 | 0 | 4 | 0 | 9 |
| landmark | 1 | 0 | 0 | 0 | 1 |
| **all** | 17 | 10 | 16 | 6 | 49 |

**Landmarks not yet geocoded.** Clock Tower (Ghanta Ghar), its 8 bazaars, the railway station, University of Agriculture, Allied Hospital, D Ground, Iqbal Stadium and Chenab Club are listed in `pendingLandmarks`, with names and aliases but **no coordinates**. No citable position could be fetched. They are **not** loaded into the database. Geocode each once, or pin it via the admin UI and record the source, then move it into `entries`.

**Per-entry table:**

| Kind | Name | Town/Tehsil | Status | Position | radiusM | Source refs | Why |
|---|---|---|---|---|---|---|---|
| town | Chak Jhumra | — | matched | 31.56879, 73.18336 | 4000 (est.) | [wof:421196441](https://spelunker.whosonfirst.org/id/421196441), [gn:1175748](https://www.geonames.org/1175748), [Q3321415](https://www.wikidata.org/wiki/Q3321415) | Tehsil HQ town position; tehsil check OK |
| town | Faisalabad | — | matched | 31.41800, 73.07900 | 13200 | [wof:421181503](https://spelunker.whosonfirst.org/id/421181503), [gn:1179400](https://www.geonames.org/1179400), [Q173985](https://www.wikidata.org/wiki/Q173985) | Wikidata point; radius from WOF city polygon bbox |
| town | Iqbal Town | — | not_found | — | — | — | City town polygon; no open boundary reachable |
| town | Jaranwala | — | matched | 31.33238, 73.42319 | 4000 (est.) | [wof:421197393](https://spelunker.whosonfirst.org/id/421197393), [gn:1176106](https://www.geonames.org/1176106), [Q1251242](https://www.wikidata.org/wiki/Q1251242) | Tehsil HQ town position; tehsil check OK |
| town | Jinnah Town | — | not_found | — | — | — | City town polygon; no open boundary reachable |
| town | Lyallpur Town | — | not_found | — | — | — | City town polygon; no open boundary reachable |
| town | Madina Town | — | not_found | — | — | — | City town polygon; no open boundary reachable |
| town | Samundri | — | matched | 31.06123, 72.95858 | 4000 (est.) | [wof:1344256487](https://spelunker.whosonfirst.org/id/1344256487), [gn:1166234](https://www.geonames.org/1166234) | Tehsil HQ town position; tehsil check OK |
| town | Tandlianwala | — | matched | 31.03664, 73.13348 | 4000 (est.) | [wof:421175759](https://spelunker.whosonfirst.org/id/421175759), [gn:1163968](https://www.geonames.org/1163968), [Q3695292](https://www.wikidata.org/wiki/Q3695292) | Tehsil HQ town position; tehsil check OK |
| area | Aminpur Bangla | Lyallpur Town | not_found | — | — | — | Not in reachable open sources |
| area | Canal Road | Madina Town | **ambiguous** | — | — | — | Road (linear); no point assigned |
| area | Chak 185 RB | Chak Jhumra | matched | 31.57725, 73.20748 | 1500 (est.) | [wof:1226242163](https://spelunker.whosonfirst.org/id/1226242163), [gn:1389183](https://www.geonames.org/1389183) | GeoNames point; tehsil check OK |
| area | Chak 190 RB | Chak Jhumra | **ambiguous** | 31.54350, 73.15688 | 1500 (est.) | [wof:1243171635](https://spelunker.whosonfirst.org/id/1243171635), [gn:1389165](https://www.geonames.org/1389165) / [wof:1259706757](https://spelunker.whosonfirst.org/id/1259706757), [gn:1173580](https://www.geonames.org/1173580) | 2 candidates; both in Faisalabad Saddar, not Chak Jhumra |
| area | Chak 236 GB | Jaranwala | matched | 31.38272, 73.48048 | 1500 (est.) | [wof:1226669295](https://spelunker.whosonfirst.org/id/1226669295), [gn:1173304](https://www.geonames.org/1173304) | GeoNames point; tehsil check OK |
| area | Chak 398 GB | Tandlianwala | **ambiguous** | 30.91516, 73.01804 | 1500 (est.) | [wof:1276897559](https://spelunker.whosonfirst.org/id/1276897559), [gn:1184401](https://www.geonames.org/1184401) / [wof:1259606645](https://spelunker.whosonfirst.org/id/1259606645), [gn:11538941](https://www.geonames.org/11538941) | 2 candidates without branch suffix |
| area | Chak 412 GB | Tandlianwala | matched | 30.99051, 73.16247 | 1500 (est.) | [wof:1276123629](https://spelunker.whosonfirst.org/id/1276123629), [gn:11538985](https://www.geonames.org/11538985) | GeoNames point; tehsil check OK |
| area | Chak 467 GB | Samundri | matched | 31.07505, 72.96553 | 1500 (est.) | [wof:1226241977](https://spelunker.whosonfirst.org/id/1226241977), [gn:11483371](https://www.geonames.org/11483371) | GeoNames point; tehsil check OK |
| area | Chak 474 GB | Samundri | matched | 31.04753, 72.85088 | 1500 (est.) | [wof:1242701197](https://spelunker.whosonfirst.org/id/1242701197), [gn:11483353](https://www.geonames.org/11483353) | GeoNames point; tehsil check OK |
| area | Chak 65 GB | Jaranwala | matched | 31.34928, 73.30688 | 1500 (est.) | [wof:1226539649](https://spelunker.whosonfirst.org/id/1226539649), [gn:1388712](https://www.geonames.org/1388712) | GeoNames point; tehsil check OK |
| area | Chak Jhumra City | Chak Jhumra | matched | 31.56879, 73.18336 | 1400 | [wof:421196441](https://spelunker.whosonfirst.org/id/421196441), [gn:1175748](https://www.geonames.org/1175748), [Q3321415](https://www.wikidata.org/wiki/Q3321415) | WOF locality polygon (label centroid, bbox radius); tehsil check OK |
| area | Chalk 224 RB | Jinnah Town | matched | 31.37782, 73.05533 | 1500 (est.) | [wof:1780038085](https://spelunker.whosonfirst.org/id/1780038085), [gn:7110678](https://www.geonames.org/7110678) | GeoNames point; tehsil check OK |
| area | D-Type Colony | Jinnah Town | not_found | — | — | — | Not in reachable open sources |
| area | Factory Area | Iqbal Town | not_geocodable | — | — | — | Generic label, not a place name |
| area | Gatwala | Madina Town | **ambiguous** | 31.46667, 73.18333 | 1200 (est.) | [wof:1780036917](https://spelunker.whosonfirst.org/id/1780036917), [gn:1178754](https://www.geonames.org/1178754) / [wof:1780038545](https://spelunker.whosonfirst.org/id/1780038545), [gn:1178753](https://www.geonames.org/1178753) | 2 candidates (Araiyan / Sikhan) |
| area | Ghulam Muhammad Abad | Lyallpur Town | not_found | — | — | — | Not in reachable open sources |
| area | Gulberg | Jinnah Town | not_found | — | — | — | Not in reachable open sources |
| area | Gulfishan Colony | Iqbal Town | **ambiguous** | 31.40636, 73.03291 | 1200 (est.) | [wof:1780038275](https://spelunker.whosonfirst.org/id/1780038275), [gn:7110612](https://www.geonames.org/7110612) | Name differs ("Gulfishan"); town unverifiable |
| area | Jaranwala City | Jaranwala | matched | 31.33238, 73.42319 | 2400 | [wof:421197393](https://spelunker.whosonfirst.org/id/421197393), [gn:1176106](https://www.geonames.org/1176106), [Q1251242](https://www.wikidata.org/wiki/Q1251242) | WOF locality polygon (label centroid, bbox radius); tehsil check OK |
| area | Jhang Road | Jinnah Town | **ambiguous** | — | — | — | Road (linear); no point assigned |
| area | Kachi Abadi | Iqbal Town | not_geocodable | — | — | — | Generic label, not a place name |
| area | Kohinoor City | Madina Town | not_found | — | — | — | Not in reachable open sources |
| area | Madina Town | Madina Town | not_found | — | — | — | Not in reachable open sources |
| area | Manawala | Madina Town | not_found | — | — | — | Not in reachable open sources |
| area | Millat Town | Lyallpur Town | not_found | — | — | — | Not in reachable open sources |
| area | Model Town | Jinnah Town | not_found | — | — | — | Not in reachable open sources |
| area | Nishatabad | Lyallpur Town | not_found | — | — | — | Not in reachable open sources |
| area | Noor Pur | Lyallpur Town | **ambiguous** | 31.45000, 73.10000 | 1200 (est.) | [wof:1780038291](https://spelunker.whosonfirst.org/id/1780038291), [gn:1168778](https://www.geonames.org/1168778) / [wof:1326729971](https://spelunker.whosonfirst.org/id/1326729971), [gn:1419915](https://www.geonames.org/1419915) | Common name; low-precision point |
| area | Novelty Bridge | Iqbal Town | not_found | — | — | — | Not in reachable open sources |
| area | Saline Zone-A | Chak Jhumra | not_geocodable | — | — | — | Generic label, not a place name |
| area | Saline Zone-B | Jaranwala | not_geocodable | — | — | — | Generic label, not a place name |
| area | Saline Zone-C | Samundri | not_geocodable | — | — | — | Generic label, not a place name |
| area | Saline Zone-D | Tandlianwala | not_geocodable | — | — | — | Generic label, not a place name |
| area | Samanabad | Jinnah Town | not_found | — | — | — | Not in reachable open sources |
| area | Samundri City | Samundri | matched | 31.06123, 72.95858 | 4000 (est.) | [wof:1344256487](https://spelunker.whosonfirst.org/id/1344256487), [gn:1166234](https://www.geonames.org/1166234) | GeoNames point; tehsil check OK |
| area | Samundri Road | Iqbal Town | **ambiguous** | — | — | — | Road (linear); no point assigned |
| area | Sargodha Road | Lyallpur Town | **ambiguous** | — | — | — | Road (linear); no point assigned |
| area | Susan Road | Madina Town | **ambiguous** | — | — | — | Road (linear); no point assigned |
| area | Tandlianwala City | Tandlianwala | matched | 31.03664, 73.13348 | 1400 | [wof:421175759](https://spelunker.whosonfirst.org/id/421175759), [gn:1163968](https://www.geonames.org/1163968), [Q3695292](https://www.wikidata.org/wiki/Q3695292) | WOF locality polygon (label centroid, bbox radius); tehsil check OK |
| landmark | Faisalabad International Airport | — | matched | 31.36500, 72.99472 | 1000 (est.) | [wof:102535597](https://spelunker.whosonfirst.org/id/102535597), [Q31580](https://www.wikidata.org/wiki/Q31580) | Wikidata point via WOF campus record |

`geocodeRef` formats:

- `wof:<id>`: <https://spelunker.whosonfirst.org/id/<id>>
- `gn:<id>`: <https://www.geonames.org/<id>>
- `wd:<QID>`: <https://www.wikidata.org/wiki/<QID>>

**Updating the gazetteer:**

1. Edit the JSON and record `geocodeSource`, `geocodeRef` and `geocodeNote` for every position.
2. Run `npm run setup`, which calls `syncAreasToDb()`.

Rows that an administrator edited (`geocode_status='manual'` or `reviewed_at` set) are never overwritten. Rows the importer created that aren't in the file are left alone.

## 8. Faisalabad coverage limitations (be honest in the UI)

- **Street, shop and landmark completeness varies.** Most shops, markets, chowks and small streets depend on volunteer mapping in OpenStreetMap, and Google has its own gaps. Some will be missing, misnamed or out of date. The UI copy already says so: "Streets, shops and landmarks come from the map provider and may be incomplete."
- **City neighbourhoods are the weakest part of this gazetteer.** Neither WOF nor GeoNames has Model Town, Gulberg, Samanabad, Madina Town, Millat Town, Nishatabad, Ghulam Muhammad Abad, D-Type Colony, Kohinoor City, Manawala, Aminpur Bangla or Novelty Bridge. They are `not_found`, and their plants appear only in the text list until an administrator pins the area.
- **Some GeoNames points are coarse.** Several (e.g. Nurpur, Gatwala) are 1990s records rounded to whole arc-minutes, about ±1 km. Chak numbers can repeat across canal branches, and GeoNames sometimes omits the branch suffix.
- **Area centres are approximate and are never plant locations.** "Sector N" in the spreadsheet cannot be mapped at all.
- **OSM is edited continuously.** Tiles reflect the provider's current data, not a dated snapshot.

## 9. Limitations of this build environment

**Blocked by the egress policy** on 2026-09-25, for both `curl` and WebFetch:

- mapcarta.com
- nominatim.openstreetmap.org, tile.openstreetmap.org, www.openstreetmap.org and the OSM API
- overpass-api.de (and a mirror)
- router.project-osrm.org
- wikidata.org, query.wikidata.org and wikipedia.org (en and ur)
- geonames.org (www, download and api)
- photon.komoot.io
- dbpedia.org, wikiwand.com and geohack
- operations.osmfoundation.org and wiki.openstreetmap.org
- developers.google.com

**Reachable:** github.com (API for this repo only), raw.githubusercontent.com, media.githubusercontent.com, and the npm registry.

**Consequences:**

- **Gazetteer sources.** The gazetteer relies on Who's On First (and, through it, GeoNames and Wikidata), which is mirrored on GitHub.
- **Policy texts.** These were read from their GitHub source repositories: `openstreetmap/owg-website`, `openstreetmap/openstreetmap-website` and the OSRM wiki.
- **Google and Mapcarta.** Their facts come from search-result summaries and are marked as needing verification.
- **Runtime providers can't be exercised.** Nominatim, tiles and OSRM cannot be tested from here. The code must, and does, degrade to `unavailable`, and tests run with `GEOCODER_PROVIDER=none` and `ROUTING_PROVIDER=none`.

**Follow-up** from a machine with normal network access:

- **One-off, small Nominatim pass.** Geocode the 16 `not_found` and 10 `ambiguous` entries plus the 15 pending landmarks, following the policy:
  - one thread and at most 1 request per second
  - an identifying User-Agent
  - cache the results
  - review every result by hand
- **Or pin them in the admin UI.** Record the OSM element ID (e.g. `osm:node/123`) in `geocode_ref` and "OpenStreetMap (ODbL)" in `geocode_source`.
