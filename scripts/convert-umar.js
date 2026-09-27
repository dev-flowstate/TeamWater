'use strict';
// Convert the owner-supplied UMAR_AFZAL_RO_SHEET.xlsx into an importable CSV.
//   node scripts/convert-umar.js            (re-run whenever the .xlsx changes, then commit the .csv)
//
// The sheet has no plant ID and no coordinate columns: `SR#, LOCATIONS, GOOGLE LOCATION`. This keeps those three
// columns verbatim and adds:
//   Plant ID    UMAR-<8 hex of the normalised LOCATIONS text>, with -2, -3 … for repeats of the same text.
//               SR# is not used: it is a SUBTOTAL() formula that renumbers whenever the sheet is filtered or sorted.
//   Latitude / Longitude
//               Only from a place pin (!3d<lat>!4d<lng>) or a dropped pin (?q=<lat>,<lng>) in the link. A bare
//               @lat,lng is the map view centre, not the plant, so it is not used. The importer rejects anything
//               outside the Faisalabad bounds (e.g. row 3 points to India).
//   Coordinate basis    which of the above applied (kept in the source values for administrators).
//   Technology (from sheet title)   "RO": the owner's file is titled "RO SHEET". Status stays unknown.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { toCsv } = require('../server/import/csv');

const DIR = path.join(__dirname, '..', 'data', 'source', 'incoming');
const SOURCE = path.join(DIR, 'UMAR_AFZAL_RO_SHEET.xlsx');
const OUTPUT = path.join(DIR, 'UMAR_AFZAL_RO_SHEET.converted.csv');
const HEADERS = ['Plant ID', 'SR#', 'LOCATIONS', 'GOOGLE LOCATION', 'Latitude', 'Longitude', 'Coordinate basis', 'Technology (from sheet title)'];
const NUM = '(-?\\d{1,3}\\.\\d+)';

/** { lat, lng, basis } from a Google Maps link; lat/lng are the link's own text, or null when not usable. */
function coordinatesFromUrl(url) {
  const u = String(url || '').trim();
  if (!u) return { lat: null, lng: null, basis: 'No link' };
  let m = u.match(new RegExp(`!3d${NUM}!4d${NUM}`));
  if (m) return { lat: m[1], lng: m[2], basis: 'Place pin in the Google Maps link' };
  m = u.match(new RegExp(`[?&]q=${NUM},\\s*${NUM}`));
  if (m) return { lat: m[1], lng: m[2], basis: 'Dropped pin in the Google Maps link' };
  if (new RegExp(`@${NUM},${NUM}`).test(u)) return { lat: null, lng: null, basis: 'Not used: the link only gives the map view centre' };
  return { lat: null, lng: null, basis: 'No coordinates in the link' };
}

const idKey = (name) => String(name).trim().replace(/\s+/g, ' ').toUpperCase();

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('hyperlink' in v) return String(v.hyperlink);
    if ('text' in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
  }
  return String(v);
}

async function convert(source = SOURCE) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(source);
  const ws = wb.worksheets[0];
  const seen = new Map();
  const rows = [HEADERS];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const [sr, name, url] = [1, 2, 3].map((c) => cellText(row.getCell(c).value));
    let code = '';
    if (name.trim()) {
      const n = (seen.get(idKey(name)) || 0) + 1;
      seen.set(idKey(name), n);
      code = `UMAR-${crypto.createHash('sha256').update(idKey(name)).digest('hex').slice(0, 8).toUpperCase()}${n > 1 ? `-${n}` : ''}`;
    }
    const c = coordinatesFromUrl(url);
    rows.push([code, sr, name, url, c.lat, c.lng, c.basis, 'RO']);
  });
  return toCsv(rows);
}

if (require.main === module) {
  convert().then((csv) => {
    fs.writeFileSync(OUTPUT, csv);
    console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)} (${csv.trim().split('\r\n').length - 1} rows).`);
  }).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { convert, coordinatesFromUrl, SOURCE, OUTPUT };
