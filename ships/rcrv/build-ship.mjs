// Builds ships/rcrv/ship.json: a simplified reconstruction of the Oregon State University
// Regional Class Research Vessel (RCRV) for the compliance demo.
// Usage: node ships/rcrv/build-ship.mjs
//
// Provenance policy (see README): every element and value says where it comes from.
//   "public particulars"  published figures (still verified:false, see VERIFY.md)
//   "estimated"           layout reconstructed without the GA sheets (no GA PDF was available locally)
//   "planted test case"   a deliberately non-compliant or missing value used by tests/expected/rcrv.json
// When the GA drawings are available, replace "estimated" geometry with "GA drawing <sheet>".
//
// Coordinates (mm): x from the stern forward, y transverse (centreline = 0, port positive),
// deck elevation above baseline. Element geom is relative to its deck.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const EST = 'estimated';
const PUB = 'public particulars';
const PLANT = 'planted test case (fictional value)';

const LOA = 60650, B = 12500;

// Plan outline of the hull at a deck: transom aft, parallel body, elliptical bow.
function hull({ x0 = 0, x1 = LOA, half = B / 2, transom = 0.94, bowStart = 44000, steps = 8 }) {
  const stb = [[x0, -half * transom], [bowStart, -half]];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stb.push([Math.round(bowStart + (x1 - bowStart) * t), Math.round(-half * Math.sqrt(1 - t * t))]);
  }
  const port = stb.slice(0, -1).reverse().map(([x, y]) => [x, -y]);
  return [...stb, ...port];
}
const rect = (x0, x1, half) => [[x0, -half], [x1, -half], [x1, half], [x0, half]];

const decks = [
  { id: 'LD', name: 'Lower deck / tank top', elevation: 1200, height: 3800,
    outline: hull({ x0: 2500, x1: 58000, half: 5800, transom: 0.85, bowStart: 42000 }), source: EST },
  { id: 'MD', name: 'Main deck (labs, working deck)', elevation: 5000, height: 2700,
    outline: hull({}), source: `${EST}; LOA and beam from ${PUB}` },
  { id: '01', name: '01 level (science and crew berthing)', elevation: 7700, height: 2700,
    outline: hull({ x0: 19000, x1: 58500, half: 6150, transom: 1, bowStart: 45000, steps: 6 }), source: EST },
  { id: '02', name: '02 level (officers, conference)', elevation: 10400, height: 2700,
    outline: rect(23800, 50000, 5600), source: EST },
  { id: '03', name: '03 level (pilothouse)', elevation: 13100, height: 2700,
    outline: rect(34000, 48000, 6250), source: EST },
];

const elements = [];
const el = (id, type, name, deck, [x0, x1], [y0, y1], h, props = {}, extra = {}) =>
  elements.push({ id, type, name, deck, source: EST, geom: { x: x0, y: y0, lx: x1 - x0, ly: y1 - y0, h }, props, ...extra });
const v = (value, source = EST, unit = 'mm', note) => ({ value, unit, source, ...(note ? { note } : {}) });

// ---- Lower deck ----
el('LD-PMR', 'machinery_space', 'Propulsion motor room', 'LD', [8000, 22000], [-4800, 4800], 3600,
  { category_A: false, zone: 'machinery' });
el('LD-ER', 'machinery_space', 'Engine room (diesel generator sets)', 'LD', [22000, 34000], [-5000, 5000], 3600,
  { category_A: true, zone: 'machinery', escape_routes: { value: ['LD-LAD1', 'LD-ET1'], source: EST } });
