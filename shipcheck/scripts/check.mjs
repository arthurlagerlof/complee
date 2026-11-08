// CLI: run deterministic checks against the active database-backed ShipCheck catalog.
// Usage: node scripts/check.mjs [scenario-id]
//        node scripts/check.mjs --report [scenario-id]
import fs from 'node:fs';
import path from 'node:path';
import { findingsOf } from '../src/checker.mjs';
import { scoreLine } from '../src/score.mjs';
import { ROOT, loadScenarios, runCheck, loadModel, loadRules } from '../src/load.mjs';
import { reportRows, toCSV, toHTML } from '../src/report.mjs';
import { traceMatrix, traceCSV } from '../src/trace.mjs';

try {
  if (process.argv[2] === '--precompute') {
    throw new Error('Precomputed results are stored in the database; local JSON precompute is no longer supported.');
  }
  const scenarios = await loadScenarios();
  const report = process.argv[2] === '--report';
  const targetArg = report ? process.argv[3] : process.argv[2];
  const targets = targetArg ? [targetArg] : scenarios.map((scenario) => scenario.id);

  if (report) fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  for (const id of targets) {
    const scenario = scenarios.find((entry) => entry.id === id);
    if (!scenario) throw new Error(`Unknown scenario ${id}`);
    const [out, model, rules] = await Promise.all([runCheck(id), loadModel(scenario), loadRules()]);
    const findings = findingsOf(out);
    if (report) {
      fs.writeFileSync(
        path.join(ROOT, 'reports', `${id}.html`),
        toHTML({ title: model.name, scenario: id, results: out, model, rules, score: out.score }),
      );
      fs.writeFileSync(path.join(ROOT, 'reports', `${id}.csv`), toCSV(reportRows(out, model, rules)));
      fs.writeFileSync(
        path.join(ROOT, 'reports', `${id}-traceability.csv`),
        traceCSV(traceMatrix(out, rules)),
      );
      console.log(`Wrote reports/${id}.html and .csv (${findings.length} findings)${out.score ? ` - ${scoreLine(out.score)}` : ''}`);
      continue;
    }

    const summary = out.summary;
    console.log(`\n${out.model}: ${out.rule_count} rules (${out.rules_verified} verified)${out.draft_rules?.length ? `, ${out.draft_rules.length} draft (not run)` : ''}`);
    console.log(`  compliant: ${summary.compliant}  non-compliant: ${summary.non_compliant}  not enough info: ${summary.not_enough_info}`);
    const shown = findings.length > 40 ? findings.filter((finding) => finding.status === 'non_compliant').slice(0, 40) : findings;
    for (const finding of shown) console.log(`  [${finding.status}] ${finding.element} ${finding.rule_id}: ${finding.explanation}`);
    if (shown.length < findings.length) console.log(`  ... ${findings.length - shown.length} more findings`);
    if (out.score) console.log(`  Ground truth: ${scoreLine(out.score)}`);
    if (targets.length === 1) {
      fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(out, null, 2));
      console.log('Wrote results.json');
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
