'use strict';
// Spreadsheet parsing for imports (.xlsx via exceljs, and simple .csv).
//
//   const { detectFileType, parseWorkbook } = require('./parse');
//   const type = detectFileType(buffer, 'plants.xlsx');     // 'xlsx' | 'csv' (throws HttpError otherwise)
//   const { sheets } = await parseWorkbook(buffer, type, 'plants.xlsx');
//   sheets[0] = { name, headerRow, headers: ['Plant ID', ...], rows: [{ rowNumber: 2, values: { 'Plant ID': 'FSD-WFP-0001', ... } }] }
//
// The header row is the first non-empty row of a sheet. Cell values are primitives: text as text, numbers as
// numbers, booleans, dates as 'YYYY-MM-DD' (or a full ISO string when a time is present). Rich text, hyperlinks
// and formulas are reduced to their displayed text/result. Fully empty rows are skipped; rowNumber is the real
// spreadsheet row number (header row = its own number, usually 1).
const path = require('node:path');
const ExcelJS = require('exceljs');
const { HttpError } = require('../lib/http');

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04" (zip local file header)
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // legacy .xls / encrypted OOXML

function detectFileType(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(400, 'empty_file', 'The uploaded file is empty.');
  const ext = path.extname(String(filename || '')).toLowerCase();
  const head = buffer.subarray(0, 4);
  if (ext === '.xlsx' || ext === '.xlsm') {
    if (head.equals(XLSX_MAGIC)) return 'xlsx';
    if (head.equals(OLE_MAGIC)) throw new HttpError(415, 'unsupported_file_type', 'This file is a legacy or password-protected Excel file. Save it as an unprotected .xlsx workbook and upload again.');
    throw new HttpError(415, 'unsupported_file_type', 'The file is not a valid .xlsx workbook.');
  }
  if (ext === '.csv') {
    if (head.equals(XLSX_MAGIC) || head.equals(OLE_MAGIC) || buffer.subarray(0, 8192).includes(0)) {
      throw new HttpError(415, 'unsupported_file_type', 'The .csv file contains binary data. Upload a plain-text CSV or an .xlsx workbook.');
    }
    return 'csv';
  }
  if (ext === '.xls') throw new HttpError(415, 'unsupported_file_type', 'Legacy .xls files are not supported. Save the workbook as .xlsx and upload again.');
  throw new HttpError(415, 'unsupported_file_type', 'Only .xlsx workbooks and .csv files can be imported.');
}

const pad = (n) => String(n).padStart(2, '0');
function dateToText(d) {
  if (Number.isNaN(d.getTime())) return null;
  const dateText = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hasTime = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() || d.getUTCMilliseconds();
  return hasTime ? d.toISOString() : dateText;
}

/** Reduce an exceljs cell value to a primitive (string | number | boolean | null). */
function cellPrimitive(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (v instanceof Date) return dateToText(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('');
    if ('formula' in v || 'sharedFormula' in v) return cellPrimitive(v.result);
    if ('hyperlink' in v) return cellPrimitive(v.text ?? v.hyperlink);
    if ('error' in v) return String(v.error);
    if ('text' in v) return cellPrimitive(v.text);
  }
  return String(v);
}

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function columnLetter(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Build unique, non-empty header names: blanks become "Column C", repeats get " (2)". */
function buildHeaders(rawHeaders, width) {
  const seen = new Map();
  const out = [];
  for (let i = 0; i < width; i++) {
    const raw = rawHeaders[i];
    let h = isBlank(raw) ? `Column ${columnLetter(i + 1)}` : String(raw).replace(/\s+/g, ' ').trim();
    const k = h.toLowerCase();
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n > 1) h = `${h} (${n})`;
    out.push(h);
  }
  return out;
}

