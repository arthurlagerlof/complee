# ShipCheck: automated class & regulatory compliance checking

Since AI Hackathon 2026 (Turku), Meyer Turku challenge. ShipCheck checks a ship design model against a rule database and shows,
for every part, which rules apply, whether it passes, **why**, and where every value comes from.

- **Deterministic checker.** Pass/fail comes from plain code, never from an LLM. Same input, same result.
- **Real 3D model.** The OSU RCRV ShipConstructor production model (330,760 objects, inches) converted with Autodesk APS and shown in the APS viewer:
  parts are coloured red (non-compliant), amber (not enough info) or green (compliant). Clicking a finding isolates the part and flies to it.
- **Views on the real model** (APS viewer; the model is only hidden, ghosted, coloured, cut and framed, never changed):
  *Simple view* (shell, decks and checked parts only) with a *deck cut*; *component view* (click a part: isolated, outlined,
  3D label with the key value, card with every rule, missing data and what-if editing labelled "what-if, not in model");
  *rule view* (click a rule: all its parts with counts, e.g. "22 hatches: 4 pass, 0 fail, 18 not enough info");
  *traceability* table (parts × rules, the same data as the report).
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

From the repository root, `npm run dev` serves ShipCheck at http://localhost:5173/inspection/ next to the Complee landing page (`/landing`). On its own: run these commands inside `shipcheck/`. Open http://localhost:8080 (the evidence intake; the checker is at http://localhost:8080/index.html). Run the tests:

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

### Local 3D viewer (default) and the APS fallback

The real RCRV model is shown by ShipCheck's own Three.js viewer from glTF chunks on our server (`model/`), with the same
colours, component card, rule view, labels, deck cut and what-if as before. `?viewer=aps` switches to the Autodesk viewer,
`?noaps` to the saved screenshots. If `model/manifest.json` is missing the app falls back to APS automatically.

The chunks are exported once from the Autodesk model (needs the APS keys; the files are gitignored, 226.5 MB of GLBs plus 56.7 MB of on-demand properties):

```bash
cd tools/export && npm install
```
```bash
node request-svf.mjs
```
```bash
node --max-old-space-size=12288 map-ids.mjs
```
```bash
node --max-old-space-size=12288 export-chunks.mjs
```
```bash
node --max-old-space-size=12288 export-rest.mjs --plan
```
Then `node --max-old-space-size=12288 export-rest.mjs --chunk 1`, `--chunk 2`, … (one run per sub-chunk, as many as the plan prints) and `node --max-old-space-size=12288 export-rest.mjs --props`. Finish with `node --max-old-space-size=12288 audit-model.mjs`.

