# Data audit: `Filter_palnts_in_Faisalabad_1000_1.xlsx`

This audit covers the source spreadsheet that Team Water imports. It records what the file contains, what it leaves out, where its values are inconsistent, and how the app handles each issue. The figures were computed directly from the workbook (with `exceljs`, the same parser the importer uses) and cross-checked against a full import through `server/import/pipeline.js`. Nothing in the file has been corrected: every original value is kept verbatim in `plants.source_values_json` and the `*_raw` columns.

*Audit date: 2026-09-25. Section 14 explains how to reproduce the numbers.*

---

## 1. Key findings

1. **No plant can be located exactly.** The file has no latitude/longitude, street address, landmark or plant name. Every plant is placed only at area level: an approximate circle for the named area, never a pin.
2. **The status is uniform and undated.** All 1,000 rows say `Fully Functional` and there is no observation date. The app shows it as *"Listed as operational in source data (undated, not verified)"*.
3. **Capacity is a production rate, not an allowance.** Values are exactly 1,000, 2,000, 5,000, 10,000 or 25,000 "GPH", and the gallon type (US or imperial) is not stated. 216 rows (21.6%) record 25,000 GPH, which is unusually large for a community filtration point. These are flagged for a plausibility check and kept unchanged.
4. **`Operating Entity Type` mixes different kinds of information.**
   - 200 rows give a *type of plant* (`Saline Water Treatment RO`, `Industrial Water Plant`) rather than an operator.
   - 57 `Private Commercial RO` rows record a non-RO technology.
   - 336 rows use the unexplained acronym `PSPA`.
5. **Area labels are only partly geographic.**
   - Every area carries a `- Sector N` suffix (N = 1–14) that does not match any known official subdivision.
   - 190 rows name areas that cannot be located on a map: `Saline Zone-A/B/C/D`, `Kachi Abadi` and `Factory Area`.
   - 26 rows spell `Chalk 224 RB`, probably meaning `Chak 224 RB`.
6. **The distributions are very even.**
   - There are no blank cells, and the IDs are sequential.
   - Every category appears in near-equal proportions.
   - Attributes are statistically independent of each other, with one exception: saline zone, brackish source and brackish membrane always go together.

   This pattern is what you would expect from *modelled or generated* data rather than a field survey. It is not proof. We recommend confirming the file's origin with the issuing authority before relying on it (section 10).

## 2. File and structure

