// Submission readiness: what still stands between this revision and a submission to class or flag, from the
// rule check, the findings register, the manual checks and the class comments. Pure function; it decides nothing
// about compliance, it only counts open work. Blockers must be cleared before submitting; warnings must be
// understood (and are listed in the report) but do not stop a submission.
import { findingsOf } from './checker.mjs';
import { registerRows, manualRows } from './dispositions.mjs';
import { commentSummary } from './class-comments.mjs';

/**
 * @param results  checker output
 * @param register findings register store (dispositions and manual confirmations)
 * @param comments class comments (array)
 * @param rules    rule catalog
 * @param edits    number of what-if values in the model
 * Each item: { id, level: 'blocker' | 'warning', count, text, go } where go names the place to fix it.
 */
export function readiness({ results, register = {}, comments = [], rules = [], edits = 0 }) {
  const items = [];
  const add = (id, level, count, text, go) => { if (count > 0) items.push({ id, level, count, text, go }); };
  const rows = registerRows(results, register).filter((r) => !r.resolved);
  const nc = rows.filter((r) => r.status === 'non_compliant');

  add('model_issues', 'blocker', results.model_issues?.length ?? 0, 'model data errors: elements without a usable or unique id, or not elements at all (checked under a new id or skipped)', 'list');
  add('invalid_rules', 'blocker', results.invalid_rules?.length ?? 0, 'rules not run because they are incomplete or invalid', 'rules');
  const checked = Object.values(results.elements || {}).reduce((n, e) => n + (e.results?.length ?? 0), 0);
  add('nothing_checked', 'blocker', checked ? 0 : 1, 'no rule could be checked on this model', 'list');
  add('what_if', 'blocker', edits, `${edits} what-if value${edits === 1 ? ' is' : 's are'} not in the model: the results are not those of the design`, 'edits');
  add('nc_open', 'blocker', nc.filter((r) => r.disposition === 'open').length, 'non-compliant findings without a disposition', 'register');
  add('no_note', 'blocker', rows.filter((r) => r.missing_note).length, 'deviations, acceptances or "not applicable" without a written justification', 'register');
  add('stale', 'blocker', rows.filter((r) => r.stale).length, 'dispositions to review again: the value or result changed since they were written', 'register');
  add('conflicts', 'blocker', Object.values(results.elements).reduce((n, e) => n + (e.conflicts?.length ?? 0), 0), 'rule conflicts: no design can meet both limits, clarify with class or flag', 'list');
  const man = manualRows(results, register);
  add('manual', 'blocker', man.filter((m) => !m.done && m.applicability !== 'unknown').length, 'manual checks not confirmed', 'manual');
  const cs = commentSummary(comments, results, register);
  add('comments_open', 'blocker', cs.open, 'class comments without a response', 'comments');
  add('contradicted', 'blocker', cs.contradicted, 'class comments answered while the rule check still finds the deviation and the register has no justified deviation for it', 'comments');

  // A planned design change is not in the model yet: the design as submitted still has the deviation.
  add('fix_planned', 'blocker', nc.filter((r) => r.disposition === 'fix').length, 'non-compliant findings whose design change is planned but not yet in the model', 'register');
  const undecided = findingsOf(results).filter((f) => f.status === 'not_enough_info').length;
  add('missing_info', 'warning', undecided, 'rule checks without the data they need ("not enough info")', 'list');
  add('manual_unknown', 'warning', man.filter((m) => !m.done && m.applicability === 'unknown').length, 'manual checks whose applicability the model cannot decide', 'manual');
  const applied = new Set(Object.values(results.elements).flatMap((e) => e.results.map((r) => r.rule_id)));
  add('unverified', 'warning', rules.filter((r) => applied.has(r.id) && r.verified !== true).length, 'applied rules whose values are not verified against the official text', 'rules');

  const blockers = items.filter((i) => i.level === 'blocker');
  // ready: nothing blocks a submission. complete: and every applicable rule was decided (no "not enough info");
  // only then may a page say "Ready to submit" without a qualification.
  return { ready: blockers.length === 0, complete: blockers.length === 0 && undecided === 0, undecided, blockers: blockers.length, warnings: items.length - blockers.length, items };
}
