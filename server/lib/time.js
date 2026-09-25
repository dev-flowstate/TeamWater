'use strict';
// Time helpers. Storage is UTC ISO-8601; display/opening-hours logic uses Asia/Karachi.
const TZ = 'Asia/Karachi';

const nowIso = () => new Date().toISOString();
const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
const addMinutes = (iso, mins) => new Date(new Date(iso).getTime() + mins * 60000).toISOString();

/** Returns { weekday: 'mon'..'sun', hhmm: 'HH:MM', date: 'YYYY-MM-DD' } for a Date in Asia/Karachi. */
function karachiParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    weekday: parts.weekday.toLowerCase().slice(0, 3),
    hhmm: `${parts.hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

module.exports = { TZ, nowIso, addDays, addMinutes, karachiParts, isIsoDate };
