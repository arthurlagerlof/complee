# Complee: handoff for the next session

State as of 15 Nov 2026, last commit `4275faf` on `main`
(GitHub: `flip18731/complee`, second remote `arthurlagerlof/complee`).

## What Complee is

A compliance pre-check for ship design. It checks a ship model (IFC, Revit, AutoCAD DXF, its own ship/1 JSON, or the
RCRV production model) against class and statutory rules and shows every finding in a 3D viewer with the rule text,
the measured and required value and where each value comes from. It takes the engineer up to a submission to class:
findings register, class comments, manual checks, readiness check, report.

**Core principle:** pass or fail comes only from a deterministic rule checker (`shipcheck/src/checker.mjs`), never from
AI. AI explains, proposes (proposals are recomputed by the checker) and drafts text. Rule texts in the bundled catalog
are paraphrases and unverified until checked against the official text. The tool is a pre-check, not an approval.

Started at the Since AI Hackathon (Turku, 7–8 Nov 2026, Meyer Turku challenge, team KEEP); everything after commit
`f3351db` (8 Nov) was added afterwards: 22 commits, 120+ files.

## Repository layout

| Folder | Content |
| --- | --- |
| `shipcheck/` | The application: Node server (`server.mjs`), checker and data modules (`src/`), web UI (`public/`), bundled catalog (`catalog/`), tests (`tests/`), export pipeline for the production model (`3D_Since_AI/`, `tools/export/`). |
| `backend/` | FastAPI + PostgreSQL (Tiger Cloud): AI model chain and viewer assistance, rule verification, regulation database, document extraction. |
| `src/`, `public/`, `index.html` | Complee landing page (React, Vite). |
| `docs/` | This file; `docs/archive/` holds the hackathon documents. |

READMEs are current: `README.md`, `shipcheck/README.md`, `backend/README.md`.

## How to run

```bash
cd shipcheck && npm start        # http://localhost:8080 (evidence intake), /index.html (review), /verify.html
```
```powershell
cd backend; .venv\Scripts\python -m uvicorn app.main:app --port 8000   # AI + rule verification
```
Tests: `cd shipcheck && npm test` (163 pass, 12 skipped need the database API);
`cd backend; .venv\Scripts\python -m pytest -q` (101 pass).

Settings (values never printed or committed): `backend/.env` holds `DATABASE_URL` (Tiger Cloud), Anthropic, OpenAI and
Gemini keys, `AI_COST_PROFILE` (currently `budget`, about 1 cent per answer); `shipcheck/.env` and
`shipcheck/3D_Since_AI/.env` hold the Autodesk APS keys. The database is migrated to `20261113_0006`; the
rule-verification tables are empty (catalog not imported yet: the user should do that with their own name).

## Features (all in `main`)

- **Models:** IFC2x3/IFC4 (web-ifc, fire ratings from `Pset_*Common`), Revit `.rvt` via Autodesk (server side, local
  only), DXF with layer convention `<DECK>-<TYPE>` and DXF markup export, ship/1 JSON. Import report after IFC import.
- **Checker:** min/max/in_set/table_lookup/distance/count/adjacency/requires/data_quality/manual; applicability by
  type, element properties, ship type/size/area/class and keel laying date (`applies_to.ship.constructed`); rule
  hierarchy (`relations`: replaces/exempts with a basis), conflicts, same requirement; missing data = "not enough
  info"; wording "No deviation found" with a coverage line.
- **Viewer:** three.js deck viewer for layout models; streamed real-model viewer (`viewer-stream.js`) for the
  production model; plan view, measuring, what-if editing, revision comparison, escape routes with what-if blocking.
- **Towards submission:** findings register per project and revision (`dispositions.mjs`), class comments
  (`class-comments.mjs`), manual checks, readiness (`readiness.mjs`), project file (`project-file.mjs`), report,
  CSV exports (BOM + CRLF), traceability matrix.
- **AI** (backend `ai_chain.py`, `ai_assist.py`): explain finding, escape-route proposals, comment replies; streaming
  via SSE; fail-over chain; cost per answer shown. Viewer server forwards `/api/assist/*` for localhost only.
- **Rule verification, phase 1** (backend `rule_verification.py`, UI `verify.html`): sources stored once by SHA-256,
  verbatim quotes checked against the source, level 1 and level 2 (four eyes by name), immutable tables with
  PostgreSQL triggers, audit log; the viewer shows each rule's level when its logic hash matches.

## RCRV production model (local only, not in Git)

Rebuilt on 15 Nov from `shipcheck/model/12100-RCRV-199_07-08-2021.nwd` with the existing APS conversion (no re-upload,
no new credits): `3D_Since_AI/model-properties.json` (154 MB), `catalog/ships/rcrv/parts.json` (69,993 parts),
`tools/export/work/svf` (431 MB), `model/*.glb`, `model/stream`, `model/stream-hp` (851 tiles, 50,843,045 triangles,
audit PASS), overview 706 tiles. At runtime the viewer contacts only localhost, never Autodesk. Measured: rule check
0.16 s for 35,328 parts, first picture 1.6 s, 58 fps median during camera flights. Ground truth 13/13, 0 false alarms.

## Rules the user set (keep them)

- Commit or push only when the user asks; push to `main`, never force-push; fetch before pushing; check the diff for
  secrets first. Do not commit root `package-lock.json`, `.claude/` or `shipcheck/3D_Since_AI/model-views.json`.
- Never print, log or commit `.env` values, keys, database URLs or server IPs; scripts may load them from `.env`.
- Ask before deleting files or adding services that need accounts. Never invent rule values or legal relations
  between rules (they need a source). Pass/fail only from the checker.
- The user prefers reasoning over long test runs, short and clear answers, and is often answered in German.
- README says the team convention is push to `dev`, `main` auto-deploys (landing page via Netlify); we pushed to `main`
  on the user's instruction. The user should confirm the convention with the team.

## Open points

1. **Website check:** points 1–5 done (main path, file import, 3D viewer, panels together, exports).
   Still open: 6 robustness (backend/AI off, no internet, small screen, reload mid-work) and 7 clean-up.
2. **Known cosmetic issues:** bow view looks steeply down; 3D/Top/Side/Bow buttons stay visible in plan view; report
   overflows on narrow windows; a finding without geometry is not drawn in the DXF markup.
3. **Rule verification phase 2/3:** test cases per rule, level 2 checklist UI, catalog releases exported to
   `rules.json`, change detection when a source paragraph changes, user accounts instead of typed names. Product
   direction discussed: customers bring/verify their own rule sets; we ship draft rule packs.
4. **Data:** the extracted SOLAS II-2 passages (`shipcheck/integrations/sinceai/data/*.jsonl`) are not on this machine,
   so the evidence-page search is disabled with a message.
5. **Ideas not built:** OCX import (needs a sample file), streaming for large IFC files, shared multi-user storage in
   the database instead of browser storage + project file, fire divisions / fire control plan check.
6. **Disk:** drive C: had about 7 GB free after the model rebuild.
