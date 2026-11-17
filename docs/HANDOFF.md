# Complee: handoff for the next session

State as of 16 Nov 2026 on `main` (GitHub: `flip18731/complee`, second remote `arthurlagerlof/complee`).
The commits since `4275faf` (`574adf2`, `752be9d`, `f367c11`, `ad691ac` and the one after it) are **not pushed yet**.

## What Complee is

A compliance pre-check for ship design. It checks a ship model (IFC, Revit, AutoCAD DXF, its own ship/1 JSON, or the
RCRV production model) against class and statutory rules and shows every finding in a 3D viewer with the rule text,
the measured and required value and where each value comes from. It takes the engineer up to a submission to class:
findings register, class comments, manual checks, readiness check, report.

**Core principle:** pass or fail comes only from a deterministic rule checker (`shipcheck/src/checker.mjs`), never from
AI. AI explains, proposes (proposals are recomputed by the checker) and drafts text. Rule texts in the bundled catalog
are paraphrases and unverified until checked against the official text. The tool is a pre-check, not an approval.

Started at the Since AI Hackathon (Turku, 7–8 Nov 2026, Meyer Turku challenge, team KEEP); everything after commit
`f3351db` (8 Nov) was added afterwards.

## Repository layout

| Folder | Content |
| --- | --- |
| `shipcheck/` | The application: Node server (`server.mjs`), checker and data modules (`src/`), web UI (`public/`), bundled catalog (`catalog/`), tests (`tests/`), export pipeline for the production model (`3D_Since_AI/`, `tools/export/`). |
| `backend/` | FastAPI + PostgreSQL (Tiger Cloud): AI model chain and viewer assistance, rule verification, regulation database, document extraction. |
| `src/`, `public/`, `index.html` | Complee landing page (React, Vite). |
| `docs/` | This file; `docs/archive/` holds the hackathon documents. |

## How to run

```bash
cd shipcheck && npm start        # http://localhost:8080 (evidence intake), /index.html (review), /verify.html
```
```powershell
cd backend; .venv\Scripts\python -m uvicorn app.main:app --port 8000   # AI + rule verification
```
Tests: `cd shipcheck && npm test` (the RCRV production-model tests run on the local `catalog/ships/rcrv/parts.json`;
one test is skipped: it compares against `results-3d.json`, which is neither local nor imported into the database);
`cd backend; .venv\Scripts\python -m pytest -q`.
Browser smoke test of the streamed viewer: `cd shipcheck/tools/export && node --test viewer-smoke.mjs`. Playwright's own
browser is not installed on this machine (`npx playwright install` downloads it); with `CHROME_PATH` set to the
installed Chrome the click-picking step fails in headless mode (also with the code before 16 Nov, so not a regression).

Settings (values never printed or committed): `backend/.env` holds `DATABASE_URL` (Tiger Cloud), Anthropic, OpenAI and
Gemini keys, `AI_COST_PROFILE` (currently `budget`), `BACKEND_API_TOKEN` (optional, see below); `shipcheck/.env` and
`shipcheck/3D_Since_AI/.env` hold the Autodesk APS keys. The database is migrated to `20261113_0006`; the
rule-verification tables are empty (catalog not imported yet: the user should do that with their own name).

## Features (all in `main`)

- **Models:** IFC2x3/IFC4 (web-ifc; all `Pset_*Common` values of the element and its type, FireRating as
  `fire_rating`, `Pset_RailingCommon.Height` as the railing height, door/window outer size as `overall_width` /
  `overall_height`, never as a clear width), Revit `.rvt` via Autodesk (server side, local only), DXF with layer
  convention `<DECK>-<TYPE>` (complete-file check) and DXF markup export, ship/1 JSON.
