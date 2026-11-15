const DEFAULT_API_BASE = 'http://127.0.0.1:8000';

export function catalogApiBase() {
  return String(globalThis.process?.env?.SHIPCHECK_DATA_API_URL || DEFAULT_API_BASE).replace(/\/+$/, '');
}

// In Node without a configured database API, the bundled catalog (shipcheck/catalog/) is the source.
async function bundled() {
  if (!globalThis.process?.versions?.node || globalThis.process.env.SHIPCHECK_DATA_API_URL) return null;
  const local = await import('./catalog-local.mjs');
  return local.bundledCatalogEnabled() ? local : null;
}

/** Whether a catalog entry can be read at all (bundled mode: only what is in shipcheck/catalog/). */
export async function catalogAvailable(sourceKey) {
  const local = await bundled();
  return local ? local.hasBundledCatalog(sourceKey) : true;
}

export async function fetchCatalog(sourceKey, { fetchImpl, signal } = {}) {
  if (!/^[a-z0-9-]+$/.test(sourceKey)) throw new Error('Invalid catalog source key.');
  if (!fetchImpl) {
    const local = await bundled();
    if (local) return local.readBundledCatalog(sourceKey);
    fetchImpl = fetch;
  }
  const url = `${catalogApiBase()}/api/v1/shipcheck/catalog/${sourceKey}`;
  // Backend access token (backend/app/core/access.py), when this process has one (Node only).
  const token = typeof process !== 'undefined' ? process.env?.BACKEND_API_TOKEN : '';
  const response = await fetchImpl(url, { signal, cache: 'no-store', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ShipCheck catalog ${sourceKey} returned ${response.status}${body ? `: ${body}` : ''}`);
  }
  return response.json();
}

export const CATALOG_KEY_BY_MODEL = {
  'ships/rcrv/parts.json': 'model-rcrv-parts',
  'ships/rcrv/rcrv-3d.meta.json': 'model-rcrv-meta',
  'ships/rcrv/results-3d.json': 'model-rcrv-precomputed',
  'ships/rcrv/inside.json': 'model-rcrv-inside',
  'ships/cruise/deck.json': 'model-cruise-deck',
  'ships/rcrv/layout.json': 'model-rcrv-layout',
  'tests/expected/rcrv-3d.json': 'expected-rcrv-3d',
  'tests/expected/rcrv-inside.json': 'expected-rcrv-inside',
  'tests/expected/cruise.json': 'expected-cruise',
  'tests/expected/rcrv-layout.json': 'expected-rcrv-layout',
};
