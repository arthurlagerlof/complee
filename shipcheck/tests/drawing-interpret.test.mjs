// Drawing → model interpretation against a synthetic GA with known ground truth (tools/drawing/synthetic-ga.mjs).
// Run: node --test tests/drawing-interpret.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeGA, toSheet } from '../tools/drawing/synthetic-ga.mjs';
import { findViews } from '../src/drawing/views.mjs';
import { interpret } from '../src/drawing/interpret.mjs';
import { normalizeModel, checkModel } from '../src/checker.mjs';
import { area as ringArea, pointInRing, ringBox } from '../src/drawing/plan-graph.mjs';
import { deckOf, roomOf, scaleOf, elevationOf, principalOf, frameSpacingOf, normText, areaOf } from '../src/drawing/vocab.mjs';

const RULES = JSON.parse(fs.readFileSync(new URL('../catalog/rules.json', import.meta.url), 'utf8')).rules;
const PT_MM = 25.4 / 72;
const rel = (a, b) => Math.abs(a / b - 1);
const run = (opts = {}, sheetOpts = {}, overrides = {}) => {
  const { drawing, truth } = makeGA(opts);
  const sheet = toSheet(drawing, sheetOpts);
  const views = findViews(sheet);
  return { truth, sheet, views, ...interpret(sheet, views, overrides) };
};
// one run per variant, shared by the tests below (each takes a few hundred ms)
const cache = new Map();
const get = (key, ...args) => { if (!cache.has(key)) cache.set(key, run(...args)); return cache.get(key); };

const accuracy = {}; // measured accuracy, printed at the end

// ---------- vocabulary ----------

test('vocab: deck names, view titles, rooms, scale, dimensions, elevations', () => {
  assert.equal(deckOf('MAIN DECK').id, 'MD');
  assert.equal(deckOf('Hauptdeck').id, 'MD');
  assert.equal(deckOf("F'cle Deck").id, 'FC');
  assert.equal(deckOf('01 DECK').id, '01');
  assert.equal(deckOf('2nd level').id, '02');
  assert.equal(deckOf('Brückendeck').id, 'BD');
  assert.equal(deckOf('Wheel House Top').id, 'TOP');
  const below = deckOf('Below Main Deck');
  assert.equal(below.below, 'main_deck');
  assert.ok(below.rank < deckOf('MAIN DECK').rank);
  assert.ok(deckOf('TANKDECKE').rank < deckOf('ZWISCHENDECK').rank);
  assert.deepEqual(roomOf('2 crew 6,4 m²'), { type: 'space', zone: 'accommodation' });
  assert.equal(roomOf('Fuel Oil tank PS').type, 'fuel_tank');
  assert.equal(roomOf('Ballast Water').type, 'tank');
  assert.equal(roomOf('Engine room').type, 'machinery_space');
  assert.equal(roomOf('Wet lab.').zone, 'lab');
  assert.equal(roomOf('Galley stores').zone, 'service');
  assert.equal(roomOf('PASSAGEWAY').type, 'corridor');
  assert.equal(roomOf('Up'), null);
  assert.equal(roomOf('8,2 m²'), null);
  assert.equal(scaleOf('SCALE 1:100').n, 100);
  assert.equal(scaleOf('Maßstab 1:50').n, 50);
  assert.equal(scaleOf('M 1:100').n, 100);
  assert.equal(scaleOf('Scale 1:100').n, 100);
  assert.equal(scaleOf('1/8" = 1\'-0"').n, 96);
  assert.equal(scaleOf('slope 1:12 max'), null);
  assert.deepEqual(scaleOf('Échelle 1:200'), { n: 200, labelled: true });
  assert.deepEqual(scaleOf('Scala 1:50'), { n: 50, labelled: true });
  assert.deepEqual(scaleOf('1:100 (A3)'), { n: 100, labelled: false }); // the value next to a "Scala" / "Massstab" cell
  assert.equal(scaleOf('1:50 @ A1').n, 50);
  assert.equal(scaleOf('gear 1:3'), null);
  assert.equal(scaleOf('1:100 A3 page 2'), null);
  assert.equal(principalOf('LOA 60.00 m').mm, 60000);
  assert.equal(principalOf('B = 12,0 m').key, 'beam');
  assert.equal(principalOf('Length o.a').key, 'length_overall');
  assert.equal(frameSpacingOf('Frame spacing 500 mm'), 500);
  assert.equal(frameSpacingOf('SPANTABSTAND 600'), 600);
  assert.equal(elevationOf('6500 ABL'), 6500);
  assert.equal(elevationOf('+6.500'), 6500);
  assert.equal(elevationOf('6.5 m AB'), 6500);
  assert.equal(elevationOf('BL + 6500'), 6500);
  assert.equal(elevationOf('6500 ü. BL'), 6500);
  assert.equal(areaOf('3,2 m²'), 3.2);
  assert.equal(normText("F'cle dk."), 'FCLE DECK');
});

