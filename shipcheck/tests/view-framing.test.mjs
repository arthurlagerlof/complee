import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPerspectiveBox, viewportAspect } from '../src/view-framing.mjs';

const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => v.map((x) => x / Math.hypot(...v));
const xyz = (v) => Array.isArray(v) ? v : [v.x, v.y, v.z];
const corners = (box) => {
  const min = xyz(box.min), max = xyz(box.max), out = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
};

// Independently project using the returned pose, without using the helper's camera basis.
function project(box, frame) {
  const back = unit(sub(frame.position, frame.target));
  const right = unit(cross(frame.up, back)), up = cross(back, right);
  const tanV = Math.tan(frame.fov * Math.PI / 360);
  return corners(box).map((p) => {
    const delta = sub(p, frame.position), depth = -dot(delta, back);
    return { x: dot(delta, right) / (depth * tanV * frame.aspect), y: dot(delta, up) / (depth * tanV), depth };
  });
}

function checkFrame(box, options, { tight = true, epsilon = 1e-8 } = {}) {
  const frame = fitPerspectiveBox(box, options), ps = project(box, frame);
  assert.equal(ps.length, 8);
  for (const p of ps) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.depth));
    assert.ok(p.depth > frame.near && p.depth < frame.far, 'near/far planes must include all corners');
    assert.ok(Math.abs(p.x) <= 1 / options.margin + epsilon, `horizontal corner clipped: ${p.x}`);
    assert.ok(Math.abs(p.y) <= 1 / options.margin + epsilon, `vertical corner clipped: ${p.y}`);
  }
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xs) + Math.max(...xs)) < epsilon, 'projected horizontal bounds must be centered');
  assert.ok(Math.abs(Math.min(...ys) + Math.max(...ys)) < epsilon, 'projected vertical bounds must be centered');
  if (tight) assert.ok(Math.abs(Math.max(...xs.map(Math.abs), ...ys.map(Math.abs)) - 1 / options.margin) < epsilon, 'fit must use the available viewport, rather than a bounding sphere');
  return frame;
}

test('fits and centers all corners of an oblique ship box in landscape and narrow portrait viewports', () => {
  const box = { min: [-33000, -2500, -7200], max: [28000, 26000, 6400] };
  for (const aspect of [3, 16 / 9, 1, 0.3, 0.025]) {
    const frame = checkFrame(box, { fov: 40, aspect, direction: [-0.3, 0.6, 1], margin: 1.1 });
    const expected = unit([-0.3, 0.6, 1]);
    unit(sub(frame.position, frame.target)).forEach((x, i) => assert.ok(Math.abs(x - expected[i]) < 1e-10, 'current viewing direction must be preserved'));
    assert.ok(frame.distance > 0);
  }
});

test('centers projected edges rather than just aiming at the world-space midpoint', () => {
  const box = { min: [12, -3, -8], max: [76, 32, 9] };
  const frame = checkFrame(box, { fov: 55, aspect: 1.7, direction: [1, 0.4, 0.8], margin: 1.08 });
  const midpoint = xyz(box.min).map((x, i) => (x + box.max[i]) / 2);
  assert.ok(Math.hypot(...sub(frame.target, midpoint)) > 0.1, 'perspective depth needs a lateral target adjustment');
  const closer = { ...frame, position: frame.target.map((x, i) => x + (frame.position[i] - x) * 0.999) };
  assert.ok(project(box, closer).some((p) => Math.max(Math.abs(p.x), Math.abs(p.y)) > 1 / 1.08), 'a closer camera must violate the requested margin');
});

test('translated boxes, object vectors and arbitrary camera up work without mutating inputs', () => {
  const box = { min: { x: 100000, y: -20000, z: 3700 }, max: { x: 100040, y: -19965, z: 3712 } };
  const options = { fov: 27, aspect: 0.45, direction: { x: 0.2, y: -0.8, z: 0.5 }, up: [0, 0, 1], margin: 1.2 };
  const before = structuredClone({ box, options });
  checkFrame(box, options);
  assert.deepEqual({ box, options }, before);
});

test('flat decks, lines, points and up-parallel directions have finite unclipped frames', () => {
  for (const box of [
    { min: [-30, 0, -6], max: [30, 0, 6] },
    { min: [0, -3, 0], max: [0, 14, 0] },
    { min: [15, 8, -2], max: [15, 8, -2] },
  ]) {
    for (const direction of [[0, 1, 0], [0, -1, 0], [0, 0, 0], [0, 0, 1]]) {
      checkFrame(box, { fov: 40, aspect: 0.2, direction, margin: 1.1 }, { tight: false, epsilon: 1e-7 });
    }
  }
});

test('hidden viewport retains the previous aspect and a later narrow resize gets a fresh fit', () => {
  assert.equal(viewportAspect(0, 0, 1.8), 1.8);
  assert.equal(viewportAspect(320, 0, 1.8), 1.8);
  assert.equal(viewportAspect(NaN, Infinity, NaN), 1);
  assert.equal(viewportAspect(120, 900, 1.8), 120 / 900);
  const box = { min: [-60, -4, -12], max: [60, 18, 12] };
  const wide = checkFrame(box, { aspect: 1.8, direction: [1, 0.5, 1], margin: 1.1 });
  const narrow = checkFrame(box, { aspect: viewportAspect(120, 900, wide.aspect), direction: sub(wide.position, wide.target), margin: 1.1 });
  assert.ok(narrow.distance > wide.distance);
});

test('bad view options recover to a usable frame and malformed bounds fail explicitly', () => {
  const box = { min: [-3, -1, -2], max: [5, 8, 2] };
  for (const aspect of [0, -1, NaN, Infinity, 1e-9, 1e9]) {
    const frame = fitPerspectiveBox(box, { aspect, fov: NaN, direction: [NaN, 0, 0], up: [0, 0, 0], margin: NaN });
    assert.ok([...frame.position, ...frame.target, frame.near, frame.far].every(Number.isFinite));
    assert.ok(frame.near > 0 && frame.far > frame.near);
  }
  for (const invalid of [null, {}, { min: [0, 0, 0], max: [-1, 1, 1] }, { min: [0, 0, NaN], max: [1, 1, 1] }, { min: [-Infinity, 0, 0], max: [Infinity, 1, 1] }]) {
    assert.throws(() => fitPerspectiveBox(invalid), RangeError);
  }
});

test('deterministic varied boxes stay centered and tightly fitted across resize and rotation', () => {
  let seed = 1321;
  const rand = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 60; i++) {
    const min = [rand() * 100 - 50, rand() * 100 - 50, rand() * 100 - 50];
    const max = min.map((x) => x + 0.5 + rand() * 80);
    checkFrame({ min, max }, {
      fov: 20 + rand() * 70, aspect: 0.08 + rand() * 3,
      direction: [rand() - 0.5, rand() - 0.5, rand() - 0.5], margin: 1.02 + rand() * 0.3,
    });
  }
});

test('clip planes retain nearby geometry during a dolly and improve exterior depth precision',async()=>{
 const {geometryDepthRange}=await import('../src/view-framing.mjs');const box={min:[-10,-10,-10],max:[10,10,10]};
 const exterior=geometryDepthRange([0,0,100],[box],100);assert.ok(exterior.near>1&&exterior.near<=90/4);assert.ok(exterior.far>110);
 const close=geometryDepthRange([0,0,11],[box],11);assert.ok(close.near<=.25,'near plane stays in front of the closest geometry');
 const inside=geometryDepthRange([0,0,0],[box],1);assert.equal(inside.near,.1);assert.ok(inside.far>inside.near);
});
