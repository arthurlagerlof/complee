// Real RCRV model (database catalog): ground truth, an independent recount of every bulk
// finding category, and the new check types.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel, validateRule, whereMatches, parseSteelGrade, findingsOf } from '../src/checker.mjs';
import { partsToModel, swbsGroup } from '../src/parts-model.mjs';
import { scoreResults, scoreLine } from '../src/score.mjs';
import { fetchCatalog } from '../src/catalog-api.mjs';

const [rulesCatalog, parts, meta, expected, precomputed, cruise] = await Promise.all([
  fetchCatalog('rules'),
  fetchCatalog('model-rcrv-parts'),
  fetchCatalog('model-rcrv-meta'),
  fetchCatalog('expected-rcrv-3d'),
  fetchCatalog('model-rcrv-precomputed'),
  fetchCatalog('model-cruise-deck'),
]);
const RULES = rulesCatalog.rules;
const res = (out, el, rule) => out.elements[el]?.results.find((r) => r.rule_id === rule);

const model = partsToModel(parts, meta);
const loaded = { parts, model, out: checkModel(model, RULES), expected };
const load = () => loaded;

test('rcrv-3d: hand-checked findings detected, bulk counts match, no false alarms', () => {
  const { out, expected } = load();
  const s = scoreResults(out, expected);
  console.log(`  rcrv-3d: ${scoreLine(s)}`);
  assert.deepEqual(s.missed, []);
  assert.deepEqual(s.wrong_status, []);
  assert.deepEqual(s.false_alarms, []);
  assert.deepEqual(s.failed_passes, []);
  assert.deepEqual(s.bulk_failed, []);
});

// Independent recount from database parts. Deliberately written without the checker or the adapter's
// helper functions: plain filters over the raw fields, with the material lists spelled out.
test('rcrv-3d: every bulk count equals an independent scan of database parts', () => {
  const { parts, expected } = load();
  const P = parts.parts;
  const listed = new Set(expected.findings.map((f) => `${f.element}|${f.rule}`));
  const minus = (rule, ids) => ids.filter((id) => !listed.has(`P${id}|${rule}`)).length;
  const isPlate = (p) => ['Plate', 'Standard Plate', 'Curved Plate'].includes(p.itemType ?? p.name);
  const isNamedOpening = (p) => /HATCH|MANHOLE|SCUTTLE|DOOR/i.test(p.name) && !/\.dwg$/i.test(p.name) && !['File', 'Block'].includes(p.itemType);
  const sc = P.filter((p) => p.group.includes('ShipConstructor'));

  // DQ: design status and "Error" fields.
  const prelim = P.filter((p) => p.vfi === 'Preliminary').map((p) => p.objectid);
  const errs = P.filter((p) => p.errors?.length).map((p) => p.objectid);

  // W11 amber: SWBS 1xx steel-or-unknown structure without a usable grade.
  const nonSteel = /^(AL |SS |DETA|FABREEKA|ASTM E-84)/;
  const w11Amber = sc.filter((p) => String(p.swbs ?? '').startsWith('1') && !isNamedOpening(p) && !nonSteel.test(p.material ?? '')
    && !(p.material ?? '').startsWith('CS ') && !(p.material ?? '').startsWith('ASTM A')).map((p) => p.objectid);

  // S6 amber: shell/bulkhead/deck carbon-steel plates that do not meet Class III (strictest column), or t > 50 mm.
  const III = [[15, 'A', 'A'], [20, 'B', 'A'], [30, 'D', 'D'], [50, 'E', 'E']]; // [max mm, MS, HT letter]
  const rank = { A: 0, B: 1, D: 2, E: 3, F: 4 };
  const s6Amber = sc.filter((p) => {
    const code = String(p.swbs ?? '').split(',')[0];
    if (!isPlate(p) || isNamedOpening(p) || !/^1[123]\d{1,2}$/.test(code) || !(p.material ?? '').startsWith('CS ABS ')) return false;
    const g = p.material.slice(7), t = p.thickness?.mm;
    if (t == null) return false;
    const ht = /\d\d$/.test(g), letter = ht ? g.replace('H', '')[0] : g;
    const row = III.find(([max]) => t <= max);
    return !row || rank[letter] < rank[ht ? row[2] : row[1]];
  }).map((p) => p.objectid);

  // Hatches without a size in the name.
  const hatches = P.filter((p) => /HATCH/i.test(p.name) && isNamedOpening(p) && !/FDN|FOUNDATION|^hatch (cover|frame)$/i.test(p.name));
  const hatchAmber = hatches.filter((p) => !p.opening).map((p) => p.objectid);

  // Oil fuel piping that is not steel. Every MC string found in the oil fuel systems is listed here by hand.
  const STEEL_MC = new Set(['316 STAINLESS STEEL', 'A234 GR WPB', 'A234 Gr WPB', 'ACID PROOF SS', 'ASTM A-105', 'ASTM A105', 'ASTM A106 GR B',
    'ASTM A106 Gr B', 'ASTM A234 GR WPB', 'ASTM A234 Gr WPB', 'CARBON STEEL', 'STAINLESS STEEL']);
  const NOT_STEEL_MC = new Set(['5083 AL', '5086 AL', 'ALUMINUM', 'BRONZE', 'DUCTILE IRON', 'HOSE', 'STAINLEESS']);
  const fo = P.filter((p) => p.mc && /FUEL OIL|\bFO\b/.test(`${p.sys ?? ''} ${p.pli ?? ''}`));
  for (const p of fo) assert.ok(STEEL_MC.has(p.mc) || NOT_STEEL_MC.has(p.mc), `unclassified oil fuel pipe material "${p.mc}": add it to the test lists`);
  const foAmber = fo.filter((p) => NOT_STEEL_MC.has(p.mc)).map((p) => p.objectid);

  const scan = {
    'DQ-DESIGN-STATUS': minus('DQ-DESIGN-STATUS', prelim),
    'DQ-ERROR-VALUES': minus('DQ-ERROR-VALUES', errs),
    'IACS-W11-HULL-GRADE': minus('IACS-W11-HULL-GRADE', w11Amber),
    'IACS-S6-T7-GRADE-THICKNESS': minus('IACS-S6-T7-GRADE-THICKNESS', s6Amber),
    'IGC-3.5.3.1.2-HATCH-OPENING': minus('IGC-3.5.3.1.2-HATCH-OPENING', hatchAmber),
    'SOLAS-II-2-4.2.2.5.1-FO-PIPE': minus('SOLAS-II-2-4.2.2.5.1-FO-PIPE', foAmber),
  };
  for (const b of expected.bulk) assert.equal(scan[b.rule], b.count, `${b.rule} ${b.status}: independent scan`);
});

