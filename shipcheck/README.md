# ShipCheck: automated class & regulatory compliance checking

Since AI Hackathon 2026 (Turku), Meyer Turku challenge. ShipCheck checks a ship design model against a rule database and shows,
for every part, which rules apply, whether it passes, **why**, and where every value comes from.

- **Deterministic checker.** Pass/fail comes from plain code, never from an LLM. Same input, same result.
- **Real 3D model.** The OSU RCRV ShipConstructor production model (330,760 objects, inches) is streamed through ShipCheck's `/model/...` gateway.
  Parts are coloured red (non-compliant), amber (not enough info) or green (compliant). Clicking a finding requests and frames its tile.
- **Views on the real model** (local Three.js viewer; the source model is never changed):
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

> Parts without a deviation are shown green and labelled *No deviation found*: no deviation in the rules checked
> automatically with the data in the model, not a statement of full compliance (see *Coverage* and *Manual checks* below).

## Features added after the hackathon

| Feature | Where | Code |
| --- | --- | --- |
| Open IFC (IFC2x3/IFC4, with `FireRating` from the `Pset_*Common` property sets), Revit `.rvt` (converted to IFC by Autodesk Platform Services, needs `APS_CLIENT_ID`/`APS_CLIENT_SECRET`) and DXF; an import report says what was read and which values the rules still need | **Open…** | `src/ifc-convert.mjs`, `src/rvt-convert.mjs`, `src/autocad.mjs` |
| Escape routes from every room to the muster stations, independent second routes, what-if blocking | **Escape plan**, room panel | `src/escape.mjs` |
| AI: explain a finding, propose a second escape route (recomputed by the checker), draft a reply to a class comment; answers stream in; model, time and cost shown | ✦ buttons, **✦ AI** pill | `public/app.js`, backend `app/services/ai_assist.py` |
| Findings register per project, shared by all revisions; dispositions flagged when the value changed | **Findings register** | `src/dispositions.mjs` |
| Class comments: paste a class letter or load a comment sheet; comments are linked to elements and rules; the rule check shows whether each is resolved | **Findings register → Class comments** | `src/class-comments.mjs` |
| Manual checks for requirements no algorithm can decide (`check: "manual"`), confirmed by name | element panel | `src/checker.mjs`, `src/dispositions.mjs` |
| Coverage per instrument and a submission readiness check (blockers and warnings, each linked to where it is fixed) | sidebar, report | `src/readiness.mjs` |
| Project file: register, manual confirmations and class comments as one file | readiness box | `src/project-file.mjs` |
| Rule hierarchy (`relations`: replaces / exempts, with a basis), rule conflicts, same requirement from two instruments | element panel, report | `src/checker.mjs` |
| Applicability by keel laying date (`applies_to.ship.constructed`) with a what-if date | ship particulars | `src/checker.mjs` |
| Rule verification: sources, quoted evidence, level 1 and level 2; the viewer shows each rule's level | `verify.html` | `public/verify.js`, `src/verify-status.mjs`, backend `app/services/rule_verification.py` |
| Revision comparison, measuring, what-if editing, plan view | top bar, 3D toolbar | `src/compare.mjs`, `public/viewer3d.js` |

## AutoCAD drawings

**Open…** reads an AutoCAD general-arrangement drawing saved as DXF (R12 to current, ASCII) in the browser and checks it:
layers named `<DECK>-<TYPE>` (`MD-CORRIDOR`, `01-DOOR`, `MD-OUTLINE`) carry the elements, closed polylines and block
references are the footprints, block attributes and `KEY=VALUE` text are the values, and layer `COMPLEE-SHIP` holds the
ship particulars. Every value keeps its layer and entity handle; widths without a written value are measured from the
geometry and labelled so; anything not drawn or written stays missing. **AutoCAD markup** writes the results back as a
DXF (R12) in the drawing's coordinates, one frame and the rule text per checked element on `COMPLEE_<DECK>_<STATUS>`
layers, to attach as an XREF. DWG is not read (save as DXF). Guide: `public/autocad.html` (in the app: *AutoCAD guide*);
sample: `demo/autocad-sample.dxf` (written with ezdxf by `tools/autocad/make_sample.py`); code: `src/dxf.mjs`,
`src/autocad.mjs`; tests: `tests/autocad.test.mjs` and `tools/export/autocad-smoke.mjs` (browser).

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

