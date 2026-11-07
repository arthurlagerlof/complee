# ShipCheck: automated class & regulatory compliance checking

Since AI Hackathon 2026 (Turku), Meyer Turku challenge. ShipCheck checks a ship design model against a rule database and shows,
for every part, which rules apply, whether it passes, **why**, and where every value comes from.

- **Deterministic checker.** Pass/fail comes from plain code, never from an LLM. Same input, same result.
- **Real 3D model.** The OSU RCRV ShipConstructor production model (330,760 objects, inches) converted with Autodesk APS and shown in the APS viewer:
  parts are coloured red (non-compliant), amber (not enough info) or green (compliant). Clicking a finding isolates the part and flies to it.
- **Cruise passenger deck (fictional)** with planted findings, shown in a Three.js deck view, with live editing.
  Passenger-ship rules (accessibility, LNG) are shown on an example deck because the RCRV research vessel has no passenger areas or LNG, as agreed with the Meyer mentors.
- **Class society DNV**, confirmed by Meyer mentors (Q&A, 7 Nov). Rule values are `verified: false` with review status *reviewed by Meyer mentors*.
- **No guessing.** Missing or unparseable data gives *not enough info*. Every rule value is `verified: false` until checked against the official text
  ([VERIFY.md](VERIFY.md)); interpretations are labelled.
- **Ground truth.** `npm test` checks every planted and hand-checked finding; the top bar shows the score, e.g. *✓ 7/7 expected findings, 0 false alarms*.

> ShipCheck lives in the `shipcheck/` folder of the `dev` branch, next to the Complee site at the repository root (which links here).
> Included: the checker, the real RCRV model, the cruise deck, the evidence intake, the demo run-through ([DEMO_SCRIPT.md](DEMO_SCRIPT.md)) and the HTML/CSV report.
> The optional AI rule drafting and the viewer role switch remain on the branch `shipcheck-full`.

## Run (Node 20+)

```bash
npm install
```

```bash
npm start
```

Run these commands inside `shipcheck/`. Open http://localhost:8080 (the evidence intake; the checker is at http://localhost:8080/index.html). Run the tests:

```bash
npm test
```

Use **Add evidence** in the top bar to attach files to the selected scenario. The intake accepts documents, drawings, and model files for session-level review organization; DOCX is the document format with text extraction enabled in this demo. The review retrieves candidate SOLAS II-2 passages through a replaceable provider adapter. It does not decide applicability or compliance. The SinceAI JSONL corpus is local and ignored by Git; provide it at `integrations/sinceai/data/solas_ii2_revised_mca.jsonl`, or set `EVIDENCE_PROVIDER=none` to disable source retrieval. The `src/evidence-provider.mjs` interface can be replaced without changing the checker.

| Command | What it does |
| --- | --- |
| `npm start` | Local server on port 8080 (static files from a whitelist, check API, APS token). |
| `npm test` | All tests (checker, real-model ground truth, unit parsing, server whitelist). |
| `npm run check` | Checks every scenario in the terminal. `node scripts/check.mjs rcrv-3d` also writes `results.json`. |
| `npm run prepare-model` | Streams `3D_Since_AI/model-properties.json` (150 MB, never loaded whole) into `ships/rcrv/parts.json`. Needs the local APS export. |
| `npm run report` | Writes `reports/<scenario>.html` and `.csv`, the same as the Report and CSV buttons. |
| `npm run precompute` | Rewrites `ships/rcrv/results-3d.json` (offline results). Run it after changing rules or parts; `npm test` fails if it is stale. |

### 3D viewer (Autodesk APS)

`server.mjs` reads `APS_CLIENT_ID` and `APS_CLIENT_SECRET` from `3D_Since_AI/.env` (gitignored: ask the team for the keys) and gives the browser a
short-lived read-only token (`/api/aps/token`, scope `viewables:read`, localhost only). The model URN is in `3D_Since_AI/urn.txt`.
Without keys or internet, the app shows saved screenshots (`public/fallback/`) next to the locally computed findings. `?noaps` forces that fallback.

