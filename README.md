# Complee

An illustrative landing page for an AI-assisted ship-design compliance concept. Complee is intended to help engineers surface potentially relevant requirements, missing design information and review actions early in design.

This is a hackathon concept, not a working compliance tool. Interface findings are illustrative, require engineer review, and are not verified class-rule interpretations. Local-first deployment is an architectural goal.

## Run locally

```sh
npm install
npm run dev
```

The navigation opens the single evidence intake in the same app. Its optional regulatory passage review remains a local Vite demo and supports DOCX. The **Extract review candidates** workflow uses the FastAPI backend and the existing design revision and AI configuration: implemented parser support is DOCX/TXT, DXF, and glTF 2.0 (`.glb`/`.gltf`, including uploaded `.bin` sidecars). Other listed formats are not parsed. Source files and deterministic parser output are retained in the application database; AI candidates remain separate until an engineer approves and imports them. See [backend/README.md](./backend/README.md) for setup, limits, and API routes. Continuing still opens the illustrative R/V Taani model inspection. The extracted regulatory source corpus is ignored by Git and can be placed at `shipcheck/integrations/sinceai/data/solas_ii2_revised_mca.jsonl` (the Vite dev server uses the ShipCheck evidence modules); set `EVIDENCE_PROVIDER=none` to disable that separate source-retrieval demo.

The local dev site opens on evidence intake. The separate demo passage reviewer retrieves candidate passages through the optional SinceAI SOLAS II-2 adapter. Engineering extraction sends supported files to FastAPI and requires an existing design revision and configured extraction task or backend Gemini settings. The extracted source corpus is ignored by Git and can be placed at `shipcheck/integrations/sinceai/data/solas_ii2_revised_mca.jsonl` (the Vite dev server uses the ShipCheck evidence modules); set `EVIDENCE_PROVIDER=none` to disable only the regulatory source adapter.

### Pages on the dev server (http://localhost:5173)

| Page | What it is |
| --- | --- |
| `/landing` | This Complee landing page (`/` redirects here). |
| `/inspection/` | ShipCheck from `shipcheck/`: evidence intake, then the checker with the real RCRV 3D model at `/inspection/index.html`. |
| `/#ai-settings` | Backend-backed AI provider configuration, model routing, provider testing and text extraction review. Requires the FastAPI setup described in `backend/README.md`. |

ShipCheck needs its own dependencies. The default local viewer uses files in `shipcheck/model/`; APS keys are only needed for the optional `?viewer=aps` fallback:

```sh
cd shipcheck && npm install && cd ..
npm run dev
```

`/inspection/` only exists on the dev server (ShipCheck runs as Node middleware); `npm run build` builds the landing page only.
ShipCheck can still run on its own: `cd shipcheck && npm start` (port 8080).

On Windows, start or recover both pages without keeping a terminal open:

```powershell
.\scripts\start-dev.ps1
# Restart this project server: .\scripts\start-dev.ps1 -Restart
# Stop it: .\scripts\start-dev.ps1 -Stop
```

The helper uses port 5173, checks the inspection health endpoint, and preserves startup logs in the gitignored `.run/` directory. It reuses a running project server and refuses to stop unrelated applications. Model files are served by the same app in local development unless `MODEL_BASE_URL` explicitly selects a separate model host. `npm run dev` remains available for a foreground terminal session; stopping that session stops the app.

Create a production build with `npm run build`.

## Stack

React, TypeScript, Vite, GSAP/ScrollTrigger, and Lucide icons.

## Development
Push changes to the dev branch, main branch will be deployed automatically when you put your changes there.

- Created by team KEEP