test('rcrv-3d: inch values are shown with their mm conversion', () => {
  const { out } = load();
  const r = res(out, 'P977', 'IACS-S6-T7-GRADE-THICKNESS');
  assert.equal(r.measured, 'grade A, t = 5/8" = 15.88 mm');
  assert.equal(r.inputs[0].value, '5/8" = 15.88 mm');
  const h = res(out, 'P3519', 'IGC-3.5.3.1.2-HATCH-OPENING');
  assert.equal(h.measured, '30" (smaller side of 30"X36") = 762 mm');
});

test('rcrv-3d: setting the material class decides the grade/thickness check (live edit)', () => {
  const { model } = load();
  const m = structuredClone(model);
  const el = m.elements.find((e) => e.id === 'P977'); // 5/8" Grade A shell plate
  el.props.material_class = { value: 'III', source: 'edited' };
  assert.equal(res(checkModel(m, RULES), 'P977', 'IACS-S6-T7-GRADE-THICKNESS').status, 'non_compliant');
  el.props.material_class = { value: 'I', source: 'edited' };
  assert.equal(res(checkModel(m, RULES), 'P977', 'IACS-S6-T7-GRADE-THICKNESS').status, 'compliant');
});

test('rcrv-3d: draft rule (no official value) is listed and never run', () => {
  const { out } = load();
  assert.ok(out.draft_rules.some((d) => d.id === 'MIN-THK-SWBS'));
  assert.ok(Object.values(out.elements).every((e) => e.results.every((r) => r.rule_id !== 'MIN-THK-SWBS')));
});

test('rcrv-3d: database precomputed results match a fresh run', () => {
  const { out } = load();
  const pre = precomputed;
  assert.deepEqual(pre.summary, out.summary);
  assert.equal(pre.findings.length, findingsOf(out).length);
  assert.ok(pre.findings.every((f) => Number.isInteger(f.objectid)));
});

test('aluminium and stainless parts are not checked against steel grades, and the UI says why', () => {
  const { out, model } = load();
  const al = model.elements.find((e) => e.props.material_family?.value === 'aluminium' && /^1/.test(e.props.swbs?.value ?? ''));
  const na = out.elements[al.id].not_applicable.find((n) => n.rule_id === 'IACS-W11-HULL-GRADE');
  assert.match(na.reason, /material_family is "aluminium"/);
});