- **Drawing → 3D** (`shipcheck/src/drawing/`, contracts in `CONTRACT.md`; UI `public/drawing-import.js`): a general
  arrangement as vector PDF (pdf.js), any DXF or SVG becomes a ship/1 model plus real 3D geometry, in the browser,
  without AI. Views (profiles, deck plans, sections, title block) are found and classified; the scale comes from
  several sources that must agree within 5 % (text "1:n", frame numbers × frame spacing, dimensions); deck levels from
  the profile; walls, rooms (free space inside walls, holes, open decks not covered by the deck above), doors (only
  with a drawn swing and leaf), stairs, ladders, fittings and the hull (lofted from profile and deck outlines; the bilge
  below the lowest deck is assumed). Every value carries `basis` (measured / read / typed / assumed), `range` and
  evidence ids; an independent `referee.mjs` checks the geometry. The engineer sees the views on the sheet, corrects
  view kind, deck, elevation, scale and bow direction, converts again, and checks the result overlaid on the drawing.
  Scans (raster images) are refused with a message. Test drawing: AURORA, 28 m research vessel (public PDF, local only
  in `tools/drawing-samples/`, gitignored): 31/31 doors, 48/49 labels as rooms, 7/7 printed cabin areas within 2 % (2
  from the walls alone, 5 joined using the printed area as evidence), scale 1:100 confirmed twice, 0 referee issues,
  about 4 s. Head-to-head with SpaceLens on the same 65 Swiss Dwellings plans it benchmarks on (Stoa
  `junction-dataset-preview`, swiss_dwellings, CC BY 4.0; local only in `tools/drawing-samples/stoa-preview/`), 550
  printed room areas, fully automatic: 94.2 % within 2 % (518/550), or 95.9 % of the 540 areas inside a room we built,
  median error 0.00 %. SpaceLens: 84.4 % of the 390 areas its fill found, median 0.32 % (it leaves the other 160 out;
  strict that is about 60 %). Doors against the CAD twins, each door once: 1,572 of 1,589 (98.9 %), 59/65 plans exact,
  62/65 within one. The answer key counts 1,777: the source data enters 279 doors twice (once per unit) and the PDFs
  draw them twice; a swing drawn twice is now one door (before, the copy made a false double door: 332 doubles instead
  of 91, with twice the clear width). Against the key that is 8/65 plans exact (SpaceLens, counting every drawn swing,
  32/65). Merging the copies first cost 8 room areas (87.1 → 85.6 %); then three general rules raised the areas to
  94.2 %: unit names ("Whg. D", "App. A") are no part of the room name under them (`vocab.mjs` `isUnitLabel`); a
  corner-to-corner cross marking a shaft or void does not cut the space into triangles (`plan-read.mjs` `crossMarks`);
  without a deck plan above and without a profile nothing is taken as open deck. A door gap the drawing closes itself
  (frame or leaf about as long as the door) gets no extra closing lines. Pieces of one hatch on a common grid (deck
  planking) are no stairs: the pilot boat has 2 stairs instead of 7. Left: 10 rooms not found, 22 off by more than 2 %
  (mostly 2–5 %). Scale read on 65/65; median 0.36 s per plan (SpaceLens 0.2 s). Floor plans
  without ship cues are found by their door swings and labels (`views.mjs` `floorPlans`); legend symbols, scale bars and
  border strips are not decks (`dropSymbolPlans`); symmetry counts only for drawings with line work. Remaining misses:
  balconies read as open deck (5–6 % small), apartment names ("App. A") joined to the room name below.
  Tests on data never tuned for (local only, `tools/drawing-samples/stoa-preview/`, `blind/`): the 65 Swiss plans as
  DXF 90.5 % of 550 areas within 2 %; IFC-rendered plans 54/60 (PDF) and 58/60 (SVG) room areas against the IFC model,
  12/14 (Molio); an attic plan fails (35 rooms instead of 1); 56 real architecture PDFs run without crash or timeout
  (fixed: argument spreads over 248,000 segments, a cubic arc search), but sheets with 65,000+ paths take 15–45 s per
  page. Blind test on an unseen ship GA (67' pilot boat, expectations written first in `blind/EXPECTED.md`): failed at
  first (views joined by a frame drawn as strips, a title taken by the wrong view); after the fixes views, 2 decks,
  scale 1:50 and beam are right, but its labels are drawn as outlines (no text), so no room has a name, planking hatch
  gives 7 false stairs, doors 3 instead of 1. Not a blind result any more; a second unseen vector ship GA is still
  needed (the two found were a text specification and a picture handout: nothing invented from either). Final blind
  test, no code changed (Wikimedia SVGs, expectations first in `blind/EXPECTED.md`): I-201 submarine GA: bow, plan,
  external profile and sections found, 23 labelled spaces named (galley, head, cold storage, store, CO's cabin, radar,
  …), 0 doors; but the inboard profile is not split from the sections, 40 "open deck" pieces, tank abbreviations (OFT,
  MBT, WRT, FW) typed as spaces, machinery labels as rooms, size wrong (no scale on the sheet, assumed and flagged).
  I-400 compartment plan: plan and bow right, profile not found, 1 false door. Titanic lifeboat infographic: nothing
  invented (2 unnamed spaces, 0 doors).
  OCR for labels drawn as line work (`src/drawing/ocr.mjs`; tesseract.js 7 with English data, served by the viewer
  server from node_modules, nothing fetched elsewhere): letter-like strokes of one pen are grouped, each group rastered
  on its own and read; readings below 60 % confidence, short symbol readings and stroke rows are dropped; words of one
  line are joined. Suggested and on when a sheet has many such groups and few texts (off for AURORA). Room names read
  this way are marked to check. Pilot boat: 36 labels read (W/C, Shower, Fridge, 2x Bunks, Life Raft, ER Vent, Genset, Hatch, …)
  in about 10–20 s in Node, about 40 s in the browser; rooms on that sheet still suffer from tile and planking hatch
  making small faces. Browser test: `node tools/drawing/ocr-smoke.mjs`. Scorecards: `node tools/drawing/eval-aurora.mjs`, `node tools/drawing/eval-swiss.mjs [--dir … --questions
  … --one-click]`; browser checks: `node tools/drawing/drawing-smoke.mjs`
  and `tools/drawing/shot-3d.mjs` (Playwright with the installed Chrome). Not read yet: stroked text without fonts (the
  RCRV GA), sections (bilge shape), sliding doors, windows in plans.
- **Checker:** min/max/in_set/table_lookup/distance/count/adjacency/requires/data_quality/manual; applicability by
  type, element properties, ship type/size/area/class and keel laying date; rule hierarchy (`relations`), conflicts,
  same requirement; missing data = "not enough info". Results are compact (`checkModel(raw, rules, { details:
  'lazy' | 'eager' })`): explanation, inputs, limit and governing are computed when read. Malformed models and rules
  are reported (`model_issues`, `invalid_rules`), never silently dropped.
- **Escape routes** (`escape.mjs`): element-disjoint second route (min-cost flow), shared-route status, room exits
  (SOLAS group of spaces), assumed openings named; what-if blocking.
- **Viewer:** three.js deck viewer for layout models; streamed real-model viewer (`viewer-stream.js`) with LOD
  pyramid (`tools/export/build-lod.mjs`), BVH tile index, tile parking, part→tile index and a state texture; small
  parts are framed so they fill the view. Tested with a synthetic cruise ship (360 m, 2.3 M parts, 112 M triangles,
  11,158 tiles): first picture about 8 s, 60 fps, pick 0.1 s. The normalised model shares element objects with the
  raw model (about 47 MB instead of about 174 MB for 2.3 M parts).
- **Towards submission:** findings register per project and revision (`dispositions.mjs`: stale dispositions,
  orphans when an element or rule is gone, move to a new id), class comments (`class-comments.mjs`: comment sheets in
  English/German, letters with numbered/lettered/coded references, evidence states finding / missing / what_if /
  unscoped / no_finding, answered-but-unconfirmed warning), manual checks tied to the element's data (fingerprint:
  stale after a change), readiness (`readiness.mjs`: blockers and warnings; "applicability open" counted apart from
  missing data, with its rules), project file (`project-file.mjs`: cleaned on open, dropped parts named), report, CSV
  exports (formula-safe), traceability matrix. Browser storage: failed saves are reported, other tabs are followed.