**Catalog source.** Without `SHIPCHECK_DATA_API_URL` the server uses the bundled catalog in `catalog/` (rules,
scenarios, example ships, expected results): no database, no network. Only the scenarios whose model file is present
are offered; the full RCRV production model (`catalog/ships/rcrv/parts.json`) is not in Git. Set
`SHIPCHECK_DATA_API_URL` to the FastAPI base URL to read the catalog from the database instead (production: in
`deploy/deploy.env`); the server then proxies only fixed catalog keys and does not fall back to the files.

**Backend features.** AI (explanations, escape-route proposals, comment replies) and rule verification
(`verify.html`) need the FastAPI backend, by default at http://127.0.0.1:8000 (`AI_API_URL`). Without it the viewer
works and shows the AI as unavailable.

| Setting (`shipcheck/.env` or environment) | Purpose |
| --- | --- |
| `PORT` | Server port (default 8080). |
| `SHIPCHECK_DATA_API_URL` | Read the catalog from the database API instead of `catalog/`. |
| `AI_API_URL` | Backend for AI and rule verification (default `http://127.0.0.1:8000`). |
| `AI_ALLOW_REMOTE`, `VERIFY_ALLOW_REMOTE`, `CONVERT_ALLOW_REMOTE` | `true` opens AI, rule verification and Revit conversion to other computers; by default only the computer running ShipCheck may use them (they cost money or hold licensed texts). |
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | Autodesk Platform Services app for the Revit conversion. |
| `EVIDENCE_PROVIDER` | `none` turns off the SOLAS passage search on the evidence page. |
| `ALLOWED_ORIGINS` | Origins allowed for cross-origin calls (default: localhost). |

Use **Add evidence** in the top bar to attach files to the selected scenario. The intake accepts documents, drawings, and model files for session-level review organization; DOCX is the document format with text extraction enabled in this demo. The review retrieves candidate SOLAS II-2 passages through a replaceable provider adapter. It does not decide applicability or compliance. The SinceAI JSONL corpus is local and ignored by Git; provide it at `integrations/sinceai/data/solas_ii2_revised_mca.jsonl`, or set `EVIDENCE_PROVIDER=none` to disable source retrieval. The `src/evidence-provider.mjs` interface can be replaced without changing the checker.

| Command | What it does |
| --- | --- |
| `npm start` | Local server on port 8080 (static files from a whitelist, check API and model gateway). |
| `npm test` | Tests checker, imports, escape routes, register, comments, readiness, report and server routes against the bundled catalog. |
| `npm run check` | Checks every active database scenario in the terminal. `node scripts/check.mjs rcrv-3d` also writes `results.json`. |
| `npm run prepare-model` | Streams the APS property dump into a temporary catalog staging file; import it with `SHIPCHECK_CATALOG_SOURCE_ROOT=<staging directory> python -m app.scripts.import_shipcheck_catalog model-rcrv-parts` from `backend`. |
| `npm run report` | Writes `reports/<scenario>.html` and `.csv` from the active database catalog. |

### 3D viewer (local model gateway)

The browser uses ShipCheck's local Three.js viewer and requests model assets from the same-origin `/model/...` routes.
Set `MODEL_SOURCE=vultr` with the `VULTR_S3_*` settings to stream from private Vultr Object Storage, or deploy the
audited `stream-hp/` model under `MODEL_DIR` for local serving. The server signs Vultr requests, restricts accessible
model paths, and caches tiles on disk; browser code never receives bucket credentials or Vultr URLs. The server requires
the `stream-hp/audit.json` pass and will not silently select the legacy `stream/manifest.json`. If no audited tile source
is configured, the findings remain available and saved screenshots are shown with an actionable gateway error. The
review does not fall back to APS.

