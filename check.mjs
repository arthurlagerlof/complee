// Rule checker: reads a deck model + rule set, writes results.json.
// Usage: node check.mjs [deck.json] [rules.json]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const TO_MM = { mm: 1, m: 1000, in: 25.4, ft: 304.8 };
const STATUS_RANK = { non_compliant: 3, not_enough_info: 2, compliant: 1 };

function applies(rule, el) {
  if (!rule.applies_to.types.includes(el.type)) return false;
  for (const [k, v] of Object.entries(rule.applies_to.where || {})) {
    if (el.props?.[k] !== v) return false;
  }
  return true;
}

const fmt = (v, unit) =>
  unit === 'ratio' ? `1:${(1 / v).toFixed(1).replace(/\.0$/, '')} (${(v * 100).toFixed(1)}%)` : `${Math.round(v)} ${unit}`;

function evaluate(rule, el, deck, byId) {
  const base = {
    rule_id: rule.id, source: rule.source, clause: rule.clause,
    rule_text: rule.text, verified: rule.verified,
  };

  if (rule.check === 'min' || rule.check === 'max') {
    const raw = el.props?.[rule.parameter];
    if (raw == null) {
      return { ...base, status: 'not_enough_info', measured: null,
        required: `${rule.check === 'min' ? '>=' : '<='} ${fmt(rule.value, rule.unit)}`,
        explanation: `"${rule.parameter}" is missing in the design data for ${el.name}. Add it to check this rule.` };
    }
    const value = rule.unit === 'ratio' ? raw : raw * (TO_MM[deck.units] ?? 1);
    const ok = rule.check === 'min' ? value >= rule.value : value <= rule.value;
    const required = `${rule.check === 'min' ? '>=' : '<='} ${fmt(rule.value, rule.unit)}`;
    return { ...base, status: ok ? 'compliant' : 'non_compliant',
      measured: fmt(value, rule.unit), required,
      explanation: ok
        ? `${rule.parameter} is ${fmt(value, rule.unit)}, requirement ${required} is met.`
        : `${rule.parameter} is ${fmt(value, rule.unit)}, but must be ${required}. ` +
          (rule.check === 'min'
            ? `Short by ${fmt(rule.value - value, rule.unit)}.`
            : `Too steep: exceeds the limit.`) };
  }

  if (rule.check === 'not_adjacent_zone') {
    const adj = (el.props?.adjacent || []).map((id) => byId[id]).filter(Boolean);
    if (!el.props?.adjacent) {
      return { ...base, status: 'not_enough_info', measured: null, required: `not next to: ${rule.zones.join(', ')}`,
        explanation: `Adjacent spaces of ${el.name} are not defined in the design data.` };
    }
    const bad = adj.filter((s) => rule.zones.includes(s.props?.zone));
    return { ...base, status: bad.length ? 'non_compliant' : 'compliant',
      measured: `adjacent: ${adj.map((s) => `${s.name} [${s.props?.zone}]`).join(', ')}`,
      required: `not next to: ${rule.zones.join(', ')}`,
      explanation: bad.length
        ? `${el.name} borders ${bad.map((s) => s.name).join(', ')} (${rule.zones.join('/')} zone). Move the tank or add a separating space.`
        : `${el.name} does not border any ${rule.zones.join('/')} space.` };
  }

  return { ...base, status: 'not_enough_info', measured: null, required: '-', explanation: `Unknown check type "${rule.check}".` };
}

export function runCheck(deckPath = 'deck.json', rulesPath = 'rules.json', outPath = 'results.json') {
  const deck = JSON.parse(fs.readFileSync(deckPath, 'utf8'));
  const { rules } = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const byId = Object.fromEntries(deck.elements.map((e) => [e.id, e]));

  const elements = {};
  const summary = { compliant: 0, non_compliant: 0, not_enough_info: 0 };

  for (const el of deck.elements) {
    const results = rules.filter((r) => applies(r, el)).map((r) => evaluate(r, el, deck, byId));
    results.forEach((r) => summary[r.status]++);
    const worst = results.reduce((w, r) => (STATUS_RANK[r.status] > (STATUS_RANK[w] || 0) ? r.status : w), null);
    elements[el.id] = { id: el.id, name: el.name, type: el.type, worst, results };
  }

  const out = { generated: new Date().toISOString(), deck: deck.name, rule_count: rules.length, summary, elements };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = runCheck(process.argv[2], process.argv[3]);
  console.log(`Checked "${out.deck}" against ${out.rule_count} rules`);
  console.log(`  compliant: ${out.summary.compliant}  non-compliant: ${out.summary.non_compliant}  not enough info: ${out.summary.not_enough_info}`);
  for (const e of Object.values(out.elements)) {
    for (const r of e.results) {
      if (r.status !== 'compliant') console.log(`  [${r.status}] ${e.id} ${r.rule_id}: ${r.explanation}`);
    }
  }
  console.log('Wrote results.json');
}