// ---------- the synthetic GA, as PDF points (paper, 1:100) and as a 1:1 mm drawing ----------

for (const paper of [true, false]) {
  const label = paper ? 'paper 1:100' : '1:1 mm';
  const R = () => get(`base-${paper}`, {}, { paper });

  test(`${label}: views found and classified, bow direction`, () => {
    const { views } = R();
    const kinds = views.map((v) => v.kind);
    assert.equal(kinds.filter((k) => k === 'profile').length, 1, kinds.join());
    assert.equal(kinds.filter((k) => k === 'title').length, 1, kinds.join());
    const plans = views.filter((v) => v.kind === 'plan');
    assert.deepEqual(plans.map((v) => v.deckName).sort(), ['01 DECK', 'BRIDGE DECK', 'MAIN DECK', 'TANK TOP']);
    for (const v of views.filter((x) => x.kind === 'plan' || x.kind === 'profile')) {
      assert.equal(v.bow, 'right', `${v.title}: ${v.why.join(' | ')}`);
      assert.ok(v.why.length, 'evidence listed');
    }
    for (const v of plans) assert.ok(v.centreline, `${v.title} centre line`);
  });

  test(`${label}: scale within 0.5 % and cross-checked`, () => {
    const { report } = R();
    const want = paper ? 100 * PT_MM : 1;
    const e = rel(report.scale.mmPerUnit, want);
    accuracy[`${label} scale error %`] = +(e * 100).toFixed(3);
    assert.ok(e < 0.005, `scale ${report.scale.mmPerUnit} vs ${want}`);
    assert.ok(report.scale.sources.length >= 2);
    assert.equal(report.scale.status === 'confirmed' || report.scale.status === 'stated', true);
  });

  test(`${label}: deck elevations within 1 %, outlines within 2 %`, () => {
    const { report, model, truth } = R();
    let worstE = 0, worstA = 0;
    for (const t of truth.decks) {
      const d = report.decks.find((x) => x.name === t.name);
      assert.ok(d, `deck ${t.name}`);
      worstE = Math.max(worstE, rel(d.elevation, t.elevation));
      assert.ok(rel(d.elevation, t.elevation) < 0.01, `${t.name} elevation ${d.elevation} vs ${t.elevation}`);
      assert.ok(rel(d.height, t.height) < 0.01, `${t.name} height ${d.height} vs ${t.height}`);
      const md = model.decks.find((x) => x.name === t.name);
      const a = ringArea(md.outline);
      worstA = Math.max(worstA, rel(a, t.outlineArea));
      assert.ok(rel(a, t.outlineArea) < 0.02, `${t.name} outline ${a / 1e6} m² vs ${t.outlineArea / 1e6}`);
    }
    accuracy[`${label} worst deck elevation error %`] = +(worstE * 100).toFixed(3);
    accuracy[`${label} worst outline area error %`] = +(worstA * 100).toFixed(3);
  });

  test(`${label}: every labelled room found with type, zone and area within 3 %`, () => {
    const { report, recon, truth } = R();
    const truthRooms = truth.rooms.filter((r) => r.type !== 'stair');
    assert.equal(report.rooms.length, truthRooms.length, report.rooms.map((r) => r.name).join());
    let worst = 0;
    for (const t of truthRooms) {
      const r = report.rooms.find((x) => x.deck === t.deck && x.name === t.label);
      assert.ok(r, `${t.deck} ${t.label} found`);
      assert.equal(r.type, t.type, `${t.label} type`);
      assert.equal(r.zone, t.zone, `${t.label} zone`);
      const e = rel(r.area * 1e6, t.area);
      worst = Math.max(worst, e);
      assert.ok(e < 0.03, `${t.label} area ${r.area} m² vs ${(t.area / 1e6).toFixed(2)}`);
    }
    accuracy[`${label} worst room area error %`] = +(worst * 100).toFixed(3);
    // the L-shaped lounge with the stair trunk standing inside it
    const lounge = report.rooms.find((r) => r.name === 'LOUNGE');
    assert.ok(lounge.polygon.length >= 6, 'L shape kept');
    const rec = recon.rooms.find((r) => r.id === lounge.id);
    assert.equal(rec.holes.length, 1, 'stair trunk is a hole in the lounge');
  });

  test(`${label}: doors (widths within 2 %), double doors, the arc-less gap as an opening`, () => {
    const { report, recon, truth } = R();
    assert.equal(report.doors.length, truth.doors.length);
    let worst = 0;
    for (const t of truth.doors) {
      const cands = recon.doors.filter((d) => d.deck === t.deck).map((d) => ({ d, c: [d.hinge[0] + d.wallDir[0] * d.width / 2, d.hinge[1] + d.wallDir[1] * d.width / 2] }));
      const hit = cands.sort((a, b) => Math.hypot(a.c[0] - t.centre[0], a.c[1] - t.centre[1]) - Math.hypot(b.c[0] - t.centre[0], b.c[1] - t.centre[1]))[0];
      assert.ok(hit && Math.hypot(hit.c[0] - t.centre[0], hit.c[1] - t.centre[1]) < 150, `door at ${t.centre} on ${t.deck}`);
      worst = Math.max(worst, rel(hit.d.width, t.width));
      assert.ok(rel(hit.d.width, t.width) < 0.02, `door width ${hit.d.width} vs ${t.width}`);
      assert.equal(!!hit.d.double, t.double);
    }
    accuracy[`${label} worst door width error %`] = +(worst * 100).toFixed(3);
    assert.equal(recon.openings.length, truth.openings.length);
    const o = recon.openings[0], t = truth.openings[0];
    assert.ok(Math.hypot((o.a[0] + o.b[0]) / 2 - t.centre[0], (o.a[1] + o.b[1]) / 2 - t.centre[1]) < 100);
    assert.ok(rel(o.width, t.width) < 0.02);
    // doors are linked to the rooms on both sides
    const lab = report.rooms.find((r) => r.name === 'WET LAB'), cor = report.rooms.find((r) => r.name === 'CORRIDOR' && r.deck === 'MD');
    assert.ok(report.doors.some((d) => d.connects.includes(lab.id) && d.connects.includes(cor.id)));
    // and cut into their wall
    assert.ok(recon.walls.some((w) => w.openings.some((x) => x.kind === 'door')));
  });

  test(`${label}: stairs with treads, corridor clear width within 2 %`, () => {
    const { model, recon, truth, report } = R();
    assert.equal(recon.stairs.length, truth.stairs.length);
    for (const t of truth.stairs) {
      const s = model.elements.find((e) => e.type === 'stair' && e.deck === t.deck);
      assert.ok(s, `stair on ${t.deck}`);
      assert.equal(s.props.treads.value, t.treads);
      assert.ok(rel(s.props.clear_width.value, t.width) < 0.02, `stair width ${s.props.clear_width.value} vs ${t.width}`);
      const deckAbove = truth.decks.find((d) => d.elevation > truth.decks.find((x) => x.id === t.deck).elevation && d.elevation === Math.min(...truth.decks.filter((x) => x.elevation > truth.decks.find((y) => y.id === t.deck).elevation).map((x) => x.elevation)));
      const r = recon.stairs.find((x) => x.id === s.id);
      assert.ok(Math.abs(r.z1 - deckAbove.elevation) < 0.01 * deckAbove.elevation, 'stair reaches the deck above');
    }
    let worst = 0;
    for (const c of report.rooms.filter((r) => r.type === 'corridor')) {
      worst = Math.max(worst, rel(c.clear_width, 1140));
      assert.ok(rel(c.clear_width, 1140) < 0.02, `corridor clear width ${c.clear_width}`);
    }
    accuracy[`${label} worst corridor width error %`] = +(worst * 100).toFixed(3);
    assert.equal(recon.ladders.length, truth.ladders.length);
  });

  test(`${label}: furniture and hatch are not walls; unresolved labels are listed, not invented`, () => {
    const { recon, truth, report } = R();
    const inBox = (p, b, m) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
    for (const f of truth.furniture) {
      const bad = recon.walls.filter((w) => w.deck === f.deck && inBox(w.a, f.box, 60) && inBox(w.b, f.box, 60));
      assert.equal(bad.length, 0, `furniture ${f.box} became a wall`);
    }
    for (const h of truth.hatch) {
      const bad = recon.walls.filter((w) => w.deck === h.deck && inBox(w.a, h.box, 10) && inBox(w.b, h.box, 10));
      assert.equal(bad.length, 0, 'hatch became walls');
    }
    for (const u of truth.unresolvedLabels) assert.ok(report.unresolved.some((x) => x.what.includes(`"${u.label}"`)), `${u.label} listed as unresolved`);
    assert.ok(!report.rooms.some((r) => r.name === 'DRY STORE'), 'the unclosed store is not invented');
    assert.equal(recon.equipment.length, truth.equipment.length);
    assert.equal(recon.windows.length, truth.portholes.length);
  });

  test(`${label}: the model passes normalizeModel and checkModel; values carry their basis`, () => {
    const { model, recon, report, truth } = R();
    const norm = normalizeModel(structuredClone(model));
    assert.equal(norm.issues.length, 0, JSON.stringify(norm.issues.slice(0, 3)));
    const out = checkModel(model, RULES);
    assert.ok(out.elements[report.rooms.find((r) => r.type === 'corridor').id].results.length > 0, 'the corridor rule ran');
    for (const e of model.elements) {
      assert.match(e.id, /^[A-Z0-9]+-[A-Z]+-\d+$/);
      for (const [k, v] of Object.entries(e.props)) if (v && typeof v === 'object' && 'value' in v) assert.ok(['measured', 'read', 'typed', 'assumed'].includes(v.basis), `${e.id}.${k} basis`);
    }
    for (const d of model.decks) assert.ok(d.basis);
    assert.equal(model.ship.length_overall.value, truth.loa);
    assert.equal(model.ship.beam.value, truth.beam);
    assert.equal(model.ship.type.value, 'research');
    assert.ok(recon.hull && recon.hull.stations.length >= 30 && recon.hull.id === model.elements.find((e) => e.type === 'hull').id);
    for (const v of report.views.filter((x) => x.kind === 'plan')) assert.equal(v.toSheet.length, 6);
    assert.ok(report.assumed.length && report.measured.length);
  });
}

