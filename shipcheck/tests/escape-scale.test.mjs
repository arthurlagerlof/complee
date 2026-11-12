// Escape analysis on a larger arrangement (generated AutoCAD drawing, about 900 elements on two decks): the two ways
// an alternative route is searched (one shared search per group of rooms, a local detour search per room) must
// agree, every route must avoid the gates of the shortest route, and the analysis must stay fast.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dxfToModel } from '../src/autocad.mjs';
import { normalizeModel } from '../src/checker.mjs';
import { analyzeEscape, buildEscapeGraph, routesFrom } from '../src/escape.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('shared and per-room searches agree on a 900-element arrangement, and the analysis is fast', () => {
  const file = path.join(os.tmpdir(), `complee-escape-${process.pid}.dxf`);
  execFileSync(process.execPath, [path.join(ROOT, 'tools/autocad/make_large_dxf.mjs'), file, '2', '400'], { stdio: 'pipe' });
  const { model } = dxfToModel(fs.readFileSync(file, 'utf8'), { filename: 'large.dxf' });
  fs.rmSync(file, { force: true });
  const norm = normalizeModel(structuredClone(model));
  assert.ok(norm.elements.length > 850);
  const t0 = performance.now();
  const all = analyzeEscape(norm);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `analysis took ${Math.round(ms)} ms`);
  assert.equal(all.available, true);
  assert.ok(all.summary.two_routes > 300, 'upper-deck rooms have two stairs');
  const graph = buildEscapeGraph(norm);
  let compared = 0;
  for (const [id, o] of Object.entries(all.origins)) {
    const single = routesFrom(graph, norm, id); // always the per-room search
    assert.equal(single.status, o.status, id);
    assert.equal(single.primary?.length_mm ?? null, o.primary?.length_mm ?? null, `${id} shortest`);
    assert.equal(single.secondary?.length_mm ?? null, o.secondary?.length_mm ?? null, `${id} alternative`);
    if (o.secondary) {
      compared++;
      const gates = new Set([...o.primary.verticals, ...o.primary.doors]);
      assert.ok(!o.secondary.via.some((v) => gates.has(v)), `${id}: the alternative avoids every gate of the shortest route`);
      assert.ok(o.secondary.length_mm >= o.primary.length_mm, `${id}: the alternative is not shorter`);
    }
  }
  assert.ok(compared > 300);
  // Blocking one stair leaves the other: still two decks connected, deterministic result.
  const stair = norm.elements.find((e) => e.type === 'stair' && e.deck === 'D1').id;
  const blocked = analyzeEscape(norm, { blocked: new Set([stair]) });
  assert.equal(JSON.stringify(blocked), JSON.stringify(analyzeEscape(norm, { blocked: new Set([stair]) })));
  assert.equal(blocked.summary.no_route, 0);
});
