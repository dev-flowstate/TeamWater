'use strict';
// CSV output with spreadsheet formula-injection protection.
//   toCsv([['a', 'b'], ['=1+1', 'x,y']])  ->  'a,b\r\n\'=1+1,"x,y"\r\n'
// Cells starting with = + - @ (or a tab / carriage return) are prefixed with an apostrophe so spreadsheet
// applications show them as text instead of evaluating them.

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

module.exports = { csvCell, toCsv };