// ---------- variants ----------

test('variant: bow to the left (plans rotated, profile mirrored)', () => {
  const { views, report, truth } = get('bowleft', { bow: 'left' }, { paper: true });
  assert.ok(views.filter((v) => v.kind === 'plan' || v.kind === 'profile').every((v) => v.bow === 'left'));
  assert.equal(report.bow, 'left');
  for (const t of truth.decks) assert.ok(rel(report.decks.find((d) => d.name === t.name).elevation, t.elevation) < 0.01);
  const truthRooms = truth.rooms.filter((r) => r.type !== 'stair');
  for (const t of truthRooms) {
    const r = report.rooms.find((x) => x.deck === t.deck && x.name === t.label);
    assert.ok(r && rel(r.area * 1e6, t.area) < 0.03, `${t.label}`);
  }
  // port side stays port: the wet lab (port) has y > 0
  const lab = report.rooms.find((r) => r.name === 'WET LAB');
  assert.ok(lab.polygon.every((p) => p[1] > 0), 'wet lab on the port side');
  assert.equal(report.doors.length, truth.doors.length);
});

test('variant: half plans mirrored to the full breadth', () => {
  const { views, model, truth, report } = get('half', { half: true }, { paper: true });
  const plans = views.filter((v) => v.kind === 'plan');
  assert.equal(plans.length, 4);
  assert.ok(plans.every((v) => v.halfPlan), plans.map((v) => `${v.title}:${v.halfPlan}`).join());
  for (const t of truth.decks) {
    const d = model.decks.find((x) => x.name === t.name);
    assert.ok(rel(ringArea(d.outline), t.outlineArea) < 0.03, `${t.name} ${ringArea(d.outline) / 1e6} vs ${t.outlineArea / 1e6}`);
  }
  assert.ok(report.assumed.some((a) => /half plan mirrored/.test(a)));
});

