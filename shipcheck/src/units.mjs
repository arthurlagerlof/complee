// Parsing of imperial value strings found in the ShipConstructor / APS model.
// Pure functions (Node and browser). Every parser returns null when the text is not understood:
// a value is never guessed.

const IN_TO_MM = 25.4;
const LB_TO_KG = 0.45359237;
const r3 = (v) => Math.round(v * 1000) / 1000;

// "5/8", "1 1/2", "0.375", "2" -> number (inches). null if not a number.
function parseInchNumber(s) {
  const t = s.trim();
  let m;
  if ((m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/))) return +m[1] + +m[2] / +m[3];
  if ((m = t.match(/^(\d+)\s*\/\s*(\d+)$/))) return +m[1] / +m[2];
  if ((m = t.match(/^\d+(?:\.\d+)?$/))) return +t;
  return null;
}

// Feet-inch strings: 5'-4 9/16"  3/16"  1 1/2"  1'-0"  2'  0"  -> inches (number) or null.
export function parseFeetInch(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/[″”]/g, '"').replace(/[′’]/g, "'");
  let m = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:-?\s*([\d\s/.]+)\s*"?)?$/);
  if (m) {
    const ft = +m[1];
    const inch = m[2] ? parseInchNumber(m[2]) : 0;
    return inch == null ? null : ft * 12 + inch;
  }
  m = s.match(/^([\d\s/.]+?)\s*(?:"|in)$/i);
  if (m) return parseInchNumber(m[1]);
  return null;
}

export const inchToMM = (inch) => (inch == null ? null : r3(inch * IN_TO_MM));

// "40.3lb" / "40.3 lbs" / "18 kg" -> kg or null.
export function parseWeightKg(text) {
  const m = String(text ?? '').trim().match(/^(-?\d+(?:\.\d+)?)\s*(lb|lbs|kg)$/i);
  if (!m) return null;
  return r3(m[2].toLowerCase() === 'kg' ? +m[1] : +m[1] * LB_TO_KG);
}

// Clear opening from an item name:
//   30"X36" QUICK ACTING ...      -> { w: 30, l: 36 }   (inches)
//   HATCH, CARGO, 5'-0" x 5'-0"   -> { w: 60, l: 60 }
//   15" ROUND RAISED ... MANHOLE  -> { d: 15 }
// Returns { kind: 'rect'|'round', w_in, l_in | d_in, raw } or null.
const LEN = `(\\d+\\s*'\\s*-?\\s*[\\d\\s/.]*"?|[\\d\\s/.]+")`;
const RECT = new RegExp(`${LEN}\\s*[xX×]\\s*${LEN}`);
const ROUND = new RegExp(`${LEN}\\s*(?:DIA\\.?|DIAMETER|ROUND)`, 'i');

export function parseOpening(name) {
  const s = String(name ?? '').replace(/[″”]/g, '"');
  let m = s.match(RECT);
  if (m) {
    const a = parseFeetInch(m[1]), b = parseFeetInch(m[2]);
    if (a != null && b != null && a > 0 && b > 0) return { kind: 'rect', w_in: Math.min(a, b), l_in: Math.max(a, b), raw: m[0].trim() };
  }
  m = s.match(ROUND);
  if (m) {
    const d = parseFeetInch(m[1]);
    if (d != null && d > 0) return { kind: 'round', d_in: d, raw: m[0].trim() };
  }
  return null;
}