// ---------- new check types (small synthetic models) ----------

test('where operators: prefix, in, not_in, exists', () => {
  assert.ok(whereMatches('114', { prefix: '1' }));
  assert.ok(!whereMatches(undefined, { prefix: '1' }));
  assert.ok(whereMatches('110', { in: ['110', '120'] }));
  assert.ok(whereMatches(undefined, { not_in: ['aluminium'] }));
  assert.ok(whereMatches('x', { exists: true }) && whereMatches(undefined, { exists: false }));
});

test('steel grade parsing follows UR W11 note 1 ("H" before or after)', () => {
  assert.deepEqual(parseSteelGrade('A'), { strength: 'MS', letter: 'A' });
  assert.deepEqual(parseSteelGrade('AH36'), { strength: 'HT', letter: 'A', level: 36 });
  assert.deepEqual(parseSteelGrade('HE32'), { strength: 'HT', letter: 'E', level: 32 });
  assert.equal(parseSteelGrade('API 5L X-52'), null);
});

test('UR S6 Table 7 boundaries: Grade A at 15 mm / 15.01 mm, D at 30 mm, beyond 50 mm', () => {
  const rule = RULES.find((r) => r.id === 'IACS-S6-T7-GRADE-THICKNESS');
  const m = (t, grade, cls) => ({ name: 't', units: 'mm', elements: [{ id: 'X', type: 'plate', name: 'x', props: {
    thickness: t, steel_grade: grade, swbs_group: '110', material_family: 'carbon steel', ...(cls ? { material_class: cls } : {}) } }] });
  const st = (...a) => res(checkModel(m(...a), [rule]), 'X', rule.id).status;
  assert.equal(st(15, 'A'), 'compliant');
  assert.equal(st(15.01, 'A'), 'not_enough_info', 'Class III needs B above 15 mm; class unknown');
  assert.equal(st(15.01, 'A', 'III'), 'non_compliant');
  assert.equal(st(30, 'D', 'III'), 'compliant');
  assert.equal(st(30.01, 'D', 'III'), 'non_compliant');
  assert.equal(st(45, 'A'), 'not_enough_info', 'fails every class, but Grade A is allowed outside 0.4L amidships');
  assert.equal(st(45, 'A', 'I'), 'non_compliant');
  assert.equal(st(50.8, 'E', 'I'), 'not_enough_info', 'above the table');
  assert.equal(st(25, 'AH36', 'II'), 'compliant', 'HT column: AH suffices for Class II at 20-25 mm');
});

test('new rules are valid and every unverified rule is in VERIFY.md', () => {
  const verify = fs.readFileSync(new URL('../VERIFY.md', import.meta.url), 'utf8');
  for (const r of RULES) {
    assert.deepEqual(validateRule(r), [], r.id);
    if (!r.verified) assert.ok(verify.includes(r.id), `${r.id} missing in VERIFY.md`);
  }
  assert.equal(swbsGroup('1001'), '100');
  assert.equal(swbsGroup('100,150'), '100');
  assert.equal(swbsGroup('Error'), null);
});

// ---------- Meyer mentors Q&A (7 Nov) ----------

test('mentor Q&A: DNV confirmed, every rule reviewed but still unverified, no drawing codes in rules', () => {
  assert.equal(meta.ship.class_society.value, 'DNV');
  assert.match(meta.ship.class_society.source, /confirmed by Meyer mentors \(Q&A, 7 Nov\)/);
  for (const r of RULES) {
    assert.equal(r.verified, false, `${r.id} must stay verified:false`);
    assert.equal(r.review_status, 'reviewed by Meyer mentors (Q&A, 7 Nov)', r.id);
  }
  assert.doesNotMatch(JSON.stringify(RULES), /\b(BHP|BHK|TTP|FLT|MDK|SSH)\b/);
  const verify = fs.readFileSync(new URL('../VERIFY.md', import.meta.url), 'utf8');
  const open = verify.split('## Open mentor questions')[1].split('\n## ')[0];
  assert.doesNotMatch(open, /BHP|ABS or DNV/);
  const out = checkModel(cruise, RULES);
  assert.equal(Object.values(out.elements)[0].results[0]?.review_status ?? 'reviewed by Meyer mentors (Q&A, 7 Nov)', 'reviewed by Meyer mentors (Q&A, 7 Nov)');
});
