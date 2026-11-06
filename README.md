# ShipCheck: automated class & regulatory compliance checking

Since AI Hackathon 2026 (Turku), Meyer Turku challenge. ShipCheck checks a ship design model against a rule database and shows,
for every element, which rules apply, whether it passes, **why**, and where every value comes from.

- **Deterministic checker.** Pass/fail comes from plain code, never from an LLM. Same input, same result.
- **Two scenarios.** *RCRV research vessel (reconstructed)*, 5 decks and 67 elements, and *Cruise passenger deck (fictional)*.
- **15 rules.** They cover SOLAS/FSS means of escape, ADA/PVAG accessibility, IGF Code LNG tanks, Load Line, MARPOL and a DNV class rule example. Applicability depends on ship type, operating area, size and class society.
- **Real-time.** Edit a value in the detail panel and the element is re-checked and recoloured instantly (the checker runs in the browser).
- **Trust.** `npm test` runs the ground truth for every planted finding, edge cases and the server whitelist. The UI shows the score: *8/8 expected findings detected, 0 false alarms*.

## Run (Windows on ARM / PowerShell, macOS, Linux; Node 20+)

```bash
npm install
```

```bash
npm start
```

Open http://localhost:8080. Then run the tests:

```bash
npm test
```

You can also check from the terminal only: `npm run check` covers all scenarios, and `node check.mjs rcrv` writes `results.json`.
No Python, Navisworks, Blender or internet connection is needed after `npm install`.

## Using it

| Area | What it does |
| --- | --- |
| Top bar | Scenario switcher. Deck selector: all decks, exploded, or one deck. Plan view (top-down). **Demo run-through**. Report (printable HTML, PDF via print). CSV. Role (engineer/viewer). |
| Left | Ship particulars with provenance, ground-truth score, summary, session edits, and findings filtered by status, rule source and deck. Click a finding to fly to the element. |
| Right | Every applicable rule, with measured vs required value, explanation, quoted rule text, input provenance and verification status. Also: the governing value when rules overlap, **Also required** (related rules and where they are checked), rules considered but not applicable (with the reason), and the editable design data. |

## Architecture

```
ships/*/ship.json, deck.json ──┐
rules.json (+ rules-approved.json)  ├─> src/checker.mjs (pure ES module) ─> results ─> UI (public/), CLI (check.mjs), tests
tests/expected/*.json ─────────┘          src/score.mjs (ground truth)
server.mjs: static files (whitelist, never .env) + /api/check, /api/scenarios, /api/rules, /recheck, /api/ai/*
rule-assistant.mjs: optional LLM drafting/explanations (Mistral EU, Anthropic, OpenAI-compatible/local)
extract-aps.mjs: optional APS Model Derivative extraction -> ships/rcrv-aps/ship.json
```

| File | Purpose |
| --- | --- |
| `src/checker.mjs` | Normalises units to mm (`mm`, `cm`, `m`, `in`, `ft`), keeps the original unit for display, evaluates rules. Check types: `min`, `max`, `not_adjacent_zone` (declared or derived from 3D geometry), `distance_min_hull` (e.g. IGF B/5), `count_min` (e.g. escape routes), `requires` (if X exists, Y must exist). Missing data always gives `not_enough_info`. |
| `src/score.mjs` | Compares results with `tests/expected/<scenario>.json`: detected, missed, wrong status, false alarms, expected passes. |
| `public/` | `index.html`, `app.js` (UI, editing, demo, export), `viewer3d.js` (Three.js from `node_modules`). |
| `ships/rcrv/build-ship.mjs` | Generates the RCRV reconstruction `ship.json`. |
| `VERIFY.md` | Every unverified rule value and ship particular, and the official source to check it against. |
| `DEMO_SCRIPT.md` | The 30-second opening shot and the pitch outline. |

## Model format (`ship.json`)

