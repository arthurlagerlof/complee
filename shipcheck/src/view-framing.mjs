// Dependency-free perspective framing. Coordinates and distances use the caller's units.
const dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vector = (v) => Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : [v?.x, v?.y, v?.z];
const valid = (v) => v.length === 3 && v.every(Number.isFinite);
const normalize = (v, fallback) => {
  const n = valid(v) ? Math.hypot(...v) : 0;
  return n > 1e-12 ? v.map((x) => x / n) : [...fallback];
};

/** Keep the last real aspect while a pane is hidden (zero size), rather than fitting to 1x1. */
export function viewportAspect(width, height, previous = 1) {
  const ratio = width > 0 && height > 0 ? width / height : NaN;
  return Number.isFinite(ratio) && ratio > 0 ? ratio
    : Number.isFinite(previous) && previous > 0 ? previous : 1;
}

/**
 * Fit every corner of an axis-aligned box, centering its projected bounds on both axes.
 * box.min/max accept [x,y,z] or {x,y,z}. fov is the effective VERTICAL field of view in degrees.
 * direction points FROM target TO camera; up is the camera's reference up vector.
 * margin >= 1 reserves screen space: margin 1.1 puts every corner within +/-1/1.1 NDC.
 * Returns plain arrays position/target/up plus aspect, near/far, distance and camera basis.
 * No input is mutated. Invalid/empty bounds throw RangeError; invalid view options use defaults.
 */
export function fitPerspectiveBox(box, {
  fov = 40, aspect = 1, direction = [0, 0, 1], up = [0, 1, 0], margin = 1.08,
} = {}) {
  const min = vector(box?.min), max = vector(box?.max);
  if (!valid(min) || !valid(max) || min.some((x, i) => x > max[i])) {
    throw new RangeError('A finite, non-empty bounding box is required');
  }
  const center = min.map((x, i) => x / 2 + max[i] / 2);
  const half = max.map((x, i) => (x - min[i]) / 2);
  if (!valid(half)) throw new RangeError('Bounding box extent is too large');
  aspect = viewportAspect(aspect, 1);
  // Ratios outside this range cannot represent a usable pixel viewport. Guard overflow/underflow.
  aspect = Math.max(1e-9, Math.min(1e9, aspect));
  fov = Number.isFinite(fov) ? Math.max(0.01, Math.min(179, fov)) : 40;
  margin = Number.isFinite(margin) ? Math.max(1, margin) : 1.08;
  const back = normalize(vector(direction), [0, 0, 1]);
  let referenceUp = normalize(vector(up), [0, 1, 0]);
  if (Math.hypot(...cross(referenceUp, back)) < 1e-8) {
    // A top/bottom view still needs a stable screen-right vector.
    const axis = back.map(Math.abs).indexOf(Math.min(...back.map(Math.abs)));
    referenceUp = [0, 0, 0]; referenceUp[axis] = 1;
  }
  const right = normalize(cross(referenceUp, back), [1, 0, 0]);
  const screenUp = cross(back, right);
  const corners = [];
  for (const x of [-half[0], half[0]]) for (const y of [-half[1], half[1]]) for (const z of [-half[2], half[2]]) {
    const p = [x, y, z];
    corners.push([dot(p, right), dot(p, screenUp), dot(p, back)]);
  }
  const scale = Math.max(...half) * 2;
  const clearance = Math.max(scale * 1e-4, 1e-6);
  const tanV = Math.tan(fov * Math.PI / 360);
  const limits = [tanV * aspect / margin, tanV / margin];
  let distance = Math.max(...corners.map((p) => p[2])) + clearance;
  // For each axis, the allowed intervals for the lateral camera center must intersect:
  // max(x_i - k*(D-z_i)) <= min(x_j + k*(D-z_j)). Solve all pairs for D.
  for (let axis = 0; axis < 2; axis++) {
    for (const a of corners) for (const b of corners) {
      distance = Math.max(distance, (a[axis] - b[axis]) / (2 * limits[axis]) + (a[2] + b[2]) / 2);
    }
  }
  distance += Math.max(distance, scale, 1) * 1e-12;
  const depths = corners.map((p) => distance - p[2]);
  const offset = [0, 0];
  for (let axis = 0; axis < 2; axis++) {
    // At this distance, find the smallest symmetric projected interval. Its center is
    // generally NOT the world-space box center when corners have different depths.
    let radius = 0;
    for (let i = 0; i < corners.length; i++) for (let j = 0; j < corners.length; j++) {
      radius = Math.max(radius, (corners[i][axis] - corners[j][axis]) / (depths[i] + depths[j]));
    }
    const lo = Math.max(...corners.map((p, i) => p[axis] - radius * depths[i]));
    const hi = Math.min(...corners.map((p, i) => p[axis] + radius * depths[i]));
    offset[axis] = (lo + hi) / 2;
  }
  const target = center.map((x, i) => x + right[i] * offset[0] + screenUp[i] * offset[1]);
  const position = target.map((x, i) => x + back[i] * distance);
  const near = Math.min(...depths) / 2;
  const far = Math.max(...depths) + Math.max(scale * 0.1, Math.max(...depths) * 0.01, clearance);
  if (![...target, ...position, distance, near, far].every(Number.isFinite)) {
    throw new RangeError('View parameters exceed the finite coordinate range');
  }
  return { position, target, up: referenceUp, distance, near, far, aspect, fov, basis: { right, up: screenUp, back } };
}

/** Conservative clip planes that retain nearby geometry and avoid a needlessly huge depth range. */
export function geometryDepthRange(position, boxes, targetDistance=1000) {
  const p=vector(position);if(!valid(p))throw new RangeError('Finite camera position required');
  let nearest=Infinity,farthest=0;
  for(const box of boxes){const min=vector(box.min),max=vector(box.max);if(!valid(min)||!valid(max))continue;
    nearest=Math.min(nearest,Math.sqrt(min.reduce((sum,x,k)=>sum+Math.max(x-p[k],0,p[k]-max[k])**2,0)));
    const far=Math.sqrt(min.reduce((sum,x,k)=>sum+Math.max(Math.abs(x-p[k]),Math.abs(max[k]-p[k]))**2,0));farthest=Math.max(farthest,far);
  }
  const distance=Number.isFinite(targetDistance)&&targetDistance>0?targetDistance:1000;
  return{near:Math.max(0.1,Math.min(distance/8,Number.isFinite(nearest)?nearest/4:distance/8)),far:Math.max(farthest*1.25,distance*1.25,100)};
}
