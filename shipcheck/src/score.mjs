// Compares checker results with a ground-truth file (tests/expected/<scenario>.json).
// Used by `npm test` and by the UI ("8/8 expected findings detected, 0 false alarms").
//
// expected.findings  hand-checked findings, one per element and rule
// expected.compliant checks that must pass (true negatives, incl. boundary values)
// expected.bulk      for large real models: [{ rule, status, count }] - the number of findings of that
//                    rule and status (not listed in `findings`) must match exactly. The counts come from an
//                    independent scan of the source data (see tests), not from the checker.
import { findingsOf } from './checker.mjs';

const key = (f) => `${f.element}|${f.rule ?? f.rule_id}`;

export function scoreResults(results, expected) {
  const actual = new Map(findingsOf(results).map((f) => [key(f), f]));
  const expectedKeys = new Set(expected.findings.map(key));
  const detected = [], missed = [], wrongStatus = [];
  for (const e of expected.findings) {
    const a = actual.get(key(e));
    if (!a) missed.push(e);
    else if (a.status !== e.status) wrongStatus.push({ ...e, actual: a.status });
    else detected.push(e);
  }

  // Bulk categories: findings of (rule, status) that are not listed individually.
  const bulk = (expected.bulk || []).map((b) => {
    const n = [...actual.values()].filter((f) => !expectedKeys.has(key(f)) && f.rule_id === b.rule && f.status === b.status).length;
    return { ...b, actual: n, ok: n === b.count };
  });
  const bulkCats = new Set(bulk.map((b) => `${b.rule}|${b.status}`));

  const falseAlarms = [...actual.values()]
    .filter((f) => !expectedKeys.has(key(f)) && !bulkCats.has(`${f.rule_id}|${f.status}`))
    .map((f) => ({ element: f.element, rule: f.rule_id, status: f.status }));

  const passes = (expected.compliant || []).map((c) => {
    const r = results.elements[c.element]?.results.find((x) => x.rule_id === c.rule);
    return { ...c, actual: r?.status ?? 'not_checked', ok: r?.status === 'compliant' };
  });

  const bulkFailed = bulk.filter((b) => !b.ok);
  return {
    expected: expected.findings.length,
    detected: detected.length,
    missed,
    wrong_status: wrongStatus,
    false_alarms: falseAlarms,
    passes_expected: passes.length,
    passes_ok: passes.filter((p) => p.ok).length,
    failed_passes: passes.filter((p) => !p.ok),
    bulk,
    bulk_failed: bulkFailed,
    bulk_findings: bulk.reduce((s, b) => s + b.count, 0),
    pass: !missed.length && !wrongStatus.length && !falseAlarms.length && passes.every((p) => p.ok) && !bulkFailed.length,
  };
}

export function scoreLine(s) {
  const fa = `${s.false_alarms.length} false alarm${s.false_alarms.length === 1 ? '' : 's'}`;
  if (s.bulk?.length) {
    return `${s.detected}/${s.expected} hand-checked findings detected, ${s.bulk.length - s.bulk_failed.length}/${s.bulk.length} finding counts match an independent scan` +
      ` (${s.bulk_findings.toLocaleString('en')} findings), ${fa}` + (s.passes_expected ? `, ${s.passes_ok}/${s.passes_expected} expected passes` : '');
  }
  return `${s.detected}/${s.expected} expected findings detected, ${fa}` +
    (s.passes_expected ? `, ${s.passes_ok}/${s.passes_expected} expected passes` : '');
}

// Short form for the top-bar badge: "7/7 expected findings, 0 false alarms".
export function badgeText(score) {
  if (!score) return 'No ground truth for this scenario';
  const fa = `${score.false_alarms.length} false alarm${score.false_alarms.length === 1 ? '' : 's'}`;
  if (score.bulk?.length) return `${score.detected}/${score.expected} hand-checked findings + ${score.bulk.length - score.bulk_failed.length}/${score.bulk.length} counts, ${fa}`;
  return `${score.detected}/${score.expected} expected findings, ${fa}`;
}