/** Turn a grid (array of { rowNumber, cells: [primitive...] }) into a sheet with headers + keyed rows. */
function gridToSheet(name, grid) {
  const nonEmpty = grid.filter((r) => r.cells.some((c) => !isBlank(c)));
  if (!nonEmpty.length) return { name, headerRow: null, headers: [], rows: [], rowCount: 0 };
  const [headerLine, ...dataLines] = nonEmpty;
  let width = 0;
  for (const r of nonEmpty) {
    for (let i = r.cells.length - 1; i >= 0; i--) if (!isBlank(r.cells[i])) { width = Math.max(width, i + 1); break; }
  }
  const headers = buildHeaders(headerLine.cells, width);
  const rows = dataLines.map((r) => {
    const values = {};
    headers.forEach((h, i) => {
      const v = r.cells[i];
      values[h] = isBlank(v) ? null : v;
    });
    return { rowNumber: r.rowNumber, values };
  });
  return { name, headerRow: headerLine.rowNumber, headers, rows, rowCount: rows.length };
}

const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_ROWS_PER_SHEET = 50000;

/** Sum of uncompressed sizes from the zip central directory (guards against decompression bombs); null if unreadable. */
function zipUncompressedSize(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const count = buf.readUInt16LE(i + 10);
    let p = buf.readUInt32LE(i + 16);
    if (count > MAX_ZIP_ENTRIES) return Infinity;
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
      const size = buf.readUInt32LE(p + 24);
      total += size === 0xffffffff ? Infinity : size;
      p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return total;
  }
  return null;
}

async function parseXlsx(buffer) {
  const inflated = zipUncompressedSize(buffer);
  if (inflated === null) throw new HttpError(422, 'unreadable_workbook', 'The workbook could not be read. Check that it is a valid, unprotected .xlsx file.');
  if (inflated > MAX_UNCOMPRESSED_BYTES) throw new HttpError(413, 'file_too_large', 'The workbook expands to more data than can be imported at once. Split it into smaller files.');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new HttpError(422, 'unreadable_workbook', 'The workbook could not be read. Check that it is a valid, unprotected .xlsx file.');
  }
  const sheets = [];
  wb.eachSheet((ws) => {
    const grid = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellPrimitive(cell.value); });
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
      grid.push({ rowNumber, cells });
    });
    sheets.push(gridToSheet(ws.name, grid));
  });
  return sheets;
}

/** Minimal RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF/LF, BOM, "," ";" or tab delimiter).
 *  rowNumber is the 1-based record number, which is the row number a spreadsheet app shows. */
function parseCsvText(text) {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch]++; }
  const [best, bestCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const delim = bestCount > 0 ? best : ',';
  const records = [];
  let row = [], field = '', quoted = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); records.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) endField();
    else if (ch === '\r' && src[i + 1] === '\n') continue;
    else if (ch === '\n' || ch === '\r') endRow();
    else field += ch;
  }
  if (field !== '' || row.length) endRow();
  return records.map((cells, idx) => ({ rowNumber: idx + 1, cells: cells.map((c) => (c === '' ? null : c)) }));
}

async function parseWorkbook(buffer, type, filename) {
  let sheets;
  if (type === 'xlsx') sheets = await parseXlsx(buffer);
  else if (type === 'csv') {
    const base = path.basename(String(filename || 'data.csv'), path.extname(String(filename || '.csv'))) || 'CSV';
    sheets = [gridToSheet(base.slice(0, 100), parseCsvText(buffer.toString('utf8')))];
  } else throw new HttpError(415, 'unsupported_file_type', 'Only .xlsx workbooks and .csv files can be imported.');
  if (!sheets.some((s) => s.headers.length)) throw new HttpError(422, 'no_data', 'The file contains no header row or data.');
  if (sheets.some((s) => s.rowCount > MAX_ROWS_PER_SHEET)) {
    throw new HttpError(413, 'too_many_rows', `A sheet has more than ${MAX_ROWS_PER_SHEET.toLocaleString('en-US')} rows. Split it into smaller files.`);
  }
  return { sheets };
}

module.exports = { detectFileType, parseWorkbook, parseCsvText, cellPrimitive, isBlank, zipUncompressedSize };
