// Bundled catalog (Node only): the rules, scenarios and example models in shipcheck/catalog/.
// Used when no database API is configured (SHIPCHECK_DATA_API_URL unset), so the viewer, the CLI and the
// tests run on their own. The file names are the ones the database catalog uses as keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LOCAL_CATALOG_FILES = {
  rules: 'rules.json',
  scenarios: 'scenarios.json',
  'regulation-links': 'regulation-links.json',
  'model-rcrv-parts': 'ships/rcrv/parts.json',
  'model-rcrv-meta': 'ships/rcrv/rcrv-3d.meta.json',
  'model-rcrv-precomputed': 'ships/rcrv/results-3d.json',
  'model-rcrv-inside': 'ships/rcrv/inside.json',
  'model-cruise-deck': 'ships/cruise/deck.json',
  'model-rcrv-layout': 'ships/rcrv/layout.json',
  'expected-rcrv-3d': 'tests/expected/rcrv-3d.json',
  'expected-rcrv-inside': 'tests/expected/rcrv-inside.json',
  'expected-cruise': 'tests/expected/cruise.json',
  'expected-rcrv-layout': 'tests/expected/rcrv-layout.json',
};

export const catalogDir = () => path.resolve(ROOT, process.env.CATALOG_DIR || 'catalog');

/** True when the bundled catalog is the catalog source: no database API configured and the files exist. */
export function bundledCatalogEnabled() {
  return !process.env.SHIPCHECK_DATA_API_URL && fs.existsSync(path.join(catalogDir(), 'rules.json'));
}

export function hasBundledCatalog(sourceKey) {
  const file = Object.hasOwn(LOCAL_CATALOG_FILES, sourceKey) ? LOCAL_CATALOG_FILES[sourceKey] : null; // not "constructor" & co.
  return !!file && fs.existsSync(path.join(catalogDir(), file));
}

export function readBundledCatalog(sourceKey) {
  if (!hasBundledCatalog(sourceKey)) {
    throw Object.assign(new Error(`Catalog ${sourceKey} is not part of the bundled catalog`), { status: 404 });
  }
  const dir = catalogDir();
  const data = JSON.parse(fs.readFileSync(path.join(dir, LOCAL_CATALOG_FILES[sourceKey]), 'utf8'));
  // Offer only the scenarios whose model is bundled. The full production model, and the scene placed inside it,
  // need the database and the streamed 3D model.
  if (sourceKey === 'scenarios') data.scenarios = data.scenarios.filter((sc) => !sc.scene && fs.existsSync(path.join(dir, sc.model)));
  return data;
}
