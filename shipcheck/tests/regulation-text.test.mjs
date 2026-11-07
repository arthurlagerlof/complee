import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegulationText } from '../src/regulation-text.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const linksFile = path.join(ROOT, 'regulation-links.json');
const links = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
const rulesJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.json'), 'utf8'));
const ruleIds = (rulesJson.rules || rulesJson).map((r) => r.id);

test('regulation links: every link names an existing rule, a provision UUID, a clause and a match kind', () => {
  for (const [ruleId, entry] of Object.entries(links.rules)) {
    assert.ok(ruleIds.includes(ruleId), `unknown rule ${ruleId}`);
    assert.ok(entry.links.length > 0, ruleId);
    for (const l of entry.links) {
      assert.match(l.provision_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, ruleId);
      assert.ok(l.clause, ruleId);
      assert.ok(['exact', 'related'].includes(l.match), ruleId);
    }
  }
});

const provision = (id, clause, text) => ({
  id, regulatory_document: 'Doc', document_code: 'ADA', edition: 'Ed', chapter: 'Ch', clause_reference: clause, text,
  source_availability: 'full', provision_availability: 'full', metadata: { document_note: 'Note' },
});

test('regulation text: linked provisions come from the backend lookup by id and are cached', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const id = url.split('/').pop();
    return new Response(JSON.stringify(provision(id, '404.2.3', 'Clear Width. 32 inches (815 mm) minimum.')), { status: 200 });
  };
  const rt = createRegulationText({ linksFile, ruleIds: () => ruleIds, apiBase: 'http://backend:8000/', fetchImpl });
  for (let i = 0; i < 2; i++) {
    const out = await rt.forRule('ADA-404.2.3');
    assert.equal(out.linked, true);
    assert.equal(out.reachable, true);
    assert.equal(out.provisions.length, 1);
    assert.deepEqual(out.provisions[0], {
      provision_id: links.rules['ADA-404.2.3'].links[0].provision_id, document: 'Doc', document_code: 'ADA', edition: 'Ed',
      heading: 'Ch', clause: '404.2.3', text: 'Clear Width. 32 inches (815 mm) minimum.', availability: 'full', document_note: 'Note',
      match: 'exact', note: null,
    });
  }
  assert.deepEqual(calls, [`http://backend:8000/api/v1/regulations/${links.rules['ADA-404.2.3'].links[0].provision_id}`]);
});

test('regulation text: rules without links, unknown rules and an unreachable backend are reported, nothing invented', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  const rt = createRegulationText({ linksFile, ruleIds: () => ruleIds, fetchImpl: down });
  const unlinked = await rt.forRule('IACS-W11-HULL-GRADE');
  assert.equal(unlinked.linked, false);
  assert.deepEqual(unlinked.provisions, []);
  await assert.rejects(rt.forRule('NOT-A-RULE'), (e) => e.status === 404);
  const out = await rt.forRule('SOLAS-II-2-13-DEADEND-PAX');
  assert.equal(out.reachable, false);
  assert.match(out.error, /backend not reachable/);
  assert.equal(out.provisions[0].clause, 'II-2/13/3.1.2');
  assert.equal(out.provisions[0].text, null);
  assert.match(out.note, /no 13 m figure/);
  const notFound = createRegulationText({ linksFile, ruleIds: () => ruleIds, fetchImpl: async () => new Response('{}', { status: 404 }) });
  assert.match((await notFound.forRule('ADA-405.2')).error, /returned 404/);
});