test('variant: no profile → elevations assumed and listed', () => {
  const { views, report, model } = get('noprofile', { profile: false }, { paper: true });
  assert.equal(views.filter((v) => v.kind === 'profile').length, 0);
  assert.equal(views.filter((v) => v.kind === 'plan').length, 4);
  for (const d of report.decks) assert.equal(d.elevation_basis, 'assumed', d.name);
  const z = Object.fromEntries(report.decks.map((d) => [d.id, d.elevation]));
  assert.ok(z.TT < z.MD && z.MD < z['01'] && z['01'] < z.BD, JSON.stringify(z));
  assert.ok(report.assumed.filter((a) => /elevation/.test(a)).length >= 4);
  assert.ok(Math.abs(report.scale.mmPerUnit / (100 * PT_MM) - 1) < 0.005);
  normalizeModel(structuredClone(model));
});

test('variant: 1:1 drawing in centimetres', () => {
  const { report, truth } = get('cm', {}, { paper: false, unit: 'cm' });
  assert.ok(rel(report.scale.mmPerUnit, 10) < 0.005);
  for (const t of truth.decks) assert.ok(rel(report.decks.find((d) => d.name === t.name).elevation, t.elevation) < 0.01);
  assert.equal(report.rooms.length, truth.rooms.filter((r) => r.type !== 'stair').length);
});

