// Data consistency: a declared clear width cannot be larger than the element is modelled.
// The rule checks read the declared value. If the geometry is narrower than that value, one of the two is wrong and a
// "compliant" result may rest on a typing error. This is a plausibility note for the reviewer, never a rule result.
import { readValue, toMM } from './checker.mjs';

const WIDTH_TYPES = new Set(['corridor', 'stair', 'ramp', 'door']);
const TOLERANCE_MM = 1;

/** Width of the modelled footprint that a clear width has to fit into, in mm (null when it cannot be told). */
export function modelledWidth(el) {
  const g = el.geom_mm;
  if (!g || !WIDTH_TYPES.has(el.type) || !(g.lx > 0) || !(g.ly > 0)) return null;
  // A door is modelled as a thin leaf: its opening is the long side. Corridors, stairs and ramps are walked along
  // their long side, so the short side is the width.
  return el.type === 'door' ? Math.max(g.lx, g.ly) : Math.min(g.lx, g.ly);
}

export function widthCheck(el, model) {
  const modelled = modelledWidth(el);
  const v = readValue(el.props?.clear_width, model.units, el.source);
  if (modelled == null || !v || typeof v.value !== 'number') return null;
  const declared = toMM(v.value, v.unit);
  if (declared == null) return null;
  return { id: el.id, declared_mm: Math.round(declared), modelled_mm: Math.round(modelled), ok: declared <= modelled + TOLERANCE_MM };
}

/** Elements whose declared clear width exceeds the modelled geometry. */
export function consistencyIssues(model) {
  return model.elements.filter((e) => !e.virtual).map((e) => widthCheck(e, model)).filter((c) => c && !c.ok);
}