```jsonc
{
  "name": "...", "units": "mm",               // geometry and plain values in these units
  "ship": { "type": "research", "operating_area": ["US"], "class_society": "DNV",
            "length_overall": { "value": 60650, "unit": "mm", "source": "public particulars" }, "beam": ..., "gross_tonnage": ... },
  "decks": [ { "id": "MD", "name": "Main deck", "elevation": 5000, "height": 2700,
               "outline": [[x, y], ...], "side_lines": [[[x, y], ...]] } ],   // side_lines optional: ship shell for distance checks
  "hull": { "deck": "MD" },                   // optional: draw the hull shell up to this deck
  "elements": [ { "id": "MD-C1", "type": "corridor", "name": "...", "deck": "MD", "source": "estimated",
                  "geom": { "x": 20100, "y": -425, "z": 0, "lx": 23900, "ly": 850, "h": 150 },   // relative to the deck
                  "props": { "clear_width": { "value": 850, "unit": "mm", "source": "GA drawing 101" }, "dead_end_length": 0 } } ],
  "demo": { "focus": "01-GR1", "fix": { "prop": "height", "value": 1000, "unit": "mm" } }
}
```

The older `deck.json` format (one `deck` with `length`/`width`, no `decks[]`) still loads. The cruise scenario uses it, and a
test loads the unmodified Plan B file. Element types used by the rules are `corridor`, `stair`, `ramp`, `door`, `guard_rail`, `fuel_tank`,
`sludge_tank`, `machinery_space`, `escape_zone` (virtual, groups an accommodation area), `ladder`, `escape_trunk` and `space`.

## How to add a rule

1. Add an entry to `rules.json`:
   ```json
   { "id": "LL-REG25-GUARDRAIL", "source": "International Convention on Load Lines 1966, Annex I",
     "clause": "Regulation 25", "text": "<exact rule text>", "text_status": "paraphrase",
     "check": "min", "parameter": "height", "value": 1000, "unit": "mm",
     "applies_to": { "types": ["guard_rail"], "where": { }, "ship": { "type_in": ["passenger"], "operating_area_any": ["US"],
                     "min": { "length_overall": { "value": 24, "unit": "m" } }, "equals": { "class_society": "DNV" } } },
     "related": ["DNV-GUARDRAIL"], "verified": false, "reference_url": "https://..." }
   ```
2. Add the rule id to `VERIFY.md`. `npm test` fails otherwise.
3. If a model now produces a new finding, add it to `tests/expected/<scenario>.json`. Otherwise it counts as a false alarm.
4. Or use the AI assistant: paste the paragraph and review the draft. It is accepted only if the quote is verbatim and the value appears in the text. Approve it, and it goes to `rules-approved.json`, still `verified: false`.

## How to add a ship

1. Create `ships/<id>/ship.json` (format above). Use `"units": "in"` if the source is in inches; everything is converted.
2. Add it to `scenarios.json`. Optionally add ground truth in `tests/expected/<id>.json` and a test in `tests/checker.test.mjs`.
3. From Autodesk APS: once `../3D_Since_AI/urn.txt` exists, run `node extract-aps.mjs`. It maps object names, categories and
   bounding boxes (from inches) into `ships/rcrv-aps/ship.json`, which then appears as an extra scenario. This step is optional.

## Data provenance policy

- **No invented rule values.** Every rule value is `verified: false` until checked against the official text (`VERIFY.md`). The UI tags
  each result that uses an unverified value. Rule texts are marked as `paraphrase` until replaced by the verbatim text.
- **Every model value says where it comes from**: `public particulars`, `GA drawing <sheet>`, `estimated`, `planted test case (fictional value)`,
  `assumed for the demo`, `derived from 3D geometry`, or `edited in session by engineer`. The UI shows this next to every value.
- **RCRV**: the GA drawing PDFs were not available locally, so the layout is a simplified reconstruction (`estimated`). The particulars
  are public figures still to verify (LOA 199 ft vs 193 ft in OSU press material). The class society DNV is assumed for the demo.
- **Missing data → `not_enough_info`**, never a guess. That includes ship particulars needed to decide whether a rule applies at all.
- **AI** (optional) never decides pass/fail. It quotes rule text verbatim or says "not found", and its drafts need engineer approval.
  Keys live in `.env` (see `.env.example`), which is never committed or served.

## Known limitations

- Rule values and clause numbers are not yet verified (see `VERIFY.md`). Some rules are simplified: the IGF location rule, and the IGF distance
  measured on the deck plan instead of at the summer load line.
- "Widely separated" escape routes and travel distances are not checked geometrically. Escape routes are declared per zone.
- Metric equivalents of imperial ADA values (915 mm for 36 in) are kept as in Plan B; a design of exactly 36 in fails by 0.6 mm.
  This is documented in a test and in `VERIFY.md`.