The viewport viewer loads coarse overview tiles first and detail tiles on demand. See the [Vultr model serving notes](docs/model-serving.md)
and [viewport streaming guide](docs/viewport/README.md) for deployment settings and behavior. `?noaps` is retained as a
legacy query switch that skips model loading and shows the screenshots; no APS service is contacted by the review UI.

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
2. Point a domain's DNS A record at the server for public HTTPS; Caddy obtains and renews the certificate automatically. Without a domain, Caddy serves HTTP only, suitable for a temporary test.
3. On your laptop: copy `deploy/deploy.env.example` to `deploy/deploy.env` (gitignored) and set `SERVER_HOST`,
   `SERVER_USER`, `DOMAIN`, `ALLOWED_ORIGINS`, `SHIPCHECK_DATA_API_URL`, and `MODEL_SOURCE=vultr` with the four required
   `VULTR_S3_*` settings. The regulation-text API uses `SHIPCHECK_DATA_API_URL` too; only set `REGULATION_API_URL` if it is hosted separately.
   `ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS site origins, without paths;
   wildcard origins are rejected. The API and viewer are public and require no login. Keep the Object Storage bucket
   private; the Node service uses its server-side credentials to fetch only allow-listed viewer assets. No user-auth or
   AI credentials are required by this deployment.
4. Commit your changes (the scripts upload the last committed `shipcheck/` plus an empty model directory when using
   Vultr Object Storage), then deploy:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1
   ```
   or on Linux/macOS:
   ```bash
   bash deploy/deploy.sh
   ```

**Check it works** (replace the host):

```bash
curl -s https://shipcheck.example.com/api/health
```
should print basic service health such as `{"status":"ok","version":"…","model_source":"vultr","model_available":true,"catalog_source":"database"}` without storage credentials or request diagnostics.

```bash
curl -s https://shipcheck.example.com/api/model/config
curl -sI https://shipcheck.example.com/model/stream-hp/manifest.json
```
The first response selects the audited `stream-hp/manifest.json` from the private bucket; the second should return JSON without exposing bucket credentials. Fetch a tile filename listed in that manifest through `/model/<tile-name>` to verify tile streaming.

CORS: an allowed origin gets `access-control-allow-origin`, any other origin does not, and its preflight gets 403:

```bash
curl -si -X OPTIONS -H "Origin: https://allowed.example" -H "Access-Control-Request-Method: GET" https://shipcheck.example.com/api/health
```
```bash
curl -si -X OPTIONS -H "Origin: https://not-allowed.example" -H "Access-Control-Request-Method: GET" https://shipcheck.example.com/api/health
```

The public read-only viewer surface includes the app's static files, `/api/health`, `/api/model/config`, catalog-backed
`/api/*` data routes, and `/model/*` viewer assets. These routes require no login. `/model/*` accepts only the existing
allow-listed reference-model assets; the private bucket and credentials are never sent to the browser. Mutating local
maintenance endpoints remain loopback-only. The Node service applies in-memory limits of 600 static requests/minute, 120 general API requests/minute,
30 `/api/check` requests/minute, and 4,000 model requests/minute per client IP (a complete viewport streams about 700 overview tiles, and several reviews may share one office address); rate limits reset on restart and are not a
substitute for an upstream DDoS/WAF service. Keep the app container reachable only through Caddy, restrict SSH (22) to
trusted administrator IPs, and keep port 8080 private. CORS limits browser access, not direct HTTP callers.

For a temporary Cloudflare Quick Tunnel without a domain, leave `DOMAIN` empty, set `CADDY_BIND_ADDRESS=127.0.0.1` and `TRUST_CLOUDFLARE_TUNNEL=true`, then deploy. Caddy stays on loopback, and the tunnel provides the public HTTPS edge. After deployment, run on the VM:

```bash
docker run -d --name shipcheck-cloudflared --restart unless-stopped --network host cloudflare/cloudflared:latest tunnel --no-autoupdate --metrics 127.0.0.1:20241 --url http://127.0.0.1:80
docker logs --tail 50 shipcheck-cloudflared
```

