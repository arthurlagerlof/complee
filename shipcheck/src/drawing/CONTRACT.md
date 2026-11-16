# Drawing → 3D: module contracts

A technical drawing of a ship (general arrangement: a profile and deck plans, optionally sections) becomes a
checkable ship/1 model plus real 3D geometry for the viewer. Principle, as in the rest of Complee: **code measures,
nothing is guessed silently**. Every value says where it comes from (sheet, view, entity ids) and whether it was
measured from the drawing, read from text on the drawing, given by the user, or assumed (then it says so). AI is not
used in this pipeline.

All modules are pure ES modules (no DOM, no Node APIs) so they run in the browser, in a Web Worker and in Node tests,
except `read-pdf.mjs`, which takes the pdf.js module as an argument (as `ifc-convert.mjs` takes web-ifc).

```
file ──read-dxf / read-pdf / read-svg──▶ Sheet ──views.mjs──▶ View[] ──interpret.mjs──▶ { model, recon, report }
                                                                                   │
                                                              mesh.mjs ◀───────────┘  ──▶ geometry (viewer)
convert.mjs: the whole chain in one call, with user overrides.
```

## 1. Sheet (`sheet.mjs`): what every reader returns

Coordinates are in sheet units, **y up**. A DXF is usually drawn 1:1 in mm (sheet unit = model mm); a PDF is in
points on paper (1 pt = 0.3528 mm of paper; the drawing scale turns that into model mm).

```js
Sheet = {
  source: { file, format: 'dxf' | 'pdf' | 'svg', page: 1, pages: 1 },
  unit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'pt' | 'px',   // what one sheet unit is
  unitStated: boolean,          // the file states the unit (DXF $INSUNITS); false = assumed
  paper: boolean,               // true: coordinates are paper (PDF/SVG): a drawing scale is needed for model mm
  bbox: [x0, y0, x1, y1],
  paths: [{
    id: 'p123',                 // stable within the sheet
    pts: [[x, y], ...],         // polyline (arcs and curves are tessellated here as well)
    closed: boolean,
    arc: { c: [x, y], r, a0, a1 } | undefined,   // degrees, counter-clockwise from a0 to a1, for ARC/CIRCLE entities
                                                  // and for PDF/SVG curves that are circular arcs within 1 %
    width: number,              // stroke width in sheet units (0 = hairline / unknown)
    color: '#rrggbb' | null,
    dash: boolean,              // dashed / dash-dot (centre lines, hidden lines)
    fill: boolean,              // a filled shape (PDF fill, DXF SOLID/HATCH boundary)
    stroke: boolean,
    layer: string | null,       // DXF layer, PDF optional-content group, SVG group id
    block: string | null,       // DXF block name the entity came from (after expansion), else null
  }],
  texts: [{ id: 't12', text, at: [x, y], height, angle /* deg */, layer, box: [x0, y0, x1, y1] }],
  warnings: [string],
}
```

## 2. Views (`views.mjs`)

`findViews(sheet) -> View[]`: splits the sheet into the separate drawings on it and says what each is.

```js
View = {
  id: 'v1',
  kind: 'profile' | 'plan' | 'section' | 'title' | 'table' | 'other',
  confidence: 0..1,
  box: [x0, y0, x1, y1],        // sheet units
  title: string | null,         // e.g. "MAIN DECK", "PROFILE", "SECTION AT FR 24"
  titleText: 't45' | null,      // text id the title came from
  deckName: string | null,      // for plans: the deck it shows
  halfPlan: boolean,            // only one side of the centreline is drawn
  centreline: { y } | null,     // plan: sheet y of the centreline (dash-dot line or symmetry axis)
  baseline: { y } | null,       // profile/section: sheet y of the baseline / keel
  bow: 'right' | 'left' | null, // which way the bow points in this view
  xRange: [x0, x1] | null,      // sheet x of aft end and forward end of the ship in this view
  paths: ['p1', ...], texts: ['t1', ...],
  why: [string],                // evidence for kind/deck/bow, shown to the user
}
```

## 3. Interpretation (`interpret.mjs`)

`interpret(sheet, views, overrides = {}) -> { model, recon, report }`

`overrides` (from the user, all optional):
```js
{ scale: 100 /* 1:100 */, mmPerUnit, bow: 'right' | 'left',
  views: { v3: { kind, deckName, elevation /* mm above baseline */, height, ignore: true } },
  shipName }
```