test('overrides: a typed scale and a typed deck elevation win and are marked typed', () => {
  const { report, model } = run({}, { paper: true }, { scale: 100, views: {} });
  assert.equal(report.scale.basis, 'typed');
  const { views } = get('base-true', {}, { paper: true });
  const md = views.find((v) => v.deckName === 'MAIN DECK');
  const { drawing } = makeGA({});
  const sheet = toSheet(drawing, { paper: true });
  const out = interpret(sheet, findViews(sheet), { views: { [md.id]: { elevation: 5100 } } });
  const d = out.report.decks.find((x) => x.name === 'MAIN DECK');
  assert.equal(d.elevation, 5100);
  assert.equal(d.elevation_basis, 'typed');
  void model;
});

test('labels: multi-line names join, things in a room are not rooms', async () => {
  const { labelGroups } = await import('../src/drawing/plan-read.mjs');
  const t = (id, text, x, y) => ({ id, text, c: [x, y], h: 250, angle: 0 });
  const groups = labelGroups([t('a', 'Roll Damp', 0, 300), t('b', 'Tank', 0, 0), t('c', 'Frdg', 5000, 0), t('d', '2 crew', 9000, 300), t('e', '6,4 m²', 9000, 0), t('f', '25', 9000, 600)]);
  const by = (s) => groups.find((g) => g.text.startsWith(s));
  assert.equal(by('Roll').text, 'Roll Damp Tank');
  assert.equal(by('Roll').room.type, 'tank');
  assert.equal(by('Frdg').room.type, 'equipment');
  assert.equal(by('2 crew').area, 6.4);
  assert.ok(groups.some((g) => g.text === '25'), 'a bare number stays apart');
  assert.equal(roomOf('Servers and 19" rack').type, 'equipment');
  assert.equal(roomOf('SRO/HMI').type, 'equipment');
  assert.equal(roomOf('Switchboard room').type, 'machinery_space');
  assert.equal(roomOf('Hydr.Oil').type, 'tank');
});

test('open deck: areas not under the deck above, rail-height walls, report fields', () => {
  const { recon, report, model } = get('base-true', {}, { paper: true });
  const wd = report.rooms.find((r) => r.name === 'WORKING DECK');
  const rec = recon.rooms.find((r) => r.id === wd.id);
  assert.equal(rec.open, true);
  assert.equal(rec.z1 - rec.z0, 1000, 'open deck: rail height');
  assert.ok(recon.walls.some((w) => w.deck === 'MD' && w.rail && w.z1 - w.z0 === 1000), 'bulwark around the working deck at rail height');
  assert.ok(!recon.walls.find((w) => w.deck === 'MD' && w.rail && w.kind === 'bulkhead' && Math.abs(w.a[0] - 20000) < 100), 'the deckhouse front stays full height');
  for (const d of report.decks) { assert.ok(d.basis); assert.ok(d.source); }
  for (const [z, n] of Object.entries(report.counts.zones)) { assert.equal(typeof z, 'string'); assert.equal(typeof n, 'number'); }
  assert.equal(typeof report.counts.unlabelled_areas, 'number');
  assert.equal(model.elements.find((e) => e.id === wd.id).geom.h, 1000);
});

test('accuracy summary', () => {
  console.log('  measured accuracy on the synthetic GA:', JSON.stringify(accuracy, null, 1));
  assert.ok(Object.keys(accuracy).length > 0);
});

// keep helpers referenced (used while debugging single cases)
void pointInRing; void ringBox;