| Property | Value |
|---|---|
| File name | `Filter_palnts_in_Faisalabad_1000_1.xlsx` ("palnts" is a typo in the name itself; kept) |
| Size / SHA-256 | 55,466 bytes / `19714b534b9f6dd47eab8b0c7257ff891968074fb645a2d3c99374dd2cfbff9c` |
| Workbook metadata | Created 2026-09-10 06:29:01 UTC, last modified 2026-09-10 06:31:05 UTC. No author organisation or issuing authority is recorded. |
| Sheets | 1: `Faisalabad_1000_Water_Filtratio` (the name is cut off at Excel's 31-character limit) |
| Used range | A1:H1001. The header is row 1 and the data is in rows 2–1001. There are no merged cells, formulas, number formats or hidden rows. |
| Rows / columns | 1,000 data rows × 8 columns |
| Cell types | All 8,000 data cells are text, including capacity (for example `"5000 GPH"`). No cell is blank. There are no leading, trailing or double spaces. |
| Row order | Sorted by Plant ID. Row *n* holds `FSD-WFP-(n−1)`, so `FSD-WFP-0010` is on spreadsheet row 11. |

## 3. Field inventory

| # | Column (verbatim) | Filled | Distinct | Length | Imported as |
|---|---|---|---|---|---|
| A | `Plant ID` | 1,000 | 1,000 | 12 | `plant_code` (unique, well formed `FSD-WFP-0001…1000`) |
| B | `Town/Tehsil` | 1,000 | 8 | 8–13 | `town` |
| C | `Area/Union Council` | 1,000 | 446 | 18–32 | `area_raw`, split into `area_name` + `area_sector`; linked to `areas` by `area_key` |
| D | `Operating Entity Type` | 1,000 | 7 | 17–26 | `operator_type` (as recorded) |
| E | `Water Source` | 1,000 | 4 | 22–28 | `water_source` (as recorded; shown as the diagram's intake) |
| F | `Filtration Technology` | 1,000 | 4 | 20–42 | `technology_raw` → `treatment_stages_json` |
| G | `Capacity (Gallons Per Hour)` | 1,000 | 5 | 8–9 | `capacity_raw`, `capacity_value`, `capacity_unit=gallons_per_hour`, `capacity_unit_label=GPH`, `capacity_gallon_type=unspecified` |
| H | `Operational Status` | 1,000 | 1 | 16 | `status_raw`, `status=operational`, `status_source=spreadsheet`, `status_updated_at=NULL` |

Despite its header, column C holds no union-council names or numbers. Every value has the form `<Area> - Sector <N>`.

## 4. Fields the brief needs that the file does not provide

| Needed field | In file? | Consequence in the app |
|---|---|---|
| Plant name | No | Shown as "Not provided". Plants are identified by Plant ID plus area. |
| Latitude / longitude | No | No plant has an exact location, so there are no pins and no directions. Plants appear in the approximate **area** results group when their area has an approximate centre; otherwise they appear only in the text list. |
| Street address, landmark, neighbourhood | No | "Not provided". The address-geocoding path (commit time, admin review) is never triggered. |
| Opening hours | No | "Not provided". The "open now" status is unknown. |
| Per-person collection limit | No | "Not provided". It is **never** derived from capacity. |
| Operator's actual name | No | Only a type is recorded (and sometimes not even that; see section 6.2). |
| Public contact phone | No | "Not provided". |
| Accessibility | No | "Not provided". |
| Status date / verification date | No | The status is treated as undated and not verified. |
| Water-test results, dates, laboratory, standard | No | Water quality is "Unknown". No tests are created. |
| Source documents / provenance | No | Traceability is limited to file, sheet and row. |
| Gallon type (US or imperial) | No | Capacity is not converted to litres. |
| Whether capacity is rated or measured | No | `capacity_basis` records exactly that this is not stated. |

## 5. Column distributions

### 5.1 `Town/Tehsil` (8 values)

| Value | Rows | Kind |
|---|---|---|
| Jaranwala | 143 | tehsil |
| Chak Jhumra | 136 | tehsil |
| Iqbal Town | 132 | city town |
| Jinnah Town | 127 | city town |
| Lyallpur Town | 125 | city town |
| Samundri | 124 | tehsil |
| Madina Town | 109 | city town |
| Tandlianwala | 104 | tehsil |

The column mixes Faisalabad city's administrative towns with the district's outlying tehsils. The Faisalabad City and Faisalabad Sadar tehsils do not appear. The eight names match the eight "towns" of the former City District Government Faisalabad local-government structure, which may explain the mix. Confirm with the data owner which administrative scheme the file uses.

### 5.2 `Area/Union Council`: 39 base areas, 446 distinct strings

Each base area appears in exactly one town, and no base-area name is shared between towns.

| Town | Rows | Base areas (rows) |
|---|---|---|
| Chak Jhumra | 136 | Chak 185 RB (38), Chak 190 RB (34), Chak Jhumra City (33), Saline Zone-A (31) |
| Iqbal Town | 132 | Factory Area (29), Gulfishan Colony (21), Kachi Abadi (28), Novelty Bridge (26), Samundri Road (28) |
| Jaranwala | 143 | Chak 236 GB (39), Chak 65 GB (31), Jaranwala City (34), Saline Zone-B (39) |
| Jinnah Town | 127 | Chalk 224 RB (26), D-Type Colony (17), Gulberg (19), Jhang Road (18), Model Town (22), Samanabad (25) |
| Lyallpur Town | 125 | Aminpur Bangla (12), Ghulam Muhammad Abad (24), Millat Town (21), Nishatabad (22), Noor Pur (25), Sargodha Road (21) |
| Madina Town | 109 | Canal Road (25), Gatwala (21), Kohinoor City (15), Madina Town (19), Manawala (15), Susan Road (14) |
| Samundri | 124 | Chak 467 GB (28), Chak 474 GB (35), Saline Zone-C (38), Samundri City (23) |
| Tandlianwala | 104 | Chak 398 GB (19), Chak 412 GB (26), Saline Zone-D (25), Tandlianwala City (34) |

Observations:

- The four tehsils each have exactly one "Saline Zone", with letters A–D in the order Chak Jhumra, Jaranwala, Samundri, Tandlianwala. The four city towns have none.
- Six base areas are **roads or a bridge**: Sargodha Road, Jhang Road, Samundri Road, Susan Road, Canal Road and Novelty Bridge.
  - A road runs for kilometres, so an area-level position for one is especially rough.
  - `Samundri Road` (in Iqbal Town) is easy to confuse with the `Samundri` tehsil in search.
- `Madina Town` is used both as a town and as an area inside that town (19 rows).

### 5.3 `Operating Entity Type` (7 values)

| Value | Rows | Note |
|---|---|---|
| Government (PSPA) | 336 | Acronym not explained (6.3) |
| Saline Water Treatment RO | 161 | A plant type, not an operator (6.2) |
| Government (WASA) | 161 | Water and Sanitation Agency |
| NGO (Alkhidmat Foundation) | 139 | |
| Private Commercial RO | 85 | 57 rows record a non-RO technology (6.4) |
| NGO (Community Welfare) | 79 | Generic; no organisation named |
| Industrial Water Plant | 39 | A plant type, not an operator (6.2) |

### 5.4 `Water Source` (4 values)

| Value | Rows |
|---|---|
| Surface Water (Canal Supply) | 300 |
| Groundwater (Tube Well) | 280 |
| Mixed Municipal Supply | 259 |
| Brackish/Saline Groundwater | 161 |

### 5.5 `Filtration Technology` (4 values) and the stages the app derives

| Value | Rows | `treatment_stages_json` |
|---|---|---|
| Ultrafiltration (UF) | 298 | `["ultrafiltration"]` |
| Activated Carbon + UV | 283 | `["activated_carbon","uv"]` |
| Reverse Osmosis (RO) | 258 | `["reverse_osmosis"]` |
| Heavy-Duty Brackish RO Membrane (High TDS) | 161 | `["reverse_osmosis"]` |

No other stages are inferred. The diagram says "Illustrative treatment diagram. Other treatment stages, if any, are not recorded."

### 5.6 `Capacity (Gallons Per Hour)` (5 values)

| Value | Rows | Share |
|---|---|---|
| 25000 GPH | 216 | 21.6% |
| 10000 GPH | 204 | 20.4% |
| 5000 GPH | 202 | 20.2% |
| 1000 GPH | 195 | 19.5% |
| 2000 GPH | 183 | 18.3% |

### 5.7 `Operational Status` (1 value)

| Value | Rows |
|---|---|
| Fully Functional | 1,000 |

### 5.8 Cross-tabulations

- **Saline triple.** The 161 `Saline Water Treatment RO` rows are exactly the 161 `Brackish/Saline Groundwater` rows and exactly the 161 `Heavy-Duty Brackish RO Membrane (High TDS)` rows (100% overlap).
  - All 133 rows in `Saline Zone-*` areas belong to this group.
  - The other 28 are spread over all eight towns, including city towns. Examples: FSD-WFP-0012 (Jaranwala City), FSD-WFP-0032 (Aminpur Bangla), FSD-WFP-0092 (Noor Pur), FSD-WFP-0096 (Gulberg) and FSD-WFP-0099 (Chak 190 RB).
- **Operator × technology.** For the six other operator types, technology is spread evenly across RO, Carbon+UV and UF. For example, `Private Commercial RO` has 28 RO, 31 Carbon+UV and 26 UF rows.
- **Capacity × everything.** Capacity shows no relationship with operator, technology or town (section 10).

## 6. Inconsistencies (counts and example Plant IDs)

| # | Issue | Rows | Examples | App issue code |
|---|---|---|---|---|
| 6.1 | No usable coordinates | 1,000 | all | `no_coordinates` |
| 6.2 | Operator type is a plant type: `Saline Water Treatment RO` (161) and `Industrial Water Plant` (39) | 200 | FSD-WFP-0001, 0004, 0007 (saline); FSD-WFP-0011, 0019, 0147 (industrial) | `operator_type_is_plant_type` |
| 6.3 | Unexplained acronym `PSPA` in `Government (PSPA)`. It is possibly a Punjab water or sanitation authority, but it is **not expanded** because the source doesn't say. | 336 | FSD-WFP-0005, 0008, 0009, 0020 | `operator_acronym_unexplained` |
| 6.4 | `Private Commercial RO` with non-RO technology: 31 Carbon+UV and 26 UF | 57 | FSD-WFP-0013, 0046, 0080 (Carbon+UV); FSD-WFP-0114, 0118, 0123 (UF) | `operator_type_technology_mismatch` |
| 6.5 | Area is not a locatable place: Saline Zone-A (31), -B (39), -C (38), -D (25), Kachi Abadi (28), Factory Area (29) | 190 | FSD-WFP-0001 (Saline Zone-C), FSD-WFP-0023 (Kachi Abadi), FSD-WFP-0087 (Factory Area) | `area_not_geocodable` |
| 6.6 | Probable typo `Chalk 224 RB` for `Chak 224 RB`. The original is kept and the gazetteer adds a search alias. | 26 | FSD-WFP-0158, 0174, 0277, 0283 | `area_name_possible_typo` |
| 6.7 | "Sector N" suffix on every area, with no known official meaning (section 7) | 1,000 | all | `sector_suffix_unverified` |
| 6.8 | Status is undated and identical for all rows (section 8) | 1,000 | all | `status_undated` |
| 6.9 | Gallon type (US or imperial) is not stated | 1,000 | all | `capacity_gallon_type_unspecified` |
| 6.10 | Capacity of 25,000 GPH is unusually high for a community filtration point (section 9) | 216 | FSD-WFP-0003, 0010, 0014, 0024 | `capacity_unusually_high` |
| 6.11 | `Town/Tehsil` mixes city towns and tehsils; the Faisalabad City and Sadar tehsils are absent | 1,000 | — | dataset observation (no code) |
| 6.12 | Header says "Union Council", but no union councils are given | 1,000 | — | dataset observation |
| 6.13 | `Chalk 224 RB`, a *chak* (village), is filed under the city town `Jinnah Town`. This is plausible: the gazetteer places Chak 224 RB inside Faisalabad City tehsil (see `docs/MAP_SOURCES.md`). | 26 | FSD-WFP-0158 | dataset observation |
| 6.14 | Saline-treatment plants appear outside the saline zones, including in city towns | 28 | FSD-WFP-0012, 0032, 0092, 0096, 0099 | dataset observation |
| 6.15 | Rows identical in every column except Plant ID, including the sector: 28 pairs, 56 rows | 56 | FSD-WFP-0004/0068, 0017/0049, 0025/0290, 0045/0724 | dataset observation (**not** queued as duplicates; see below) |
| 6.16 | File name typo "palnts" | — | — | kept verbatim in `source_file` |

**Why 6.15 is not treated as duplicates.** Two real plants of the same type in the same sector are entirely plausible. With so few categories, identical combinations are also expected by chance. At base-area level (ignoring the sector), 64 attribute combinations are shared by 225 rows, and the largest group has 13 rows. Without names or coordinates there is no evidence either way. The importer therefore only creates duplicate candidates when two plants share a similar name **and** either sit within 25 m of each other or have an identical normalised name in the same area. For this file that means **0 candidates**, so the review queue is not flooded.

## 7. The "Sector" pattern

- All 1,000 area values match `^<base area> - Sector (1–14)$`. There are 446 distinct strings out of 546 possible (39 base areas × 14 sectors).
- Each base area uses between 6 and 14 of the 14 sector numbers.
- Sector counts run from 55 (Sector 14) to 87 (Sector 13). This is consistent with a uniform spread (χ² = 12.79, df = 13, p = 0.46).
- The suffix is applied in the same way to planned city colonies (Model Town, Gulberg), rural chaks (Chak 65 GB), roads (Canal Road, Jhang Road), the generic "Saline Zone" labels and whole towns (Jaranwala City).

Faisalabad's planned colonies do have blocks or sectors, but a "Sector 1–14" scheme applied to villages and roads is not a known official subdivision. `docs/ARCHITECTURE.md` §1 notes the same. How the app uses it:

- The base area (`area_name`) is used for area linking and search.
- The sector is stored in `area_sector` and shown as recorded.
- The sector is never used as a location.

## 8. The uniform status

`Operational Status` is `Fully Functional` in all 1,000 rows, with no date or observer. A real inventory of 1,000 plants would normally include some that are closed, under repair or abandoned. How the app handles this:

- It maps the status to `status='operational'` with `status_source='spreadsheet'` and `status_updated_at=NULL`.
- The UI says **"Listed as operational in source data (undated, not verified)"**.
- It never counts this as *verified operating status*. Only an administrator assessment (`status_source='admin_verified'` plus `last_verified_at`) does that, so the recommended ranking gives it no verified-status credit.
- Community reports never change the status by themselves.

## 9. Capacity plausibility

- The values are exact round numbers from a five-step ladder (1k, 2k, 5k, 10k, 25k). Their shares are almost equal (18.3–21.6%; χ² = 2.95, df = 4, p = 0.57).
- The header says "Gallons Per Hour". The cells say "GPH". Neither says US or imperial gallons. 25,000 GPH is about 94,600 L/h if the gallons are US, or about 113,600 L/h if imperial.
- Capacity is unrelated to operator type (p = 0.32), technology (p = 0.84) and town (p = 0.94). For example, `Private Commercial RO` has 21 plants at 25,000 GPH and 18 at 1,000 GPH. `NGO (Community Welfare)` has 22 at 25,000 GPH.
- **Combined recorded capacity is 9,011,000 GPH.** That is about 216 million gallons per day if every plant ran continuously. The data owner may wish to compare this with known supply figures for the district.
- The file doesn't say whether the numbers are rated (design) capacity or measured output, or whether they are per plant or per scheme.

**Handling:**

- Values are stored exactly as recorded.
- They are never converted to litres, because `litresPerHour` stays null while the gallon type is unspecified.
- They are never presented as a per-person allowance.
- Values above 20,000 GPH (216 rows) are flagged `capacity_unusually_high` for a plausibility check. The value itself is not changed.

## 10. Regularity of the distributions (possible modelled data)

These statistics are descriptive. They do not prove how the file was produced.

| Check | Result |
|---|---|
| Blank cells | 0 of 8,000 |
| Plant IDs | Perfectly sequential 0001–1000, no gaps, sorted |
| Status | 1 distinct value across 1,000 rows |
| Town sizes (104–143) vs. uniform | χ² = 9.57, df = 7, p = 0.21 |
| Sector sizes vs. uniform | χ² = 12.79, df = 13, p = 0.46 |
| Capacity levels vs. uniform | χ² = 2.95, df = 4, p = 0.57 |
| Technology among non-brackish rows vs. uniform | χ² = 2.92, df = 2, p = 0.23 |
| Water source among non-brackish rows vs. uniform | χ² = 3.01, df = 2, p = 0.22 |
| Capacity × operator type (independence) | χ² = 26.59, df = 24, p = 0.32 |
| Capacity × technology | χ² = 7.23, df = 12, p = 0.84 |
| Capacity × town | χ² = 17.34, df = 28, p = 0.94 |
| Technology × water source (non-brackish) | χ² = 1.98, df = 4, p = 0.74 |
| Technology × operator (non-saline) | χ² = 6.06, df = 10, p = 0.81 |
| Operator × town (non-saline) | χ² = 26.22, df = 35, p = 0.86 |

Real infrastructure inventories usually show structure. For example, some technologies are more common with some water sources, larger schemes cluster with some operators, and some records are incomplete or out of date. Here, apart from the deliberately linked saline triple, every attribute behaves as if it had been assigned independently and evenly. Combined with the lack of any dates, names, coordinates or blanks, this suggests the file **may be modelled, synthetic or a planning template rather than a field survey**.

This is an observation, not a finding of error. **We recommend confirming the file's origin, date and method with the issuing authority** before using it for decisions. Until then, the app presents every value as "as recorded in the source spreadsheet" and never as verified.

## 11. How the app handles each issue

Import result for this file:

| Metric | Value |
|---|---|
| Rows | 1,000 |
| New | 1,000 |
| Rejected | 0 |
| Held as duplicates | 0 |
| Incomplete (no exact location or no name) | 1,000 |
| Likely duplicates | 0 |

A re-import of the same file gives 1,000 unchanged.

| Issue code | Rows | Review queue? | What happens |
|---|---|---|---|
| `no_coordinates` | 1,000 | no (dataset-wide) | `coord_status='missing'`. No pin, no directions. The plant appears in the **area** group, as a circle with a count, only if its area has an approximate centre; otherwise it appears in the text list by town or area. |
| `sector_suffix_unverified` | 1,000 | no (dataset-wide) | The sector is shown as recorded and not used for location. |
| `status_undated` | 1,000 | no (dataset-wide) | "Listed as operational in source data (undated, not verified)". |
| `capacity_gallon_type_unspecified` | 1,000 | no (dataset-wide) | No litre conversion. "Gallon type not specified." |
| `operator_acronym_unexplained` | 336 | yes | Shown as recorded, not expanded. |
| `capacity_unusually_high` | 216 | yes | Shown as recorded, flagged for a plausibility check. |
| `operator_type_is_plant_type` | 200 | yes | Operator type shown as recorded; operator name "Not provided". |
| `area_not_geocodable` | 190 | yes | The area is not placed on the map. Plants are reachable through the text list only. |
| `operator_type_technology_mismatch` | 57 | yes | Both values are shown as recorded. Stages follow the technology column only. |
| `area_name_possible_typo` | 26 | yes | Original spelling kept. The gazetteer adds the alias "Chak 224 RB" so search works. |
| `coordinates_out_of_bounds`, `coordinates_possibly_swapped`, `unrecognised_status`, `unrecognised_technology` | 0 | yes | Not triggered by this file. The coordinates are not stored (never auto-swapped). Unknown status maps to `unknown`, and unknown technology maps to `[]`. |

In total, **711 plants have `needs_review=1`**.

- **289 plants** carry only dataset-wide issues.
- The largest groups of flagged plants are:
  - PSPA acronym only: 237
  - non-geocodable area + plant-type operator: 106
  - high capacity only: 78
  - high capacity + PSPA: 65
- If reviewers find the PSPA flag too noisy, it can be made dataset-wide with a one-line change: `datasetWide: true` for `operator_acronym_unexplained` in `server/import/fields.js`. That would bring the queue down to 474.

Other safeguards in the importer, which do not apply to this file but protect future ones:

- **Rejected rows.** Rows with a missing Plant ID are rejected.
- **Repeated IDs.** A repeated Plant ID is held for duplicate review and not imported.
- **Re-imports never overwrite administrator work.** Verified coordinates, administrator-set status and verification dates are left alone. A blank source cell never erases an existing value.
- **Water tests.** Tests are created only with a sample date and at least one value, and are marked `not_assessed` because pass/fail is never inferred.
- **Addresses without coordinates.** These are geocoded only into a hidden `geocoded_pending` state that needs administrator verification.

## 12. Recommended corrections for the data owner

1. **Provide coordinates** for every plant: WGS84 decimal degrees with at least 5 decimal places (about 1 m), taken on site by GPS. Also record how each position was obtained.
2. **Add plant names** as they appear on signboards, plus a **street address** and a **nearby landmark**.
3. **Replace "Sector N"** with real locality information: the union-council number and name, mohalla or colony, and the block where one exists. If "Sector" has a meaning, document it.
4. **Split the operator into type and name.**
   - Put the operator type in its own column: Government, NGO, Private, Community or Industrial.
   - Put the organisation's full name in another column, for example "Water and Sanitation Agency Faisalabad".
   - **Expand "PSPA".**
   - Move "Saline Water Treatment RO" and "Industrial Water Plant" into the technology or plant-type columns.
5. **Check "Private Commercial RO" rows** whose technology is UF or Carbon+UV. Either the operator label or the technology is wrong.
6. **Record a dated status per plant.** Use Operational, Temporarily closed (with reason), Permanently closed or Decommissioned, together with the date observed and the person or organisation that observed it.
7. **Capacity.**
   - Confirm the capacities, especially the 216 plants at 25,000 GPH.
   - State US or imperial gallons, and whether each value is rated or measured.
   - Record the per-person collection limit separately if one exists.
8. **Add opening hours** (per day, 24-hour clock) and a **public contact number** for each plant (not a personal number).
9. **Add water-test results** with sample date, laboratory, parameters with units, the standard used (for example the Pakistan National Drinking Water Quality Standards or WHO guidelines, with version), and a link to the lab report.
10. **Fix `Chalk 224 RB`** to `Chak 224 RB` if that is the intended place, and confirm which town it belongs to.
11. **Name the administrative scheme** used for `Town/Tehsil`, and include plants in the Faisalabad City and Sadar tehsils if they are in scope.
12. **Add provenance.** Record the issuing authority, the survey or compilation method and dates, and a document reference in the workbook or an accompanying note.

## 13. Suggested improved template

Use one row per plant, with a header in row 1 and no merged cells. Dates use `YYYY-MM-DD`. The headers below are recognised automatically by the Team Water importer (this is covered by an automated test). Unrecognised columns such as `Union Council`, `Location Method` and `Notes` are still kept verbatim with each plant.

| Column | Example | Notes |
|---|---|---|
| Plant ID | FSD-WFP-0001 | Stable, unique, never reused |
| Plant Name | Model Town Filtration Plant | As on the signboard |
| Town/Tehsil | Jinnah Town | Name the scheme used |
| Area | Model Town | Locality or colony as commonly known (no "Sector" suffix unless it is official) |
| Union Council | UC-123 Model Town | Number and name |
| Address | Street 5, Block C | |
| Landmark | Opposite Jamia Masjid | |
| Latitude | 31.41802 | WGS84, 5+ decimals |
| Longitude | 73.07915 | WGS84, 5+ decimals |
| Location Method | GPS on site | GPS on site / map pin / address |
| Operator Type | Government | Government / NGO / Private / Community / Industrial |
| Operator Name | Water and Sanitation Agency Faisalabad | Full name, no unexplained acronyms |
| Public Phone | 041-0000000 | Plant's public line only |
| Water Source | Groundwater (Tube Well) | |
| Filtration Technology | Reverse Osmosis (RO) | One of a fixed list; list all stages if known |
| Capacity (US gallons per hour) | 1000 | Number only; unit and gallon type are in the header |
| Collection Limit (litres per visit) | 20 | Per person; blank if none |
| Opening Hours | Mon–Sat 08:00–20:00; Sun closed | |
| Status | Operational | Operational / Temporarily closed / Permanently closed / Decommissioned |
| Status Date | 2026-09-01 | When the status was observed |
| Accessibility | Step-free access; tap at 1 m | |
| Last Verified | 2026-09-01 | Date of the last site visit |
| Test Date | 2026-08-15 | Water sample date |
| Laboratory | PCRWR Faisalabad | |
| pH | 7.4 | |
| TDS (mg/L) | 420 | The unit goes in the header |
| Turbidity (NTU) | 0.8 | |
| E. coli (MPN/100 mL) | 0 | |
| Arsenic (µg/L) | 5 | |
| Nitrate (mg/L) | 12 | |
| Fluoride (mg/L) | 0.6 | |
| Source URL | https://example.org/report.pdf | Supporting document |
| Notes | | Free text |

As a CSV header line:

```csv
Plant ID,Plant Name,Town/Tehsil,Area,Union Council,Address,Landmark,Latitude,Longitude,Location Method,Operator Type,Operator Name,Public Phone,Water Source,Filtration Technology,Capacity (US gallons per hour),Collection Limit (litres per visit),Opening Hours,Status,Status Date,Accessibility,Last Verified,Test Date,Laboratory,pH,TDS (mg/L),Turbidity (NTU),E. coli (MPN/100 mL),Arsenic (µg/L),Nitrate (mg/L),Fluoride (mg/L),Source URL,Notes
```

If more than one test per plant is needed, use a second sheet with one row per test (`Plant ID, Test Date, Laboratory, Standard, Parameter, Value, Unit`). It can be imported separately once that workflow exists.

## 14. Reproducing this audit

- **Dry run (writes nothing to the database):**
  ```bash
  npm run import:xlsx -- data/source/Filter_palnts_in_Faisalabad_1000_1.xlsx --dry-run --errors /tmp/issues.csv
  ```
  This prints the summary and issue counts, and writes every error, warning and notice with its row number and Plant ID.
- **Admin screen:** the same pipeline runs behind the admin screen at `/api/admin/imports`. The `errors.csv` download there has the same format.
- **Regression tests:** `test/import.test.js` imports the real file and asserts the counts in section 11 and the traceability of `FSD-WFP-0010` (sheet row 11, raw capacity `25000 GPH`).
- **Chi-square values:** these were computed on the counts shown above, using the uniform distribution or independence as the null hypothesis.
