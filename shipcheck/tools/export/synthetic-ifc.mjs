// Synthetic IFC4 file for tests and demos of the IFC import: a steel frame with slabs, walls, doors, a stair,
// railings and spaces on several storeys. Plain boxes (extruded rectangles), millimetres. No external data.
//
//   node tools/export/synthetic-ifc.mjs <out.ifc> [storeys=6]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

export function syntheticIfc({ storeys = 6, nx = 12, ny = 7, bay = 6000, height = 3600 } = {}) {
  const lines = [];
  let n = 0, g = 0;
  const add = (s) => { lines.push(`#${++n}=${s};`); return `#${n}`; };
  const guid = () => { let v = ++g, s = ''; for (let i = 0; i < 22; i++) { s = CHARS[v % 64] + s; v = Math.floor(v / 64); } return `'${s}'`; };
  const f = (v) => (Number.isInteger(v) ? `${v}.` : String(v));

  const origin = add('IFCCARTESIANPOINT((0.,0.,0.))');
  const up = add('IFCDIRECTION((0.,0.,1.))');
  const xdir = add('IFCDIRECTION((1.,0.,0.))');
  const world = add(`IFCAXIS2PLACEMENT3D(${origin},${up},${xdir})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${world},$)`);
  const mm = add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const units = add(`IFCUNITASSIGNMENT((${mm}))`);
  const project = add(`IFCPROJECT(${guid()},$,'Synthetic frame',$,$,$,$,(${ctx}),${units})`);
  const place0 = add(`IFCLOCALPLACEMENT($,${world})`);
  const building = add(`IFCBUILDING(${guid()},$,'Test building',$,$,${place0},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${project},(${building}))`);

  // A box with its lower corner at (x, y, z).
  function shape(x, y, z, lx, ly, h) {
    const p = add(`IFCCARTESIANPOINT((${f(x)},${f(y)},${f(z)}))`);
    const ax = add(`IFCAXIS2PLACEMENT3D(${p},$,$)`);
    const lp = add(`IFCLOCALPLACEMENT($,${ax})`);
    const c = add(`IFCCARTESIANPOINT((${f(lx / 2)},${f(ly / 2)}))`);
    const a2 = add(`IFCAXIS2PLACEMENT2D(${c},$)`);
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${a2},${f(lx)},${f(ly)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${prof},${world},${up},${f(h)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${solid}))`);
    const pds = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
    return `${lp},${pds}`;
  }
  const el = (cls, name, box, tail = '$,$') => add(`${cls}(${guid()},$,'${name}',$,$,${shape(...box)},${tail})`);

  const storeyRefs = [];
  const count = {};
  const W = (nx - 1) * bay, D = (ny - 1) * bay;
  for (let s = 0; s < storeys; s++) {
    const z = s * height;
    const storey = add(`IFCBUILDINGSTOREY(${guid()},$,'Level ${s + 1}',$,$,${place0},$,$,.ELEMENT.,${f(z)})`);
    storeyRefs.push(storey);
    const members = [];
    const put = (cls, name, box, tail) => { members.push(el(cls, name, box, tail)); count[cls] = (count[cls] || 0) + 1; };
    put('IFCSLAB', `Slab L${s + 1}`, [-300, -300, z - 250, W + 600, D + 600, 250], '$,.FLOOR.');
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) put('IFCCOLUMN', `Column ${String.fromCharCode(65 + i)}${j + 1} L${s + 1}`, [i * bay - 150, j * bay - 150, z, 300, 300, height - 250]);
    for (let i = 0; i + 1 < nx; i++) for (let j = 0; j < ny; j++) put('IFCBEAM', `Beam X ${i + 1}-${j + 1} L${s + 1}`, [i * bay + 150, j * bay - 100, z + height - 700, bay - 300, 200, 450]);
    for (let i = 0; i < nx; i++) for (let j = 0; j + 1 < ny; j++) put('IFCBEAM', `Beam Y ${i + 1}-${j + 1} L${s + 1}`, [i * bay - 100, j * bay + 150, z + height - 700, 200, bay - 300, 450]);
    // A corridor along the middle with rooms on both sides.
    const cy = Math.floor(ny / 2) * bay;
    for (const side of [-1, 1]) put('IFCWALL', `Corridor wall ${side < 0 ? 'south' : 'north'} L${s + 1}`, [0, cy + side * 900 - 60, z, W, 120, height - 700]);
    for (let i = 1; i + 1 < nx; i += 2) {
      put('IFCDOOR', `Door ${i} L${s + 1}`, [i * bay + 1000, cy - 960 - 20, z, 900, 160, 2100], `$,2100.,900.,.DOOR.,.SINGLE_SWING_LEFT.,$`);
      // The first door of each storey is a fire door: FireRating in Pset_DoorCommon, as BIM tools export it.
      if (i === 1) {
        const door = members[members.length - 1];
        const prop = add("IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('A-60'),$)");
        const pset = add(`IFCPROPERTYSET(${guid()},$,'Pset_DoorCommon',$,(${prop}))`);
        add(`IFCRELDEFINESBYPROPERTIES(${guid()},$,$,$,(${door}),${pset})`);
      }
      put('IFCSPACE', `Room ${s + 1}.${i}`, [i * bay, 0, z, 2 * bay, cy - 960, height - 700], `'Room ${s + 1}.${i}',.ELEMENT.,.INTERNAL.,$`);
    }
    put('IFCSTAIR', `Stair L${s + 1}`, [W - 4500, cy + 1100, z, 4000, 1200, height], '$,.STRAIGHT_RUN_STAIR.');
    put('IFCRAILING', `Railing L${s + 1}`, [W - 4500, cy + 2300, z, 4000, 50, 1100], '$,.GUARDRAIL.');
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,$,$,(${members.join(',')}),${storey})`);
  }
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${building},(${storeyRefs.join(',')}))`);

  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');
FILE_NAME('synthetic-frame.ifc','2026-01-01T00:00:00',(''),(''),'Complee synthetic-ifc','Complee','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  return { text, count, elements: Object.values(count).reduce((a, b) => a + b, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = process.argv[2];
  if (!out) { console.error('Usage: node tools/export/synthetic-ifc.mjs <out.ifc> [storeys]'); process.exit(1); }
  const r = syntheticIfc({ storeys: Number(process.argv[3]) || 6 });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, r.text);
  console.log(`${out}: ${r.elements} elements`, r.count);
}