- **Security:** Origin/Host/proxy-header checks and JSON-only bodies on the viewer server (`request-guard.mjs`),
  localhost binding (`HOST`, `TRUST_PROXY`), byte-limited bodies, Content-Security-Policy on every page (scripts only
  from the site, the inline import map by hash, wasm for IFC, Autodesk hosts for the APS view; no inline handlers),
  backend `AccessMiddleware` with `BACKEND_API_TOKEN` (min. 24 characters) for anything not on localhost.
- **AI** (backend `ai_chain.py`, `ai_assist.py`): explain finding, escape-route proposals, comment replies; streaming
  via SSE; fail-over chain; cost per answer shown.
- **Rule verification, phase 1** (backend `rule_verification.py`, UI `verify.html`): sources stored once by SHA-256,
  verbatim quotes checked against the source, level 1 and level 2 (four eyes by name), immutable tables, audit log.
- **Docker:** the image now contains the bundled catalog (`shipcheck/catalog`); with `SHIPCHECK_DATA_API_URL` set the
  database API is the source instead.

## RCRV production model (local only, not in Git)

Rebuilt on 15 Nov from `shipcheck/model/12100-RCRV-199_07-08-2021.nwd` with the existing APS conversion (no re-upload,
no new credits): `catalog/ships/rcrv/parts.json` (69,993 parts), `model/stream-hp` (851 tiles, 50.8 M triangles) plus
the LOD pyramid. At runtime the viewer contacts only localhost, never Autodesk. 35,328 parts are checked; 3,428 of the
7,079 "not enough info" results are open only because the model does not say whether the rule applies (rules
IACS-W11-HULL-GRADE, LL-REG12-SILL, SOLAS-II-2-4.2.2.5.1-FO-PIPE). The LOD tiles must be built on any server that
serves the model (`tools/export/build-lod.mjs`).

