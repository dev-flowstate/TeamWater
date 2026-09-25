# Visual budget & running costs

Owner: Visuals. Updated 2026-09-25.

## 1. Higgsfield image generation (hard cap: 10 credits)

| When | Balance | Note |
|---|---|---|
| Before any generation | **10 credits** (free plan) | `balance` tool |
| After all work | **9.85 credits** | **Spent: 0.15 credits**, well inside the 10-credit cap |

### Cost checks

These were checked with `generate_image` and `get_cost: true`, which submits nothing. The prices are from the tool, not estimates.

| Model | Settings | Credits / image | Usable on free plan? |
|---|---|---|---|
| `recraft_v4_1` | standard, 1k, 16:9 | 1.25 | **No** ("Requires basic plan or higher"; nothing charged) |
| `recraft_v4_1` | standard, 1k, 9:16 | 1.25 | No |
| `recraft_v4_1` | standard, 2k, 16:9 | 8 | No |
| `recraft_v4_1` | vector, 1k, 16:9 | 2.5 | No |
| `gpt_image_2_5` | low (default), 1k, 16:9 | 0.25 | Not attempted |
| `gpt_image_2_5` | medium, 1k, 16:9 | 0.5 | Not attempted |
| `gpt_image_2_5` | medium, 2k, 16:9 | 1 | **No** ("Requires basic plan or higher"; nothing charged) |
| `soul_location` | 16:9 | 0.12 (1 displayed) | Not attempted |
| `z_image` | 16:9 | **0.15** | Yes |

### Jobs

| # | Model | Settings | Prompt (summary) | Credits | Result |
|---|---|---|---|---|---|
| 1 | `recraft_v4_1` | standard, 1k, 16:9, token palette | Flat top-down shoreline (sand, foam, turquoise water, starfish, shell). No text, people or logos. | 0 | Rejected before start: plan required |
| 2 | `gpt_image_2_5` | medium, 2k, 16:9 | Same prompt | 0 | Rejected before start: plan required |
| 3 | `z_image` | 16:9 | Same prompt | **0.15** | Completed. Job `cb8ec226-6399-45bd-8198-83b789823afe`, result on `d8j0ntlcm91z4.cloudfront.net`. **The download failed:** the egress proxy returned 403 on CONNECT (organisation policy). |

### Outcome

No image could be downloaded, so I stopped generating: more jobs would have spent credits on files I couldn't retrieve. `hero-shore-1600.webp` and `hero-shore-800.webp` were **not** produced.

The site uses the local SVG art in `public/img/` instead: `shoreline.svg`, `heron.svg`, `gulls.svg`, `wave-ribbon.svg` and `pattern-foam.svg`.

To add the hero later from a machine that can reach the CDN:

1. Download job #3 from the Higgsfield web app.
2. Convert it to WebP at 1600 px and 800 px wide, each under 150 KB. Example: `python3 -c "from PIL import Image; im=Image.open('hero.png'); …save('hero-shore-1600.webp', quality=78)"`.
3. Commit both files to `public/img/`.

## 2. Asset weight

| Asset | Raw | gzip |
|---|---|---|
| `public/js/diagram.js` | 34.1 KB | 12.2 KB |
| `public/css/diagram.css` | 3.6 KB | 1.5 KB |
| **Diagram total** | | **13.7 KB** (the budget is 25 KB) |
| `public/img/*.svg` (7 files) | 13.7 KB | ~5 KB |
| anime.js (`/vendor/animejs/anime.esm.min.js`) | 119 KB | ~41 KB, **lazy-loaded only**, and only when motion is allowed and a diagram scrolls into view |

## 3. Costs outside the Higgsfield budget

None of these are figures from this project. Check the linked pricing pages before committing, because prices and free tiers change.

- **Hosting.** A small Node 22 VM or container is enough for Express and SQLite (for example a 1 vCPU / 1–2 GB instance). Cost depends on the provider and region. The SQLite file needs a persistent disk, so a stateless or serverless platform won't work unless the database moves.
- **Map tiles.**
  - The default is OpenStreetMap's public tile servers. They are free, but covered by the OSMF [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/): attribution is required, there is no SLA, heavy use is forbidden, and a valid User-Agent/Referer is required. They are fine for a pilot, not for sustained public traffic.
  - For production, use a commercial OSM-based tile provider, such as MapTiler, Stadia Maps or Thunderforest. They are priced per map load or tile request and each has a free tier. Alternatively, self-host tiles, which adds server and storage cost.
- **Google Maps Platform** (only if `MAP_PROVIDER=google`, or if the geocoder or routing uses Google). Maps JavaScript API map loads, the Geocoding API and the Routes API (Compute Routes / Route Matrix) are billed **per request** after the monthly free usage caps for each SKU. See the [pricing page](https://mapsplatform.google.com/pricing/) and the [pricing list](https://developers.google.com/maps/billing-and-pricing/pricing). You need a billing account, key restrictions (HTTP referrer for the browser key, IP for the server key) and budget alerts.
- **Routing.**
  - The public OSRM demo server is not for production use.
  - Self-hosted OSRM with the Pakistan extract from Geofabrik needs a VM with enough RAM for preprocessing, plus about 1 GB of disk per profile.
  - Only driving is enabled by default. Each extra profile (walking, cycling) is another dataset and another process.
- **SMS verification.**
  - Twilio's per-message price for Pakistan is on the [Twilio SMS pricing page for Pakistan](https://www.twilio.com/en-us/sms/pricing/pk). Pakistan also has sender-ID registration requirements.
  - Twilio Verify is billed per verification instead.
  - The rate limits in `server/lib/sms.js` and `ratelimit.js` keep costs bounded. `SMS_PROVIDER=console` costs nothing in development.
- **Storage and backups.**
  - Photo uploads are capped at 3 photos of 5 MB each per report. Water-test PDFs go in `DATA_DIR`.
  - Back up nightly: an SQLite `.backup` of the database plus uploads, stored off the machine (object storage is priced per GB-month and per request).
  - The retention job (`/api/admin/maintenance/retention`) limits growth.
- **Domain and TLS.**
  - The domain registration is an annual fee (for example a `.pk` domain through PKNIC resellers, or a `.org`).
  - TLS is free with Let's Encrypt (Caddy/Certbot) or through the host's managed certificates.
  - HSTS is already sent in production.