Copy the generated `https://…trycloudflare.com` URL from the logs. Quick Tunnel URLs are temporary and may change after container recreation; this mode needs no Cloudflare account or DNS. Because Caddy is loopback-bound, close inbound UFW rules for 80/443 (keep SSH/22); the tunnel makes outbound connections. To open the viewer from the existing Netlify page, set its existing `VITE_SHIPCHECK_REVIEW_URL` build setting to `<quick-tunnel-url>/index.html?scenario=rcrv-3d` and rebuild Netlify; otherwise use the tunnel URL directly. The Render API stays where it is, and the Node catalog/regulation proxy uses `SHIPCHECK_DATA_API_URL` by default.

Logs and restart on the server: `cd /opt/shipcheck && docker compose -f deploy/docker-compose.yml logs -f` /
`… up -d --build`. The app also runs without Docker: `npm ci --omit=dev && MODEL_DIR=/path/to/model node server.mjs`.

## Project structure

```
server.mjs                 local server: whitelisted static files, /api/check, /api/aps/*
src/                       checker and data code (pure modules run in the browser and in Node, except load.mjs)
  checker.mjs              deterministic checker: units to mm, applicability, check types, governing value on overlap
  parts-model.mjs          database parts catalog -> checker model (material family, steel grade, SWBS group, oil fuel systems, openings)
  units.mjs                feet-inch / inch / lb parsing (unknown text -> null, never a guess)
  json-stream.mjs          streams a huge JSON array (Node only)
  score.mjs                compares results with the database ground-truth catalogs
  load.mjs                 Node: loads database catalogs and runs checks
  catalog-local.mjs        bundled catalog in catalog/ (used when SHIPCHECK_DATA_API_URL is not set)
  escape.mjs               escape-route graph: routes, independent second routes, what-if blocking
  escape-actions.mjs       applies and recomputes AI escape-route proposals
  ifc-convert.mjs          IFC -> ship/1 model with geometry (web-ifc), fire ratings from property sets
  rvt-convert.mjs          Revit -> IFC through Autodesk Platform Services (server side)
  autocad.mjs, dxf.mjs     DXF drawing -> model, results -> DXF markup
  dispositions.mjs         findings register, manual-check confirmations, project key
  class-comments.mjs       class comments: import, links, evidence from the rule check
  readiness.mjs            submission readiness (blockers, warnings)
  project-file.mjs         project file (register + comments) save and open
  compare.mjs              revision comparison
  report.mjs               HTML / CSV report
  verify-status.mjs        verification level of a rule (same SHA-256 as the backend)
catalog/                   bundled catalog: rules.json, scenarios.json, example ships, expected results
public/                    the web UI
  app.js                   sidebar, findings list, detail panel, register, comments, AI, live editing
  verify.html, verify.js   rule verification page (needs the backend)
  viewer3d.js              Three.js deck view (cruise scenario)
  viewer-aps.js            legacy Autodesk APS viewer (not used by the review UI)
  viewer-fallback.js       saved-image fallback when model gateway tiles are unavailable
  fallback/                screenshots used when APS is unreachable
scripts/
  check.mjs                database-backed CLI check / report
  prepare-model.mjs        APS property dump -> temporary catalog staging file
tests/                     node:test suites, database-backed ground truth, small independent fixtures
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

1. Prepare an updated rules catalog in a private source directory and import it with `python -m app.scripts.import_shipcheck_catalog rules`.
   Check types: `min`, `max`, `in_set`, `table_lookup`, `data_quality`, `not_adjacent_zone`, `distance_min_hull`, `count_min`, `requires`.
   `applies_to.where` takes a value or `{ "prefix" }`, `{ "in" }`, `{ "not_in" }`, `{ "exists" }`.
2. Add the rule id to `VERIFY.md` (`npm test` fails otherwise).
3. If it produces new findings, update that scenario's expected-result catalog in the private source directory and import it with `python -m app.scripts.import_shipcheck_catalog expected-<scenario>`.

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
tiles are still taken from `model/stream` until they are re-baked.
**Transparency as in the original.** Each vertex also carries its source material's opacity (`_OPACITY`): about 1.58 M
triangles (glazing, envelopes, clearance volumes) are see-through in the original, e.g. the rescue-boat launch envelope on
layer `ENV_` is 96 % transparent. The viewer draws them in a see-through pass with that opacity (below 10 % they are not
clickable); the audit checks the opacity of every part against the source. Browser regressions:
`cd tools/export && node --test --test-concurrency=1 browser-regressions.cjs` (app running). Without the real model and
database, `cd tools/export && node --test viewer-smoke.mjs` builds a small synthetic ship in the same tile layout
(`synthetic-model.mjs`), starts a stub catalog API and the server, and checks first picture, streaming, selection,
rule view, filter, picking, what-if re-check, eviction, screenshots and HTTP revalidation in headless Chromium.
Load tests: `node stress-model.mjs work/stress-model && node stress-run.mjs work/stress-model` (215,000 parts,
10.3 million triangles, 86,000 checked parts; prints loading, part-state, check, picking and memory figures) and
`node ../autocad/make_large_dxf.mjs big.dxf 5 3000` for a 16,500-element drawing.
`node --test deck-viewer-smoke.mjs` does the same for the deck viewer with the bundled catalog (idle view draws no
frames, selection, what-if re-check against a full check, escape plan, findings register).

**Part state on the GPU.** Every vertex carries its part's dbId (the tile's `COLOR_0` bytes, bound unchanged) and its
source opacity. The viewer keeps colour and visibility per part in a small texture (one texel per dbId): a selection,
filter or rule view rewrites that texture, never the vertex buffers of the resident tiles, and hidden parts are
collapsed in the vertex shader instead of discarded per fragment. A what-if edit re-checks only the edited element
(`recheckElements` in `src/checker.mjs`) when every active rule reads the element alone. Catalogs, modules and the tile
manifest are revalidated with ETags (`Cache-Control: no-cache`), tiles stay immutable; the Node proxy asks the
database API only whether its cached catalog version is still current.

**Corridor scene inside the real ship.** Scenario `rcrv-inside` (database catalog `model-rcrv-inside`) places a simplified, estimated
example (one corridor, its door, a stair, a guard rail; fictional values, ground truth in `expected-rcrv-inside`)
at its real position in the deckhouse (deck level 4, located from the real geometry). It opens in the real-model viewer:
the ship is cut open 1.5 m above the deck, the camera dives in, and only the four components carry status colours
(`public/viewer-scene.js`). The demo shows the whole real ship first, then this scene.

Model files can live on a different host: see [separate model server](docs/model-serving.md) for `MODEL_BASE_URL`, CORS and read-only server commands. Legacy APS viewer code remains in the repository but is not used by the review UI.

**Model from Vultr Object Storage.** `MODEL_SOURCE=vultr` plus `VULTR_S3_ENDPOINT`, `VULTR_S3_BUCKET`, `VULTR_S3_ACCESS_KEY`,
`VULTR_S3_SECRET_KEY` (optional `VULTR_S3_REGION`, `VULTR_S3_PREFIX`; in the environment or in the gitignored
`shipcheck/.env`) make the server answer `/model/...` from the private bucket, which holds the exported `model/` folder
(`src/model-source-s3.mjs`). The browser keeps using the same paths, so the bucket needs no public access or CORS. Each
request is signed on the server (AWS Signature V4); only viewer files are reachable (the tile manifest, `stream-hp/`
tiles, the overview tiles in `stream/`, `props/` and the main chunk GLBs), never the source `.nwd`, screenshots or
check reports. The viewer still loads only what the view needs: the 706 coarse overview tiles (29.5 MB) for the whole
ship, which the server pre-fetches in parallel once the manifest is requested, and detail tiles on demand when you zoom
or open a component. For remote storage the viewer may run 6 requests at once instead of 2. Content-addressed tiles are
cached on disk (`.cache/model-s3`, `MODEL_CACHE_DIR`). Measured on 8 Nov 2026 with an empty cache: whole ship in about
5.5 s, a tile 70 to 200 ms from the bucket and 15 to 35 ms from the cache. The bucket's `stream-hp/` matched the local
audited tiles byte for byte (853/853). `deploy.sh` / `deploy.ps1` with `MODEL_SOURCE=vultr` in `deploy.env` skip the
model upload.

[Viewport architecture, measured request sizes and screenshots](docs/viewport/README.md).
