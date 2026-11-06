// CLI: checks one scenario (or a model file) against the rule set and writes results.json.
// Usage: node check.mjs [scenario-id | model.json] [rules.json]
//        node check.mjs --precompute     writes the compact offline results of every scenario with "precomputed"
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { checkModel, findingsOf } from './src/checker.mjs';
import { scoreResults, scoreLine } from './src/score.mjs';
import { partsToModel } from './src/parts-model.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const readJSON = (p) => JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8'));

export function loadRules(rulesPath = 'rules.json') {
  const rules = readJSON(rulesPath).rules;
  const approved = path.join(ROOT, 'rules-approved.json');
  if (rulesPath === 'rules.json' && fs.existsSync(approved)) rules.push(...readJSON(approved).rules);
  return rules;
}

export function loadScenarios() {
  return readJSON('scenarios.json').scenarios.filter((s) => fs.existsSync(path.join(ROOT, s.model)));
}

// A scenario model is either a ship.json/deck.json file or a prepared parts file (kind "parts").
export function loadModel(sc) {
  if (sc.kind === 'parts') return partsToModel(readJSON(sc.model), sc.meta ? readJSON(sc.meta) : {});
  return readJSON(sc.model);
}

export function runCheck(target = 'rcrv', rulesPath = 'rules.json', outPath = 'results.json') {
  const sc = loadScenarios().find((s) => s.id === target);
  const model = sc ? loadModel(sc) : readJSON(target);
  const out = { generated: new Date().toISOString(), scenario: sc?.id ?? target, ...checkModel(model, loadRules(rulesPath)) };
  if (sc?.expected && fs.existsSync(path.join(ROOT, sc.expected))) out.score = scoreResults(out, readJSON(sc.expected));
  if (outPath) fs.writeFileSync(path.resolve(ROOT, outPath), JSON.stringify(out, null, 2));
  return out;
}

// Compact results for the offline fallback: every finding with its evidence, and the worst status per
// viewer dbId (objectid) for colouring. Rule texts stay in rules.json.
export function compactResults(out, model) {
  const objOf = Object.fromEntries(model.elements.map((e) => [e.id, e.objectid ?? null]));
  const status_by_objectid = {};
  for (const e of Object.values(out.elements)) if (e.worst && objOf[e.id] != null) status_by_objectid[objOf[e.id]] = e.worst;
  return {
    generated: out.generated, scenario: out.scenario, model: out.model, rule_count: out.rule_count,
    rules_verified: out.rules_verified, draft_rules: out.draft_rules, summary: out.summary, element_summary: out.element_summary,
    score: out.score ? { ...out.score, line: scoreLine(out.score) } : null,
    findings: findingsOf(out).map(({ rule_text, related, ...f }) => ({ ...f, objectid: objOf[f.element] })),
    status_by_objectid,
  };
}

export function precompute() {
  const written = [];
  for (const sc of loadScenarios().filter((s) => s.precomputed)) {
    const model = loadModel(sc);
    const out = { generated: new Date().toISOString(), scenario: sc.id, ...checkModel(model, loadRules()) };
    if (sc.expected) out.score = scoreResults(out, readJSON(sc.expected));
    const c = compactResults(out, model);
    fs.writeFileSync(path.resolve(ROOT, sc.precomputed), JSON.stringify(c));
    written.push({ file: sc.precomputed, findings: c.findings.length, summary: c.summary, score: c.score?.line });
  }
  return written;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--precompute') {
    for (const w of precompute()) console.log(`Wrote ${w.file}: ${w.findings} findings ${JSON.stringify(w.summary)}${w.score ? `\n  Ground truth: ${w.score}` : ''}`);
    process.exit(0);
  }
  const targets = process.argv[2] ? [process.argv[2]] : loadScenarios().map((s) => s.id);
  for (const t of targets) {
    const out = runCheck(t, process.argv[3], targets.length === 1 ? 'results.json' : null);
    const s = out.summary;
    const f = findingsOf(out);
    console.log(`\n${out.model}: ${out.rule_count} rules (${out.rules_verified} verified)${out.draft_rules?.length ? `, ${out.draft_rules.length} draft (not run)` : ''}`);
    console.log(`  compliant: ${s.compliant}  non-compliant: ${s.non_compliant}  not enough info: ${s.not_enough_info}`);
    const shown = f.length > 40 ? f.filter((x) => x.status === 'non_compliant').slice(0, 40) : f;
    for (const x of shown) console.log(`  [${x.status}] ${x.element} ${x.rule_id}: ${x.explanation}`);
    if (shown.length < f.length) console.log(`  ... ${f.length - shown.length} more findings (all in results.json when run for one scenario)`);
    if (out.score) console.log(`  Ground truth: ${scoreLine(out.score)}`);
  }
  if (targets.length === 1) console.log('Wrote results.json');
}
