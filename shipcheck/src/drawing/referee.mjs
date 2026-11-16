// Independent geometry check of a drawing conversion. It does not trust the interpreter: it only looks at the
// finished model and recon and asks whether they describe a physically consistent ship arrangement. It never
// changes anything and never decides compliance (that is the rule checker's job); it lists what an engineer
// should look at before relying on the converted model.
//
// referee(model, recon) -> { ok, issues: [{ level: 'error' | 'warning', what, ids, message }] }
//   error:   the converted data contradicts itself (a value the checker reads cannot be right)
//   warning: something is unusual and worth a look on the drawing (door off a wall, room outside the deck)
import { usableGeometry } from '../checker.mjs';

const TOL_MM = 100;              // drawing tolerance for "inside" and "on" tests
const DOOR_WIDTH_MM = [500, 2000];
const DECK_HEIGHT_MM = [1500, 8000];
const OVERLAP_SHARE = 0.05;      // rooms may touch along walls, not share more than 5 % of the smaller one

const num = (v) => (v != null && typeof v === 'object' && 'value' in v ? v.value : v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function polygonArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function edgeDist(p, poly) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}
// Inside, or within the tolerance of the boundary (points drawn on the outline line itself).
const within = (pt, poly) => inside(pt, poly) || edgeDist(pt, poly) <= TOL_MM;
const boxOf = (poly) => poly.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);

// A room is its polygon minus its holes (a tank or stair trunk inside an engine room is not part of it).
const inRoom = (pt, room) => inside(pt, room.polygon) && !(room.holes ?? []).some((h) => inside(pt, h));
const roomArea = (room) => Math.max(0, polygonArea(room.polygon) - (room.holes ?? []).reduce((s, h) => s + polygonArea(h), 0));

// Shared area of two rooms, estimated on a 24 x 24 sample grid over their common box (exact enough to tell
// "touching" from "overlapping", without a polygon clipping library).
function overlapArea(r, s) {
  const a = boxOf(r.polygon), b = boxOf(s.polygon);
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  if (x1 - x0 <= TOL_MM || y1 - y0 <= TOL_MM) return 0;
  const n = 24, dx = (x1 - x0) / n, dy = (y1 - y0) / n;
  let hits = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const pt = [x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy];
    if (inRoom(pt, r) && inRoom(pt, s)) hits++;
  }
  return hits * dx * dy;
}

