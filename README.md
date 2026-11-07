# Complee

An illustrative landing page for an AI-assisted ship-design compliance concept. Complee is intended to help engineers surface potentially relevant requirements, missing design information and review actions early in design.

This is a hackathon concept, not a working compliance tool. Interface findings are illustrative, require engineer review, and are not verified class-rule interpretations. Local-first deployment is an architectural goal.

## Run locally

```sh
npm install
npm run dev
```

The navigation opens the evidence intake in the same app. The intake accepts documents, drawings and 3D model files; DOCX text review is enabled in this demo and retrieves candidate passages through the optional SinceAI SOLAS II-2 adapter. Continuing returns to the illustrative R/V Taani model inspection. Original files are processed in the browser and are not persisted; only selected file names and sizes carry into the design demo. The extracted source corpus is ignored by Git and can be placed at `integrations/sinceai/data/solas_ii2_revised_mca.jsonl`; set `EVIDENCE_PROVIDER=none` to disable source retrieval. This is local-demo middleware in Vite, not a production upload service.

The local dev site opens on the evidence intake workflow. It accepts document, drawing and 3D model files in the browser; the demo's document text reviewer currently supports DOCX and retrieves candidate passages from the optional SinceAI SOLAS II-2 adapter. The next step opens the illustrative R/V Taani model review already included in the app. Original files are processed in the browser and are not persisted; only selected file names and sizes carry into the design demo. The extracted source corpus is ignored by Git and can be placed at `integrations/sinceai/data/solas_ii2_revised_mca.jsonl`; set `EVIDENCE_PROVIDER=none` to disable the source adapter. This is local-demo middleware in Vite, not a production upload service.

### Pages on the dev server (http://localhost:5173)

| Page | What it is |
| --- | --- |
| `/landing` | This Complee landing page (`/` redirects here). |
| `/inspection/` | ShipCheck from `shipcheck/`: evidence intake, then the checker with the real RCRV 3D model at `/inspection/index.html`. |
| `/#ai-settings` | Backend-backed AI provider configuration, model routing, provider testing and text extraction review. Requires the FastAPI setup described in `backend/README.md`. |

ShipCheck needs its own dependencies and, for the 3D viewer, the APS keys in `shipcheck/3D_Since_AI/.env` (not in Git):

```sh
cd shipcheck && npm install && cd ..
npm run dev
```

`/inspection/` only exists on the dev server (ShipCheck runs as Node middleware); `npm run build` builds the landing page only.
ShipCheck can still run on its own: `cd shipcheck && npm start` (port 8080).

Create a production build with `npm run build`.

## Stack

React, TypeScript, Vite, GSAP/ScrollTrigger, and Lucide icons.

## Development
Push changes to the dev branch, main branch will be deployed automatically when you put your changes there.

- Created by team KEEP