`request-svf.mjs` copies the source file inside our APS bucket and translates the copy to SVF (svf-utils 8 reads SVF only;
the original model keeps its SVF2 for the APS viewer). `map-ids.mjs` matches the SVF copy's node ids to the APS model's dbIds
(the two translations number objects differently) by DWG source file + entity handle; `verify-ids.mjs` checks the result
(each part's ShipConstructor centre of gravity must lie inside its geometry: 99.7 %). `export-chunks.mjs` merges each chunk
(context, openings, structure with findings, piping, stairs/ladders, other structure) into one mesh with the part's dbId on
every vertex, compresses it with gltfpack (meshopt, no simplification) and writes `model/manifest.json`.

The retained `viewer-local.js` uses the six main GLBs and rest chunks for the previous full-load approach. The default `viewer-stream.js` now requests spatial tiles on demand; the original GLBs are retained as lossless inputs for `tile-model.mjs`. See **Viewport streaming and simplified example** below.

The full geometry is rendered without simplification; decoding and picking-index construction run in workers. See [export coverage and measured performance](tools/export/README.md) for sizes, timings, dbId mapping limits and the correction to the original six chunks.

## Deploy to Vultr

One small Linux server runs everything: the app (UI, `/api`, model chunks) in Docker behind Caddy (HTTPS, gzip/zstd).
No Autodesk keys are needed on the server.

**Server:** Ubuntu 24.04, 1 vCPU, 2 GB RAM, 25 GB+ disk is enough (the app needs about 0.5 GB RAM; the model chunks
are tens of MB). **Firewall:** allow TCP 22 (SSH), 80 (HTTP) and 443 (HTTPS, plus UDP 443 for HTTP/3); nothing else.

1. On the server, once (as root):
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
   ```bash
   ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443 && ufw --force enable
   ```
2. Optional: point a domain's DNS A record at the server; Caddy then gets an HTTPS certificate automatically.
3. On your laptop: copy `deploy/deploy.env.example` to `deploy/deploy.env` (gitignored) and fill in `SERVER_HOST`,
   `SERVER_USER`, optionally `DOMAIN` and `ALLOWED_ORIGINS` (sites allowed to call the API from a browser).
4. Commit your changes (the scripts upload the last commit of `shipcheck/` plus `model/`), then deploy:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploydeploy.ps1
   ```
   or on Linux/macOS:
   ```bash
   bash deploy/deploy.sh
   ```

**Check it works** (replace the host):

```bash
curl -s https://shipcheck.example.com/api/health
```
should print `{"status":"ok","version":"…","model_manifest":true,"chunks":7,"parts_loaded":true,…}`.

```bash
curl -sI https://shipcheck.example.com/model/context.glb
```
should show `content-type: model/gltf-binary`, `cache-control: public, max-age=31536000, immutable` and `accept-ranges: bytes`.

CORS: an allowed origin gets `access-control-allow-origin`, any other origin does not, and its preflight gets 403:

```bash
curl -si -X OPTIONS -H "Origin: https://allowed.example" -H "Access-Control-Request-Method: GET" https://shipcheck.example.com/api/health
```
```bash
curl -si -X OPTIONS -H "Origin: https://not-allowed.example" -H "Access-Control-Request-Method: GET" https://shipcheck.example.com/api/health
```

Logs and restart on the server: `cd /opt/shipcheck && docker compose -f deploy/docker-compose.yml logs -f` /
`… up -d --build`. The app also runs without Docker: `npm ci --omit=dev && MODEL_DIR=/path/to/model node server.mjs`.

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

### Viewport streaming and simplified example

The scenario selector includes **Simplified research vessel (example)** again, with the original eight expected findings and estimated geometry. The real model now loads small spatial tiles for the current camera view: hull/decks for the overview, nearby detail on zoom, and requested component tiles on selection; leaving a region cancels requests and releases its geometry and picking data. The **Full model** button permits nearby untested detail; it no longer downloads the whole ship.

Run `node --max-old-space-size=4096 tools/export/tile-model.mjs` inside `shipcheck/` after the original GLBs are available. This preserves every packed triangle and attribute byte, leaves the original files untouched, and writes `model/stream/manifest.json` plus content-addressed tiles. The tiler stops below 3 GB free. The default client budget estimates at most 512 MB resident geometry/picking data and 1.5 million nearby detail triangles (hull context is counted against the memory budget). This is view selection, not mesh simplification; if the budget is reached, the badge asks you to zoom in.

**Source fidelity (high-precision tiles).** The first export stored each whole chunk (up to ~60 m) with 16-bit positions,
a ~0.9 mm grid, which collapsed about 4.9 million fine triangles to zero area; the tiles above copy those bytes. 
`tools/export/export-tiles-hp.mjs` builds the same tile grid again straight from the retained SVF with float32 positions
relative to each tile (no position quantization; one `--group` per run, then `--manifest`), into `model/stream-hp/`.
`tools/export/audit-hp.mjs` checks it against the SVF source per dbId: identical triangle counts (50,843,045), bounds and
mean centroids within 0.0004 mm, areas within the float32 rounding bound (`model/stream-hp/audit.json`). The app serves
`stream-hp` once that audit has passed; `MODEL_MANIFEST=stream/manifest.json` switches back. The far exterior overview
tiles are still taken from `model/stream` until they are re-baked. Browser regressions:
`cd tools/export && node --test --test-concurrency=1 browser-regressions.cjs` (app running).

Model files can live on a different host: see [separate model server](docs/model-serving.md) for `MODEL_BASE_URL`, CORS and read-only server commands. The original merged viewer code and APS/screenshot fallbacks remain in the repository.

[Viewport architecture, measured request sizes and screenshots](docs/viewport/README.md).