## Rules the user set (keep them)

- Commit or push only when the user asks; push to `main`, never force-push; fetch before pushing; check the diff for
  secrets first. Do not commit root `package-lock.json`, `.claude/` or `shipcheck/3D_Since_AI/model-views.json`.
- Never print, log or commit `.env` values, keys, database URLs or server IPs; scripts may load them from `.env`.
  (The server IP was removed from `backend/.env.example` on 16 Nov; it is still in the Git history.)
- Ask before deleting files or adding services that need accounts. Never invent rule values or legal relations
  between rules (they need a source). Pass/fail only from the checker.
- Never call Autodesk APS (no conversions or uploads: they cost credits); never write to the rule-verification tables.
- The user prefers reasoning over long test runs, short and clear answers, and is often answered in German.
- README says the team convention is push to `dev`, `main` auto-deploys (landing page via Netlify); we pushed to `main`
  on the user's instruction. The user should confirm the convention with the team.

## Open points

1. **Need the user or the team:**
   - Rule values need the official text as a source: DEADEND-PAX 13 m, FSS 900 mm for cargo ships, scope of UR S6 and
     IGC, the note "reviewed by Meyer mentors". Until then they stay "unverified".
   - Landing page dependencies are `latest` in the root `package.json`; pinning them needs the root
     `package-lock.json` updated in the same commit (the lock is not committed by rule, so this waits for a decision).
   - `shipcheck/3D_Since_AI/model-views.json` is tracked but written by `extract.mjs`; untracking it removes it from
     the repository for everyone.
   - Deployment: the public site still shows the hackathon version; the database catalog lacks the manual rules;
     the LOD tiles must be built on the server.
   - Four-eyes verification uses typed names; real user accounts need a decision on the identity provider.
2. **Features:** escape rules read hand-typed properties instead of deriving widths and lengths from geometry; OCX
   import (needs a sample file); streaming for large IFC files; shared multi-user storage in the database instead of
   browser storage + project file; fire divisions / fire control plan check.
3. **Known cosmetic issues:** bow view looks steeply down; 3D/Top/Side/Bow buttons stay visible in plan view; report
   overflows on narrow windows; a finding without geometry is not drawn in the DXF markup.
4. **Data:** the extracted SOLAS II-2 passages (`shipcheck/integrations/sinceai/data/*.jsonl`) are not on this machine,
   so the evidence-page search is disabled with a message.