**Model** = ship/1 (`checker.mjs` `normalizeModel` must accept it): `units: 'mm'`, model x forward from the aft end
(or from the aft perpendicular if found), model y to port (+) from the centreline, deck elevation above the baseline.
Decks: `{ id, name, elevation, height, outline (full breadth, closed, mm), source }`. Elements: `{ id, type, name,
deck, geom: { x, y, z, lx, ly, h } (bounding box, z relative to the deck), props, source, note? }`. Types the rules
know: `space` (with `props.zone`: accommodation, lab, working, service, machinery, control, tank, open_deck,
circulation, passenger), `corridor`, `door`, `stair`, `ladder`, `machinery_space`, `tank`, `fuel_tank`,
`muster_station`, `liferaft`, `guard_rail`. Geometry-only types: `wall`, `hull`, `deck_plate`, `window`, `equipment`.
Measured values are written `{ value, unit: 'mm', source: 'measured from the drawing: …' }`, e.g. a door's
`clear_width` from its swing arc radius, a corridor's `clear_width` from the distance between its walls.

**Recon** (what `mesh.mjs` builds from; model mm, same axes as the model; z = height above the baseline):
```js
recon = {
  decks:  [{ id, name, elevation, height, outline: [[x, y], ...], plateThickness }],
  hull:   { stations: [{ x, half: [[y, z], ...] }],   // port half-section from keel (y = 0) up to the deck edge
            stem: [[x, z], ...], stern: [[x, z], ...], // profile ends
            keelZ, assumed: [string] } | null,
  walls:  [{ id, deck, a: [x, y], b: [x, y], thickness, z0, z1,
             openings: [{ from, to /* mm along a→b */, z0, z1, kind: 'door' | 'window' | 'opening', ref }],
             kind: 'shell' | 'bulkhead' | 'partition' }],
  rooms:  [{ id, deck, polygon: [[x, y], ...], z0, z1 }],          // id = model element id
  doors:  [{ id, deck, hinge: [x, y], width, wallDir: [dx, dy], swing: 1 | -1, z0, z1 }],
  stairs: [{ id, deck, polygon, dir: [dx, dy], z0, z1, treads }],
  ladders:[{ id, deck, at: [x, y], width, dir: [dx, dy], z0, z1 }],
  windows:[{ id, deck, at: [x, y], r | width, z }],
  equipment: [{ id, deck, polygon, z0, z1 }],
}
```
Every recon item with an `id` is also a model element with the same id (walls and hull too, type `wall` / `hull`).

**Report**: `{ scale: { value, mmPerUnit, source }, views: [...], decks: [...], counts: { rooms, doors, stairs, walls,
… }, measured: [string], assumed: [string], warnings: [string], unresolved: [{ view, what, at }] }`.

## 4. Mesh (`mesh.mjs`)

`buildGeometry(recon) -> Map<elementId, { positions: Float32Array, normals: Float32Array, indices: Uint32Array,
color: [r, g, b, a] }>` in viewer scene coordinates: **X = x / 1000, Y = z / 1000 (absolute height), Z = −y / 1000**,
metres — the format `ifc-convert.mjs` returns and `viewer3d.js` `setSource` draws. `geometryBoxes(geometry)` returns
each element's bounding box in model mm so the element `geom` matches its mesh exactly.

## 5. Whole chain (`convert.mjs`)

`convertDrawing(sheet, overrides) -> { model, geometry, recon, views, report }` and
`readDrawingFile({ name, bytes }, { pdfjs }) -> Sheet[]` (one per PDF page).

OCR (`ocr.mjs`, optional): `convertDrawing(sheet, overrides, { ocr: recognize })` first reads labels drawn as line
work. `recognize({ width, height, data /* RGBA */ }) -> [{ text, confidence 0–100, bbox: { x0, y0, x1, y1 } }]` is the
engine (tesseract.js: `public/drawing-worker.js` in the browser, `tools/drawing/ocr-node.mjs` in Node). What it reads
is added to `sheet.texts` as `{ id: 'o…', text, box, height, angle, ocr: { confidence } }`; the strokes it read get
`path.ocrText = id` and stay out of the plan line work. A room named from such a text has `check: true` and a note
"name read by OCR … check the spelling". `report.ocr = { lines, groups, candidates, skipped, ms, texts }`.
`needsOcr(sheet).suggest`: many letter-like stroke groups and few real texts.
