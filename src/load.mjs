// Node-side loading: rules, scenarios and models from disk, and a full check run.
// Used by the server (server.mjs), the CLI (scripts/check.mjs) and the tests. Not used by the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModel, findingsOf } from './checker.mjs';
import { scoreResults, scoreLine } from './score.mjs';
import { partsToModel } from './parts-model.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const readJSON = (p) => JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8'));

export function loadRules(rulesPath = 'rules.json') {
  return readJSON(rulesPath).rules;
}

// Scenarios whose model file exists on disk.
export function loadScenarios() {
  return readJSON('scenarios.json').scenarios.filter((s) => fs.existsSync(path.join(ROOT, s.model)));
}

// A scenario model is either a ship.json/deck.json file or a prepared parts file (kind "parts").
export function loadModel(sc) {
  if (sc.kind === 'parts') return partsToModel(readJSON(sc.model), sc.meta ? readJSON(sc.meta) : {});
  return readJSON(sc.model);
}

// Checks a scenario (by id) or a model file; adds the ground-truth score when the scenario has one.
export function runCheck(target, rulesPath = 'rules.json') {
  const sc = loadScenarios().find((s) => s.id === target);
  const model = sc ? loadModel(sc) : readJSON(target);
  const out = { generated: new Date().toISOString(), scenario: sc?.id ?? target, ...checkModel(model, loadRules(rulesPath)) };
  if (sc?.expected && fs.existsSync(path.join(ROOT, sc.expected))) out.score = scoreResults(out, readJSON(sc.expected));
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

// Writes the precomputed results of every scenario that names a "precomputed" file.
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
