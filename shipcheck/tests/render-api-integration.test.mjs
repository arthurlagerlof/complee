import test from 'node:test';
import assert from 'node:assert/strict';

const renderHost = 'https://render-api.example';
const requests = [];
const originalFetch = globalThis.fetch;
const originalDataUrl = process.env.SHIPCHECK_DATA_API_URL;
const originalRegulationUrl = process.env.REGULATION_API_URL;
process.env.SHIPCHECK_DATA_API_URL = renderHost;
delete process.env.REGULATION_API_URL;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  requests.push(url.href);
  const bodies = {
    '/api/v1/shipcheck/catalog/rules': { rules: [{ id: 'R-1' }] },
    '/api/v1/shipcheck/catalog/regulation-links': {
      database: 'test', loaded_instruments: [], method: 'test',
      rules: { 'R-1': { links: [{ provision_id: 'P-1', match: 'exact' }] } },
    },
    '/api/v1/regulations/P-1': {
      id: 'P-1', regulatory_document: 'Test code', document_code: 'TEST', edition: '1',
      chapter: 'Chapter 1', clause_reference: '1.1', text: 'Source text',
    },
  };
  return bodies[url.pathname]
    ? new Response(JSON.stringify(bodies[url.pathname]), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('not found', { status: 404 });
};

const { server } = await import('../server.mjs?render-api-integration');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

test('catalog and regulation text calls use the existing Render API base without login', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    if (originalDataUrl === undefined) delete process.env.SHIPCHECK_DATA_API_URL;
    else process.env.SHIPCHECK_DATA_API_URL = originalDataUrl;
    if (originalRegulationUrl === undefined) delete process.env.REGULATION_API_URL;
    else process.env.REGULATION_API_URL = originalRegulationUrl;
  });

  const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api/regulations/text?rule=R-1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provisions[0].text, 'Source text');
  assert.deepEqual(requests.map((request) => new URL(request).host), [
    'render-api.example', 'render-api.example', 'render-api.example',
  ]);
});