el('LD-LAD1', 'ladder', 'Engine room ladder to main deck', 'LD', [32600, 33600], [3600, 4400], 3800, { zone: 'machinery' });
el('LD-ET1', 'escape_trunk', 'Emergency escape trunk, engine room', 'LD', [22400, 23400], [-4800, -3800], 3800, { zone: 'machinery' });
el('LD-SLUDGE', 'sludge_tank', 'Sludge tank (oil residues)', 'LD', [34000, 35500], [-900, 900], 1200, { zone: 'tank' });
el('LD-FOP', 'fuel_tank', 'Fuel oil tank MGO, port', 'LD', [35500, 41000], [1000, 5200], 2600, { fuel: 'MGO', zone: 'tank' });
el('LD-FOS', 'fuel_tank', 'Fuel oil tank MGO, starboard', 'LD', [35500, 41000], [-5200, -1000], 2600, { fuel: 'MGO', zone: 'tank' });
el('LD-FW', 'tank', 'Fresh water tank', 'LD', [41000, 45000], [-4500, 4500], 2600, { zone: 'tank' });
el('LD-HOLD', 'space', 'Science hold and stores', 'LD', [45000, 52000], [-4000, 4000], 3400, { zone: 'service' });
el('LD-BT', 'machinery_space', 'Bow thruster room', 'LD', [52000, 55000], [-2400, 2400], 3400, { category_A: false, zone: 'machinery' });

// ---- Main deck ----
el('MD-WD', 'space', 'Aft working deck', 'MD', [0, 20000], [-5900, 5900], 60, { zone: 'open_deck' });
el('MD-D1', 'door', 'Weathertight door, lab corridor to working deck', 'MD', [20000, 20100], [-450, 450], 2000,
  { weathertight: true, clear_width: 800, sill_height: v(300, PLANT) },
  { note: 'Planted: sill 300 mm, below the Load Line minimum.' });
el('MD-D3', 'door', 'Weathertight door, hangar', 'MD', [20000, 20100], [-5000, -2000], 2400,
  { weathertight: true, clear_width: 3000, sill_height: v(450) });
el('MD-C1', 'corridor', 'Main deck lab corridor', 'MD', [20100, 44000], [-425, 425], 150,
  { clear_width: v(850, PLANT), dead_end_length: 0, zone: 'circulation' },
  { note: 'Planted: clear width 850 mm, below the FSS Code minimum.' });
el('MD-HANGAR', 'space', 'Hangar / staging bay', 'MD', [20100, 25500], [-6000, -425], 2600, { zone: 'working' });
el('MD-WETLAB', 'space', 'Wet lab', 'MD', [20100, 25500], [425, 6000], 2600, { zone: 'lab' });
el('MD-BALTIC', 'space', 'Baltic room (CTD launch)', 'MD', [25500, 29500], [-6000, -425], 2600, { zone: 'working' });
el('MD-D2', 'door', 'Weathertight side door, Baltic room', 'MD', [26500, 28000], [-6100, -6000], 2400,
  { weathertight: true, clear_width: 1500 },
  { note: 'Planted: sill height not given on the drawing.' });
el('MD-DRYLAB', 'space', 'Dry lab', 'MD', [29500, 34000], [-6000, -425], 2600, { zone: 'lab' });
el('MD-MAINLAB', 'space', 'Main lab', 'MD', [25500, 34000], [425, 6000], 2600, { zone: 'lab' });
el('MD-ELEC', 'space', 'Electronics / computer lab', 'MD', [34000, 38000], [-6000, -425], 2600, { zone: 'lab' });
el('MD-HYDRO', 'space', 'Hydro lab', 'MD', [34000, 38000], [425, 6000], 2600, { zone: 'lab' });
el('MD-GALLEY', 'space', 'Galley', 'MD', [38000, 44000], [-6000, -425], 2600, { zone: 'service' });
el('MD-MESS', 'space', 'Mess room', 'MD', [38000, 44000], [425, 6000], 2600, { zone: 'accommodation' });
el('MD-ST1', 'stair', 'Main stair, main deck to 01 level', 'MD', [44000, 46500], [-1250, 1250], 2700,
  { clear_width: 1000, zone: 'circulation' });
