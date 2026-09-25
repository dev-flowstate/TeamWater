'use strict';
// Structured opening hours (plants.opening_hours_json) and "open now" in Asia/Karachi.
//
// Structure: { "mon": [["08:00","20:00"]], "tue": [...], ..., "sun": [] }
//   * keys: mon tue wed thu fri sat sun; each value is a list of [start, end] "HH:MM" pairs (24 h clock)
//   * []            → closed all day (explicitly recorded)
//   * key missing   → hours for that day are UNKNOWN (never assumed closed or open)
//   * ["20:00","02:00"] → overnight: open from 20:00 until 02:00 the next day
//   * "24:00" is allowed as an end time; ["00:00","24:00"] means open all day
// openNow() returns true / false, or null when it cannot be known from the record.
const { karachiParts } = require('./time');
const { parseJson } = require('./db');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME_RE = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const MAX_RANGES_PER_DAY = 6;

const toMin = (hhmm) => (hhmm === '24:00' ? 1440 : Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

class HoursError extends Error {}

/**
 * Validates and normalises opening hours. Accepts an object or a JSON string; null/'' → null.
 * Throws HoursError with a human-readable message when the structure is invalid.
 */
function validateHours(input) {
  if (input === null || input === undefined || input === '') return null;
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch { throw new HoursError('opening hours must be valid JSON'); }
  }
  if (obj === null) return null;
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new HoursError('opening hours must be an object keyed by day (mon…sun)');
  const out = {};
  for (const key of Object.keys(obj)) {
    if (!DAYS.includes(key)) throw new HoursError(`unknown day "${String(key).slice(0, 20)}" (use mon, tue, wed, thu, fri, sat, sun)`);
  }
  for (const day of DAYS) {
    if (!Object.hasOwn(obj, day)) continue;
    const ranges = obj[day];
    if (!Array.isArray(ranges)) throw new HoursError(`${day} must be a list of ["HH:MM","HH:MM"] ranges`);
    if (ranges.length > MAX_RANGES_PER_DAY) throw new HoursError(`${day} has too many ranges`);
    out[day] = ranges.map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || typeof r[0] !== 'string' || typeof r[1] !== 'string') {
        throw new HoursError(`${day}: each range must be ["HH:MM","HH:MM"]`);
      }
      const [start, end] = r.map((s) => s.trim());
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new HoursError(`${day}: times must be HH:MM (00:00–24:00)`);
      if (start === '24:00') throw new HoursError(`${day}: a range cannot start at 24:00`);
      if (start === end) throw new HoursError(`${day}: start and end must differ`);
      return [start, end];
    });
  }
  return out;
}

/** Lenient parse of the stored column: returns the normalised structure or null (unknown / invalid). */
function parseHours(json) {
  const raw = typeof json === 'string' ? parseJson(json, null) : json;
  if (!raw) return null;
  try { return validateHours(raw); } catch { return null; }
}

/** true/false if the structure answers the question for `date` (Asia/Karachi), otherwise null. */
function openNow(structured, date = new Date()) {
  if (!structured || typeof structured !== 'object') return null;
  const { weekday, hhmm } = karachiParts(date);
  const now = toMin(hhmm);
  const idx = DAYS.indexOf(weekday);
  const yesterday = DAYS[(idx + 6) % 7];

  const today = structured[weekday];
  if (!Array.isArray(today)) return null; // today's hours unknown
  for (const [s, e] of today) {
    const start = toMin(s), end = toMin(e);
    if (end > start ? now >= start && now < end : now >= start) return true; // second case: overnight, before midnight
  }
  const prev = structured[yesterday];
  if (!Array.isArray(prev)) return null; // yesterday unknown: an overnight range could still be running
  for (const [s, e] of prev) {
    const start = toMin(s), end = toMin(e);
    if (end < start && now < end) return true; // overnight range from yesterday, after midnight
  }
  return false;
}

/** PlantSummary.openingHours */
function openingHoursView(row, date = new Date()) {
  const structured = parseHours(row.opening_hours_json);
  return { text: row.opening_hours_text ?? null, structured, openNow: structured ? openNow(structured, date) : null };
}

module.exports = { DAYS, HoursError, validateHours, parseHours, openNow, openingHoursView };
