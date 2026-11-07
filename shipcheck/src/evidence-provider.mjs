// Provider boundary for document-review evidence retrieval.
// The checker does not depend on any concrete provider. Replace this module or
// select another adapter without changing rules, model checks, or the UI contract.

export function createEvidenceProvider(config = {}) {
  if (config.kind === 'sinceai') {
    return import('../integrations/sinceai/provider.mjs').then(({ createSinceAIProvider }) => createSinceAIProvider(config));
  }
  return Promise.resolve({
    id: 'none',
    async search() { return { provider: 'none', results: [] }; },
  });
}
