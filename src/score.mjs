// Compares checker results with a ground-truth file (tests/expected/<scenario>.json).
// Used by `npm test` and by the UI ("8/8 expected findings detected, 0 false alarms").
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
  const falseAlarms = [...actual.values()]
    .filter((f) => !expectedKeys.has(key(f)))
    .map((f) => ({ element: f.element, rule: f.rule_id, status: f.status }));

  // Checks that must pass (true negatives, incl. boundary values).
  const passes = (expected.compliant || []).map((c) => {
    const r = results.elements[c.element]?.results.find((x) => x.rule_id === c.rule);
    return { ...c, actual: r?.status ?? 'not_checked', ok: r?.status === 'compliant' };
  });

  return {
    expected: expected.findings.length,
    detected: detected.length,
    missed,
    wrong_status: wrongStatus,
    false_alarms: falseAlarms,
    passes_expected: passes.length,
    passes_ok: passes.filter((p) => p.ok).length,
    failed_passes: passes.filter((p) => !p.ok),
    pass: !missed.length && !wrongStatus.length && !falseAlarms.length && passes.every((p) => p.ok),
  };
}

export function scoreLine(s) {
  return `${s.detected}/${s.expected} expected findings detected, ${s.false_alarms.length} false alarm${s.false_alarms.length === 1 ? '' : 's'}` +
    (s.passes_expected ? `, ${s.passes_ok}/${s.passes_expected} expected passes` : '');
}
