// CLI: checks scenarios against the rule set.
// Usage: node scripts/check.mjs                  all scenarios, summary + findings
//        node scripts/check.mjs <id|model.json>   one scenario; also writes results.json
//        node scripts/check.mjs --precompute     writes the offline results (ships/rcrv/results-3d.json)
//        node scripts/check.mjs --report [id]    writes reports/<id>.html and .csv (same as the UI export)
import fs from 'node:fs';
import path from 'node:path';
import { findingsOf } from '../src/checker.mjs';
import { scoreLine } from '../src/score.mjs';
import { ROOT, loadScenarios, runCheck, precompute, loadModel, loadRules } from '../src/load.mjs';
import { reportRows, toCSV, toHTML } from '../src/report.mjs';

if (process.argv[2] === '--report') {
  const ids = process.argv[3] ? [process.argv[3]] : loadScenarios().map((s) => s.id);
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  for (const id of ids) {
    const sc = loadScenarios().find((s) => s.id === id);
    if (!sc) { console.error(`Unknown scenario ${id}`); process.exit(1); }
    const out = runCheck(id);
    const model = loadModel(sc), rules = loadRules();
    fs.writeFileSync(path.join(ROOT, 'reports', `${id}.html`), toHTML({ title: model.name, scenario: id, results: out, model, rules, score: out.score }));
    fs.writeFileSync(path.join(ROOT, 'reports', `${id}.csv`), toCSV(reportRows(out, model, rules)));
    console.log(`Wrote reports/${id}.html and .csv (${findingsOf(out).length} findings)${out.score ? ` - ${scoreLine(out.score)}` : ''}`);
  }
  process.exit(0);
}

if (process.argv[2] === '--precompute') {
  for (const w of precompute()) console.log(`Wrote ${w.file}: ${w.findings} findings ${JSON.stringify(w.summary)}${w.score ? `\n  Ground truth: ${w.score}` : ''}`);
  process.exit(0);
}

const targets = process.argv[2] ? [process.argv[2]] : loadScenarios().map((s) => s.id);
for (const t of targets) {
  const out = runCheck(t, process.argv[3]);
  const s = out.summary;
  const f = findingsOf(out);
  console.log(`\n${out.model}: ${out.rule_count} rules (${out.rules_verified} verified)${out.draft_rules?.length ? `, ${out.draft_rules.length} draft (not run)` : ''}`);
  console.log(`  compliant: ${s.compliant}  non-compliant: ${s.non_compliant}  not enough info: ${s.not_enough_info}`);
  const shown = f.length > 40 ? f.filter((x) => x.status === 'non_compliant').slice(0, 40) : f;
  for (const x of shown) console.log(`  [${x.status}] ${x.element} ${x.rule_id}: ${x.explanation}`);
  if (shown.length < f.length) console.log(`  ... ${f.length - shown.length} more findings${targets.length === 1 ? ' (all in results.json)' : ''}`);
  if (out.score) console.log(`  Ground truth: ${scoreLine(out.score)}`);
  if (targets.length === 1) {
    fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(out, null, 2));
    console.log('Wrote results.json');
  }
}
