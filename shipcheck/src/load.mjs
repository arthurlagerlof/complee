// Node-side loading of the database-backed ShipCheck catalog for the CLI and model tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModel } from './checker.mjs';
import { scoreResults } from './score.mjs';
import { partsToModel } from './parts-model.mjs';
import { CATALOG_KEY_BY_MODEL, fetchCatalog } from './catalog-api.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const readJSON = (p) => JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8'));

export async function loadRules() {
  return (await fetchCatalog('rules')).rules;
}

export async function loadScenarios() {
  return (await fetchCatalog('scenarios')).scenarios;
}

export async function loadModel(sc) {
  const sourceKey = CATALOG_KEY_BY_MODEL[sc.model];
  if (!sourceKey) throw new Error(`No database catalog is configured for model ${sc.model}`);
  const [raw, meta] = await Promise.all([
    fetchCatalog(sourceKey),
    sc.meta ? fetchCatalog(CATALOG_KEY_BY_MODEL[sc.meta]) : {},
  ]);
  return sc.kind === 'parts' ? partsToModel(raw, meta) : raw;
}

export async function runCheck(target) {
  const scenarios = await loadScenarios();
  const sc = scenarios.find((s) => s.id === target);
  if (!sc) throw new Error(`Unknown scenario: ${target}`);
  const [model, rules, expected] = await Promise.all([
    loadModel(sc),
    loadRules(),
    sc.expected ? fetchCatalog(CATALOG_KEY_BY_MODEL[sc.expected]) : null,
  ]);
  const out = { generated: new Date().toISOString(), scenario: sc.id, ...checkModel(model, rules) };
  if (expected) out.score = scoreResults(out, expected);
  return out;
}