el('MD-STORE', 'space', 'Science stores', 'MD', [46500, 52000], [-5000, 5000], 2600, { zone: 'service' });
el('MD-BOSUN', 'space', 'Bosun store', 'MD', [52000, 56000], [-3500, 3500], 2600, { zone: 'service' });
el('01-EXT1', 'stair', 'External stair, 01 level aft to working deck (starboard)', 'MD', [17000, 19000], [-5200, -4100], 2700,
  { clear_width: 900, zone: 'circulation' }, { note: 'Exists in the model but is not connected to the science berthing area.' });

// ---- 01 level ----
el('01-GR1', 'guard_rail', 'Guard rail, 01 level aft (above working deck)', '01', [19000, 19100], [-6000, 6000], 950,
  { height: v(37.4, PLANT, 'in', 'imperial value as on US drawings') },
  { note: 'Planted: 37.4 in (950 mm), below 1 m.' });
el('01-SR1', 'space', 'Science stateroom 1', '01', [21500, 24000], [-6000, -3550], 2500, { zone: 'accommodation', berths: 2 });
el('01-SR2', 'space', 'Science stateroom 2', '01', [24000, 26500], [-6000, -3550], 2500, { zone: 'accommodation', berths: 2 });
el('01-SR3', 'space', 'Science stateroom 3', '01', [26500, 29000], [-6000, -3550], 2500, { zone: 'accommodation', berths: 2 });
el('01-C2', 'corridor', 'Science berthing side corridor (starboard)', '01', [21500, 29000], [-3550, -2450], 150,
  { clear_width: 1100, dead_end_length: v(7500, PLANT), zone: 'circulation' },
  { note: 'Planted: 7.5 m dead end (aft end has no exit).' });
el('01-SR4', 'space', 'Science stateroom 4', '01', [21500, 25250], [-2450, -600], 2500, { zone: 'accommodation', berths: 2 });
el('01-SR5', 'space', 'Science stateroom 5', '01', [25250, 29000], [-2450, -600], 2500, { zone: 'accommodation', berths: 2 });
el('01-C3', 'corridor', 'Cross passage to 01 main corridor', '01', [29000, 30100], [-3550, -600], 150,
  { clear_width: 1100, dead_end_length: 0, zone: 'circulation' });
el('01-LOUNGE', 'space', 'Science lounge', '01', [21500, 26000], [600, 6000], 2500, { zone: 'accommodation' });
el('01-LAUNDRY', 'space', 'Laundry', '01', [26000, 30100], [3000, 6000], 2500, { zone: 'service' });
el('01-SR6', 'space', 'Science stateroom 6', '01', [26000, 30100], [600, 3000], 2500, { zone: 'accommodation', berths: 2 });
el('01-C1', 'corridor', '01 level main corridor', '01', [30100, 44000], [-600, 600], 150,
  { clear_width: 1200, dead_end_length: 0, zone: 'circulation' });
for (let i = 0; i < 4; i++) {
  const x0 = 30100 + i * 3475, x1 = x0 + 3475;
  el(`01-CR${i + 1}`, 'space', `Crew stateroom ${i + 1}`, '01', [x0, x1], [600, 6000], 2500, { zone: 'accommodation', berths: 2 });
  el(`01-CR${i + 5}`, 'space', `Crew stateroom ${i + 5}`, '01', [x0, x1], [-6000, -600], 2500, { zone: 'accommodation', berths: i === 3 ? 1 : 2 });
}
el('01-ST1', 'stair', 'Main stair, 01 level to 02 level', '01', [44000, 46500], [-1250, 1250], 2700, { clear_width: 1000, zone: 'circulation' });
el('01-ESC1', 'ladder', 'Escape ladder, 01 level forward to main deck', '01', [46500, 47500], [3000, 4000], 2700, { zone: 'circulation' });
el('02-EXT1', 'stair', 'External stair, 02 level aft to 01 level (port)', '01', [21500, 23500], [5000, 6000], 2700,
  { clear_width: 900, zone: 'circulation' });
el('01-Z1', 'escape_zone', 'Science berthing area, 01 level aft', '01', [21500, 30100], [-6000, -600], 2500,
  { escape_routes: v(['MD-ST1'], PLANT, undefined) },
  { virtual: true, note: 'Planted: only the main stair forward; the aft external stair 01-EXT1 is not reachable from this area.' });
