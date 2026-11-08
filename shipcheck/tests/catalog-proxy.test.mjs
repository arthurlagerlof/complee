import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('catalog proxy serves database API responses without a local JSON fallback', async (t) => {
  const upstream = http.createServer((req, res) => {
    const catalogs = {
      '/api/v1/shipcheck/catalog/scenarios': {
        scenarios: [
          { id: 'database-scenario' },
          { id: 'cruise', model: 'ships/cruise/deck.json', expected: null },
        ],
      },
      '/api/v1/shipcheck/catalog/rules': { rules: [{ id: 'RULE-1' }] },
      '/api/v1/shipcheck/catalog/model-cruise-deck': {
        name: 'Database model',
        units: 'mm',
        deck: { id: 'DECK', name: 'Deck', length: 10, width: 10 },
        elements: [],
      },
      '/api/v1/shipcheck/catalog/regulation-links': {
        database: 'test database',
        loaded_instruments: 'test instrument',
        method: 'test method',
        rules: { 'RULE-1': { links: [] } },
      },
    };
    if (catalogs[req.url]) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(catalogs[req.url]));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"not imported"}}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.SHIPCHECK_DATA_API_URL = `http://127.0.0.1:${upstream.address().port}`;

  const { server } = await import('../server.mjs');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeIdleConnections();
    upstream.closeIdleConnections();
    await Promise.all([
      new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())),
    ]);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/catalog/scenarios`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    scenarios: [
      { id: 'database-scenario' },
      { id: 'cruise', model: 'ships/cruise/deck.json', expected: null },
    ],
  });

  const missing = await fetch(`${base}/api/catalog/not-a-source`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { message: 'not imported' } });

  const rules = await fetch(`${base}/api/rules`);
  assert.equal(rules.status, 200);
  assert.deepEqual(await rules.json(), { rules: [{ id: 'RULE-1' }] });
  const regulationText = await fetch(`${base}/api/regulations/text?rule=RULE-1`);
  assert.equal(regulationText.status, 200);
  assert.deepEqual(await regulationText.json(), {
    rule_id: 'RULE-1',
    database: 'test database',
    loaded_instruments: 'test instrument',
    method: 'test method',
    linked: true,
    reachable: true,
    note: null,
    provisions: [],
  });

  const check = await fetch(`${base}/api/check?scenario=cruise`);
  assert.equal(check.status, 200);
  assert.equal((await check.json()).scenario, 'cruise');
});
