// Large general arrangement as DXF for load tests: decks with a spine corridor, cross corridors, rooms, doors (blocks
// with attributes), stairs and a muster station.   node tools/autocad/make_large_dxf.mjs out.dxf [decks=5] [roomsPerDeck=3000]
import fs from 'node:fs';
const [out = 'large.dxf', decksArg = '5', roomsArg = '3000'] = process.argv.slice(2);
const DECKS = Number(decksArg), ROOMS = Number(roomsArg);
const p = (c, v) => `${c}\n${v}\n`;
let h = 0x100;
const handle = () => (h++).toString(16).toUpperCase();
let ents = '';
const rect = (layer, x0, y0, x1, y1, extra = '') => { ents += p(0, 'LWPOLYLINE') + p(5, handle()) + p(8, layer) + p(90, 4) + p(70, 1) + extra + p(10, x0) + p(20, y0) + p(10, x1) + p(20, y0) + p(10, x1) + p(20, y1) + p(10, x0) + p(20, y1); };
const text = (layer, x, y, s) => { ents += p(0, 'MTEXT') + p(5, handle()) + p(8, layer) + p(10, x) + p(20, y) + p(40, 150) + p(1, s); };
const ROOM = 3000, DEPTH = 4000, CORR = 1200, perSide = Math.ceil(ROOMS / 2), ROWS = Math.max(1, Math.round(Math.sqrt(perSide / 40)));
const perRow = Math.ceil(perSide / ROWS), LEN = perRow * ROOM, PITCH = 2 * DEPTH + CORR;
for (let d = 0; d < DECKS; d++) {
  const id = `D${d + 1}`, oy = d * (ROWS * PITCH + 20000);
  rect(`${id}-OUTLINE`, -8000, oy - 2000, LEN + 4000, oy + ROWS * PITCH + 2000);
  ents += p(0, 'POINT') + p(5, handle()) + p(8, `${id}-OUTLINE`) + p(10, 0) + p(20, oy);
  text(`${id}-OUTLINE`, -7000, oy - 1500, `NAME=Deck ${d + 1}\\PELEVATION=${d * 2800}\\PHEIGHT=2800`);
  // spine corridor along x = -1500..0 joining all rows; stair at its end; muster station on deck 1
  rect(`${id}-CORRIDOR`, -1500, oy, 0, oy + ROWS * PITCH);
  rect(`${id}-STAIR`, -4000, oy, -1500, oy + 2500, p(39, 2800)); text(`${id}-STAIR`, -3500, oy + 1000, 'CLEAR_WIDTH=1000mm');
  rect(`${id}-STAIR`, -4000, oy + ROWS * PITCH - 2500, -1500, oy + ROWS * PITCH, p(39, 2800));
  if (d === 0) { rect(`${id}-MUSTER`, -8000, oy + 3000, -4000, oy + 9000); text(`${id}-MUSTER`, -7000, oy + 5000, 'Muster station\\PZONE=open_deck'); rect(`${id}-CORRIDOR`, -4000, oy + 3000, -1500, oy + 4500); }
  let n = 0;
  for (let r = 0; r < ROWS; r++) {
    const y = oy + r * PITCH + DEPTH;
    rect(`${id}-CORRIDOR`, 0, y, LEN, y + (r % 7 === 3 ? 850 : CORR)); // every 7th corridor too narrow
    for (let i = 0; i < perRow && n < ROOMS; i++) for (const side of [0, 1]) {
      if (n >= ROOMS) break; n++;
      const y0 = side ? y + CORR : y - DEPTH, x0 = i * ROOM;
      rect(`${id}-SPACE`, x0, y0, x0 + ROOM, y0 + DEPTH); text(`${id}-SPACE`, x0 + 500, y0 + 2000, `Cabin ${id}-${n}`);
      if (i % 10 === 0) { ents += p(0, 'INSERT') + p(5, handle()) + p(66, 1) + p(8, `${id}-DOOR`) + p(2, 'DOOR') + p(10, x0 + 1000) + p(20, side ? y + CORR - 50 : y - 50) + p(0, 'ATTRIB') + p(8, `${id}-DOOR`) + p(10, 0) + p(20, 0) + p(40, 100) + p(1, i % 50 === 0 ? '300mm' : '400mm') + p(2, 'SILL_HEIGHT') + p(0, 'ATTRIB') + p(8, `${id}-DOOR`) + p(10, 0) + p(20, 0) + p(40, 100) + p(1, 'YES') + p(2, 'WEATHERTIGHT') + p(0, 'SEQEND'); }
    }
  }
}
text('COMPLEE-SHIP', 0, -6000, 'NAME=Large test ship\\PTYPE=passenger\\PLENGTH_OVERALL=250m\\PCLASS_SOCIETY=DNV');
const block = p(0, 'BLOCK') + p(8, '0') + p(2, 'DOOR') + p(70, 2) + p(10, 0) + p(20, 0) + p(0, 'LWPOLYLINE') + p(8, '0') + p(90, 4) + p(70, 1) + p(10, 0) + p(20, 0) + p(10, 900) + p(20, 0) + p(10, 900) + p(20, 100) + p(10, 0) + p(20, 100) + p(0, 'ENDBLK');
fs.writeFileSync(out, p(0, 'SECTION') + p(2, 'HEADER') + p(9, '$ACADVER') + p(1, 'AC1024') + p(9, '$INSUNITS') + p(70, 4) + p(0, 'ENDSEC') + p(0, 'SECTION') + p(2, 'BLOCKS') + block + p(0, 'ENDSEC') + p(0, 'SECTION') + p(2, 'ENTITIES') + ents + p(0, 'ENDSEC') + p(0, 'EOF'));
console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