el('01-Z2', 'escape_zone', 'Crew berthing area, 01 level forward', '01', [30100, 44000], [-6000, 6000], 2500,
  { escape_routes: ['MD-ST1', '01-ESC1'] }, { virtual: true });

// ---- 02 level ----
el('02-GR1', 'guard_rail', 'Guard rail, 02 level aft', '02', [23800, 23900], [-5600, 5600], 1000, { height: 1000 });
el('02-CONF', 'space', 'Science conference room', '02', [23900, 26000], [-5500, 5500], 2500, { zone: 'accommodation' });
el('02-C1', 'corridor', '02 level corridor', '02', [26000, 44000], [-600, 600], 150,
  { clear_width: 1000, dead_end_length: 4000, zone: 'circulation' });
for (let i = 0; i < 3; i++) {
  const x0 = 26000 + i * 6000, x1 = x0 + 6000;
  el(`02-SR${i + 1}`, 'space', `Officer stateroom ${i + 1}`, '02', [x0, x1], [600, 5500], 2500, { zone: 'accommodation', berths: 1 });
  el(`02-SR${i + 4}`, 'space', `Officer stateroom ${i + 4}`, '02', [x0, x1], [-5500, -600], 2500, { zone: 'accommodation', berths: 1 });
}
el('02-ST1', 'stair', 'Stair, 02 level to pilothouse', '02', [44000, 46000], [-1000, 1000], 2700,
  { clear_width: v(31.5, PLANT, 'in', 'imperial value as on US drawings'), zone: 'circulation' },
  { note: 'Planted: 31.5 in (800 mm), below 900 mm.' });
el('02-Z1', 'escape_zone', 'Officer berthing area, 02 level', '02', [26000, 44000], [-5500, 5500], 2500,
  { escape_routes: ['01-ST1', '02-EXT1'] }, { virtual: true });

// ---- 03 level ----
el('03-WH', 'space', 'Pilothouse', '03', [36000, 47000], [-4500, 4500], 2500, { zone: 'control' });
el('03-GR1', 'guard_rail', 'Guard rail, port bridge wing', '03', [34000, 36000], [6150, 6250], 1070, { height: 1070 });
el('03-GR2', 'guard_rail', 'Guard rail, starboard bridge wing', '03', [34000, 36000], [-6250, -6150], 1070, { height: 1070 });

const ship = {
  name: 'OSU Regional Class Research Vessel (RCRV), reconstructed',
  units: 'mm',
  source: EST,
  provenance_note: 'No GA drawing sheets were available locally. Layout is a simplified reconstruction; particulars are public figures still to verify (VERIFY.md).',
  ship: {
    name: 'Regional Class Research Vessel (Oregon State University)',
    type: 'research',
    operating_area: ['US'],
    propulsion: v('diesel-electric', PUB, undefined),
    length_overall: v(LOA, PUB, 'mm', 'about 60.65 m (199 ft); OSU press material says 193 ft'),
    beam: v(B, PUB, 'mm', '12.5 m (41 ft)'),
    draft: v(3810, PUB, 'mm', 'about 3.81 m'),
    berths: v(31, PUB, undefined, '16 science, 2 technicians, 13 crew'),
    gross_tonnage: v(1200, EST, undefined, 'order of magnitude only; any 60 m vessel is far above the 400 GT threshold'),
    class_society: v('DNV', 'assumed for the demo (the real class society of the RCRV is not confirmed here)', undefined),
    fuel: 'MGO',
    source: PUB,
  },
  decks,
  hull: { deck: 'MD', source: EST },
  demo: { focus: '01-GR1', fix: { prop: 'height', value: 1000, unit: 'mm' } },
  elements,
};

const out = fileURLToPath(new URL('./ship.json', import.meta.url));
fs.writeFileSync(out, JSON.stringify(ship, null, 1) + '\n');
console.log(`Wrote ${out}: ${decks.length} decks, ${elements.length} elements`);
