# Complee

Compliance checking for ship design. Complee checks a ship model (IFC, Revit, AutoCAD DXF or its own JSON format)
against class and statutory rules, shows every finding in a 3D viewer with the rule text and the values it used, and
takes the engineer through to a submission to class: findings register, class comments, manual checks and a
readiness check.

**Pass or fail is always decided by a deterministic rule checker, never by AI.** The AI explains findings, proposes
design changes (which the checker recomputes) and drafts replies to class comments. The rule texts in the bundled
catalog are paraphrases and are marked unverified until checked against the official text (see
[Rule verification](#rule-verification)). Complee is a pre-check for engineers, not an approval: approval stays with
class and flag.

## What it does

| Area | What the engineer gets |
| --- | --- |
| **Models** | Open IFC (IFC2x3 / IFC4), Revit `.rvt` (converted to IFC through Autodesk Platform Services), AutoCAD DXF (layer convention `<DECK>-<TYPE>`) or ship/1 JSON. Results go back to AutoCAD as a DXF markup. |
| **Rule check** | Every applicable rule per element, with measured and required value and where each input comes from. Missing data gives "not enough info", never a guess. Rule hierarchy (replaces / exempts, with a stated basis), rule conflicts, applicability by ship type, size, area, class and keel laying date. |
| **3D viewer** | Findings coloured in the model, deck and plan views, measuring, what-if editing of values, revision comparison. |
| **Escape routes** | Routes from every room to the muster stations, independent second routes, what-if blocking of a door or corridor, AI proposals for a second route (recomputed before they are shown). |
| **Towards submission** | Findings register per project and revision, class comment tracker (import a class letter or comment sheet; the rule check shows whether each comment is resolved), manual checks for requirements no algorithm can decide, a readiness check (blockers and warnings), report, CSV and a project file to hand the work over. |
| **AI** | Short explanations of findings, escape-route proposals, draft replies to class comments. A model chain with fail-over (Claude, GPT, Gemini), a budget profile of about 1 cent per answer, answers stream in while the model writes. |
| **Rule verification** | Official sources, verbatim quotes checked against the source, level 1 (text check) and level 2 (engineering review, four eyes), immutable history in the database (`verify.html`). |

## Repository layout

| Folder | What it is | Details |
| --- | --- | --- |
| [`shipcheck/`](./shipcheck) | **The application**: Node server, rule checker, 3D viewer, imports, register, comments, reports. Runs on its own with the bundled rule catalog. | [shipcheck/README.md](./shipcheck/README.md) |
| [`backend/`](./backend) | FastAPI service with PostgreSQL (Tiger Cloud): AI model chain, rule verification, regulation database, document extraction. Needed for AI and rule verification; the viewer works without it. | [backend/README.md](./backend/README.md) |
| `src/`, `public/`, `index.html` | Complee landing page (React, Vite). | below |
| `docs/` | Workflow notes; `docs/archive/` holds the hackathon documents. | |
| `scripts/` | `start-dev.ps1`: start the landing page dev server on Windows without a terminal. | |

## Quick start

**The application (viewer, checker, imports)**, Node 20 or newer:

```bash
cd shipcheck
npm install
npm start
```

Open http://localhost:8080 (evidence intake) or http://localhost:8080/index.html (the design review). No database or
network is needed: the rules, scenarios and example ships come from `shipcheck/catalog/`.

**AI and rule verification** need the backend, Python 3.11 or newer, with a PostgreSQL database URL and at least one
AI key in `backend/.env` (template: `backend/.env.example`):

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m alembic upgrade head
.venv\Scripts\python -m uvicorn app.main:app --port 8000
```

The viewer finds the backend at http://127.0.0.1:8000 and shows the AI as available in its top bar.

**Landing page with the application at `/inspection/`**:

```bash
npm install
npm ci --prefix shipcheck
npm run dev
```

Open http://localhost:5173. On Windows `.\scripts\start-dev.ps1` starts it in the background (`-Restart`, `-Stop`).

## Tests

```bash
cd shipcheck && npm test
```

```powershell
cd backend; .venv\Scripts\python -m pytest -q
```

## Rule verification

The bundled rules are paraphrases. To verify a rule, start the backend and open http://localhost:8080/verify.html:
import the catalog rules (they become drafts), add the official source document, back each value with a verbatim
quote (the page checks it against the source), then record level 1 (text check) and level 2 (engineering review by a
second person). The viewer and the report show each rule's level. Unverified values and open questions are listed in
[shipcheck/VERIFY.md](./shipcheck/VERIFY.md).

## Data that is not in the repository

- `backend/.env` and `shipcheck/.env`: database URL, AI keys, Autodesk (APS) keys. Never commit them.
- The full production model of the RCRV (`shipcheck/catalog/ships/rcrv/parts.json` and its 3D tiles): too large for
  Git. Without it the viewer offers the bundled example ships only.
- The extracted SOLAS II-2 passages for the evidence search
  (`shipcheck/integrations/sinceai/data/solas_ii2_revised_mca.jsonl`): licensed text.

## Working with Git

Push changes to the `dev` branch; `main` is deployed automatically when changes are put there (the landing page is
built by Netlify, `netlify.toml`). Commit messages describe what changed and why.

## Deployment

Landing page on Netlify: set `VITE_SHIPCHECK_REVIEW_URL` to the public ShipCheck URL. The landing page's evidence and
AI workspaces call the backend from the browser; the backend now refuses other computers unless they send its access
token, which must never be put into a web page, so these workspaces work only where the backend runs (`VITE_API_BASE_URL`
pointing at a public backend no longer works, by design). ShipCheck on a server (Vultr): see
[shipcheck/README.md](./shipcheck/README.md#deploy-to-vultr); set the same `BACKEND_API_TOKEN` on ShipCheck and the
backend when they run on different computers. Backend: see [backend/README.md](./backend/README.md#access).

Created by team KEEP.
