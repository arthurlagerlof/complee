const DEFAULT_API_BASE = 'http://127.0.0.1:8000';

export function catalogApiBase() {
  return String(globalThis.process?.env?.SHIPCHECK_DATA_API_URL || DEFAULT_API_BASE).replace(/\/+$/, '');
}

export async function fetchCatalog(sourceKey, { fetchImpl = fetch, signal } = {}) {
  if (!/^[a-z0-9-]+$/.test(sourceKey)) throw new Error('Invalid catalog source key.');
  const url = `${catalogApiBase()}/api/v1/shipcheck/catalog/${sourceKey}`;
  const response = await fetchImpl(url, { signal, cache: 'no-store' });
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
