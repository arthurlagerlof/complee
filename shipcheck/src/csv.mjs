// CSV cells for files that engineers open in Excel. Text from imported models, class comment sheets and colleagues'
// project files ends up in these cells; a cell starting with =, +, -, @ (or a tab / carriage return) would be run by
// Excel as a formula (e.g. =HYPERLINK(...) or a DDE command). Such text gets a leading apostrophe, which Excel shows
// as plain text. Numbers stay numbers; "-5 mm" or "-12.5" stay as written.
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-\d+(?:[.,]\d+)?(?:\s?[a-z%°"']{0,4})?$/i;

export function csvCell(v) {
  let s = typeof v === 'number' ? String(v) : String(v ?? '');
  if (typeof v !== 'number' && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Rows of cells -> CSV text with a BOM and CRLF (Excel reads UTF-8 names correctly).
export function csvText(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
