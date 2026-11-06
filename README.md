# Plan B: compliance check on a self-made deck model

No Autodesk, no Navisworks. Needs only Node.js 20+.

## Run

```
node serve.mjs
```

Open http://localhost:8080. The server runs the rule check on start.
Click an element (3D view or list) to see each rule: measured value, required value, why it fails, and the rule text.

Check only, in the terminal:

```
node check.mjs
```

## Files

| File | What it is |
| --- | --- |
| `deck.json` | The design: one fictional passenger deck. Positions and sizes in `units` (mm; `in` also works, it is converted). |
| `rules.json` | The rule set: source, clause, rule text, threshold, and which element types it applies to. |
| `check.mjs` | The checker. Writes `results.json`. Deterministic: same input, same result. |
| `serve.mjs` | Tiny local web server + `/recheck`. |
| `index.html` | 3D viewer (Three.js). Colours elements by their worst result. |

## Planted findings (for the demo)

| Element | Rule | Result |
| --- | --- | --- |
| C2 cross corridor, 800 mm | SOLAS/FSS 900 mm **and** ADA 915 mm | Fails two overlapping rules |
| D2 accessible cabin door, 760 mm | ADA 404.2.3, 815 mm | Fails |
| R1 ramp, slope 1:10 | ADA 405.2, max 1:12 | Fails |
| T1 LNG tank next to cabin 5009 | Simplified IGF location rule | Fails |
| D3 lounge door, width missing | ADA 404.2.3 | Not enough info |

Demo fix: edit a value in `deck.json` (e.g. C2 `clear_width` to 1000), click "Run check again".

## Before the pitch

All rule values have `"verified": false`. Check each against the official text (ADA 2010 Standards, PVAG, SOLAS/FSS Code, IGF Code) and set `verified: true`. The IGF rule is a simplification.

## Next steps

- Feed real data: replace `deck.json` with properties extracted from the OSU model (APS route), same checker.
- LLM layer: turn rule text into `rules.json` entries, and write the explanation in plain engineering language. Keep the pass/fail decision in the deterministic checker.