## Project structure

```
server.mjs                 local server: whitelisted static files, /api/check, /api/aps/*
rules.json                 rule database (all verified:false, see VERIFY.md)
scenarios.json             the scenarios shown in the UI
src/                       checker and data code (pure modules run in the browser and in Node, except load.mjs)
  checker.mjs              deterministic checker: units to mm, applicability, check types, governing value on overlap
  parts-model.mjs          parts.json -> checker model (material family, steel grade, SWBS group, oil fuel systems, openings)
  units.mjs                feet-inch / inch / lb parsing (unknown text -> null, never a guess)
  json-stream.mjs          streams a huge JSON array (Node only)
  score.mjs                compares results with the ground truth (tests/expected)
  load.mjs                 Node: loads rules, scenarios, models; runs and precomputes checks
public/                    the web UI
  app.js                   sidebar, findings list, detail panel, live editing
  viewer3d.js              Three.js deck view (cruise scenario)
  viewer-aps.js            Autodesk APS viewer + screenshot fallback (real RCRV model)
  fallback/                screenshots used when APS is unreachable
ships/
  rcrv/parts.json          69,993 prepared parts of the real model (mm/kg + original inch text, objectid = viewer dbId)
  rcrv/rcrv-3d.meta.json   ship particulars with provenance
  rcrv/results-3d.json     precomputed results (offline fallback)
  cruise/deck.json         fictional cruise deck with planted findings
scripts/
  check.mjs                CLI check / precompute
  prepare-model.mjs        APS property dump -> ships/rcrv/parts.json
tests/                     node:test suites, ground truth (expected/), fixtures/
3D_Since_AI/               APS pipeline scripts (upload, status, extract, analyze), urn.txt, model-summary.txt.
                           Local only (gitignored): .env with the keys, the .nwd model, the large JSON exports.
VERIFY.md                  unverified values, interpretations, mentor questions
```

## Rules

| Area | Rules | Runs on |
| --- | --- | --- |
| Hull materials (real data) | IACS UR W11 hull steel grades; UR S6 Table 7 grade vs thickness (interpretation: RCRV is below 90 m) | RCRV 3D |
| Openings | 600 × 600 mm hatch clear opening, sizes parsed from names like `30"X36"` (interpretation) | RCRV 3D |
| Piping | SOLAS II-2/4.2.2.5.1 oil fuel pipes of steel or approved material | RCRV 3D |
| Data quality | design status must be Final; no "Error" fields | RCRV 3D |
| Means of escape, accessibility, Load Line, IGF, MARPOL, class | 15 layout rules (SOLAS/FSS, ADA/PVAG, ICLL, IGF Code, MARPOL, DNV) | cruise deck, layout fixture in tests |
| Draft | minimum plate thickness per structural group: listed, never run (no official value yet) | - |

## How to add a rule

1. Add an entry to `rules.json` (`id`, `source`, `clause`, `text`, `text_status`, `check`, parameters, `applies_to`, `verified: false`).
   Check types: `min`, `max`, `in_set`, `table_lookup`, `data_quality`, `not_adjacent_zone`, `distance_min_hull`, `count_min`, `requires`.
   `applies_to.where` takes a value or `{ "prefix" }`, `{ "in" }`, `{ "not_in" }`, `{ "exists" }`.
2. Add the rule id to `VERIFY.md` (`npm test` fails otherwise).
3. If it produces new findings, add them to `tests/expected/<scenario>.json` (otherwise they count as false alarms) and run `npm run precompute`.

## Data provenance policy

- **No invented rule values.** Every value is `verified: false` until checked against the official text. A rule without an official value is a draft and does not run.
- **Every model value says where it comes from**: the ShipConstructor model (with the source drawing), derived by ShipCheck (with the field it was derived from),
  public particulars, estimated, fictional, or edited in session. The UI shows this next to every value, and inch values next to their mm conversion.
- **Missing data gives *not enough info***, never a guess.