export function referee(model, recon = {}) {
  const issues = [];
  const add = (level, what, ids, message) => issues.push({ level, what, ids, message });
  const decks = [...(model?.decks ?? [])].sort((a, b) => a.elevation - b.elevation);
  const deckById = new Map(decks.map((d) => [d.id, d]));
  const elements = model?.elements ?? [];
  const byId = new Map();

  // ---- the model itself: ids and geometry the checker reads ----
  for (const el of elements) {
    if (byId.has(el.id)) add('error', 'duplicate_id', [el.id], `Element id ${el.id} is used twice.`);
    byId.set(el.id, el);
    if (!deckById.has(el.deck)) add('error', 'no_deck', [el.id], `${el.id} is on deck "${el.deck}", which the model does not have.`);
    if (!usableGeometry(el.geom)) add('error', 'geometry', [el.id], `${el.id} has no usable size or position.`);
  }
  for (const list of ['rooms', 'walls', 'doors', 'stairs', 'ladders', 'windows', 'equipment']) {
    for (const item of recon[list] ?? []) {
      if (item.id && !byId.has(item.id)) add('error', 'recon_orphan', [item.id], `${item.id} is drawn in 3D but is not an element of the model.`);
    }
  }

  // ---- decks: order and heights ----
  // A deck that is open throughout (a wheelhouse roof) is only as high as its rail: no deck-height check.
  const openDeck = (deckId) => {
    const own = (recon.rooms ?? []).filter((r) => r.deck === deckId).map((r) => byId.get(r.id));
    return own.length > 0 && own.every((el) => num(el?.props?.zone) === 'open_deck');
  };
  for (let i = 0; i < decks.length; i++) {
    const d = decks[i], h = d.height;
    if (finite(h) && !openDeck(d.id) && (h < DECK_HEIGHT_MM[0] || h > DECK_HEIGHT_MM[1])) add('warning', 'deck_height', [], `Deck ${d.name} is ${Math.round(h)} mm high: unusual for a ship deck (${DECK_HEIGHT_MM[0]}–${DECK_HEIGHT_MM[1]} mm). Check its elevation and the one above.`);
    const next = decks[i + 1];
    if (next && finite(h) && Math.abs(d.elevation + h - next.elevation) > TOL_MM && d.elevation + h > next.elevation) {
      add('warning', 'deck_overlap', [], `Deck ${d.name} (${Math.round(d.elevation)} + ${Math.round(h)} mm) reaches above deck ${next.name} (${Math.round(next.elevation)} mm).`);
    }
    if ((d.outline?.length ?? 0) < 3) add('warning', 'deck_outline', [], `Deck ${d.name} has no outline: rooms on it cannot be checked against the deck edge.`);
  }

  // ---- rooms: inside their deck, not overlapping each other, height within the deck ----
  const rooms = recon.rooms ?? [];
  const roomsByDeck = new Map();
  for (const r of rooms) {
    if (!roomsByDeck.has(r.deck)) roomsByDeck.set(r.deck, []);
    roomsByDeck.get(r.deck).push(r);
    const d = deckById.get(r.deck);
    if (d?.outline?.length >= 3) {
      const out = r.polygon.filter((p) => !within(p, d.outline)).length;
      if (out) add('warning', 'room_outside_deck', [r.id], `${byId.get(r.id)?.name ?? r.id}: ${out} of ${r.polygon.length} corners lie outside the outline of deck ${d.name}.`);
    }
    // A named small space (a lub oil tank with its label) is real; an unnamed scrap of that size is not a room.
    const el = byId.get(r.id);
    const named = el?.name && !/^unnamed\b/i.test(el.name);
    if (!named && roomArea(r) < 0.5e6) add('warning', 'room_tiny', [r.id], `${el?.name ?? r.id} is smaller than 0.5 m² and has no name: probably a symbol or furniture read as a room.`);
    if (d && finite(r.z0) && finite(r.z1) && (r.z0 < d.elevation - TOL_MM || r.z1 > d.elevation + (d.height ?? 0) + TOL_MM)) {
      add('warning', 'room_height', [r.id], `${byId.get(r.id)?.name ?? r.id} extends beyond the height of deck ${d.name}.`);
    }
  }
  for (const list of roomsByDeck.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const shared = overlapArea(a, b);
      if (shared > OVERLAP_SHARE * Math.min(roomArea(a), roomArea(b))) {
        add('warning', 'room_overlap', [a.id, b.id], `${byId.get(a.id)?.name ?? a.id} and ${byId.get(b.id)?.name ?? b.id} overlap by about ${(shared / 1e6).toFixed(1)} m².`);
      }
    }
  }

  // ---- doors: plausible width, on a wall, between rooms ----
  const wallsByDeck = new Map();
  for (const w of recon.walls ?? []) { if (!wallsByDeck.has(w.deck)) wallsByDeck.set(w.deck, []); wallsByDeck.get(w.deck).push(w); }
  for (const door of recon.doors ?? []) {
    const el = byId.get(door.id);
    const width = num(el?.props?.clear_width) ?? door.width;
    if (finite(width) && (width < DOOR_WIDTH_MM[0] || width > DOOR_WIDTH_MM[1])) add('warning', 'door_width', [door.id], `${door.id}: ${Math.round(width)} mm wide, outside the usual ${DOOR_WIDTH_MM[0]}–${DOOR_WIDTH_MM[1]} mm. Probably not a door, or the scale is wrong.`);
    const walls = wallsByDeck.get(door.deck) ?? [];
    const onWall = walls.some((w) => segDist(door.hinge, w.a, w.b) <= (w.thickness ?? 0) / 2 + TOL_MM);
    if (walls.length && !onWall) add('warning', 'door_off_wall', [door.id], `${door.id}: the hinge is not on any wall of its deck. Check it on the drawing.`);
    const connects = el?.props?.connects;
    const list = Array.isArray(connects?.value) ? connects.value : Array.isArray(connects) ? connects : null;
    if (list && !list.length) add('warning', 'door_no_room', [door.id], `${door.id} leads into no recognised room.`);
  }

  // ---- stairs and ladders: they must end at a deck ----
  const elevations = decks.map((d) => d.elevation);
  for (const s of [...(recon.stairs ?? []), ...(recon.ladders ?? [])]) {
    if (!finite(s.z1)) continue;
    if (!elevations.some((e) => Math.abs(e - s.z1) <= TOL_MM) && !decks.some((d) => finite(d.height) && Math.abs(d.elevation + d.height - s.z1) <= TOL_MM)) {
      add('warning', 'stair_end', [s.id], `${s.id} ends at ${Math.round(s.z1)} mm, which is not the level of any deck.`);
    }
  }

  // ---- walls: inside the deck outline (shell walls lie on it) ----
  for (const [deckId, walls] of wallsByDeck) {
    const d = deckById.get(deckId);
    if (!(d?.outline?.length >= 3)) continue;
    const out = walls.filter((w) => !within(w.a, d.outline) || !within(w.b, d.outline));
    if (out.length) add('warning', 'wall_outside_deck', out.slice(0, 20).map((w) => w.id), `${out.length} wall${out.length === 1 ? '' : 's'} on deck ${d.name} reach outside the deck outline.`);
  }

  // ---- values the checker reads must fit the drawn element ----
  // "Across" is perpendicular to the walking direction: for a stair that is across its `dir` (a short flight can be
  // longer across than along), otherwise the narrower side of the box.
  const stairDir = new Map((recon.stairs ?? []).map((s) => [s.id, s.dir]));
  for (const el of elements) {
    const cw = num(el.props?.clear_width);
    if (!finite(cw) || !usableGeometry(el.geom) || !['corridor', 'stair'].includes(el.type)) continue;
    const dir = stairDir.get(el.id);
    const across = dir && Math.abs(dir[0]) + Math.abs(dir[1]) > 0
      ? Math.abs(dir[0]) * el.geom.ly + Math.abs(dir[1]) * el.geom.lx // along x → across is y, and vice versa
      : Math.min(el.geom.lx, el.geom.ly);
    if (cw > across + TOL_MM) add('error', 'width_exceeds_box', [el.id], `${el.id}: clear width ${Math.round(cw)} mm is wider than the drawn ${el.type} (${Math.round(across)} mm across).`);
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues };
}
