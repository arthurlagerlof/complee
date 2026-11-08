# ShipCheck end-to-end workflow: audit and integration plan

Status: audit of `main` on 8 Nov 2026 (after commit 3c2b02c). This file is the dependency map for connecting the
existing pieces into one flow: **understand the design → understand the regulations → assess the design**.
Each section says what already exists (and is kept), and what is actually missing.

## 1. Capability map

| Stage | Capability | Where | Status |
|---|---|---|---|
| Project | Projects, vessels, design revisions, components, facts, relationships | `backend/app/db/models/design.py`, `api/routes/design.py` | Implemented |
| Project | Revision becomes immutable once a completed assessment uses it | `services/design/service.py::ensure_revision_editable` | Implemented (kept) |
| 1 Upload | Multi-file upload per revision, original file stored in DB, SHA-256, status, method, provider/model, timestamps, partial success per file | `api/routes/ai.py::upload_extractions`, `SourceDocument` | Implemented |
| 1 Parse | TXT and DOCX (paragraphs and tables with `paragraph:N` / `table:N:row:R:column:C` references) | `services/extractions/adapters.py` | Implemented |
| 1 Parse | DXF: layers, blocks, entities, text, dimensions, coordinates (ezdxf) | `adapters.py::_parse_dxf` | Implemented |
| 1 Parse | glTF 2.0 / GLB: scene graph, parent/child, local and world transforms, world bounds, mesh/primitive summary, extras, extensions, external buffers | `adapters.py::_parse_gltf` | Implemented |
| 1 Parse | PDF text | — | **Missing** (upload is refused as unsupported) |
| 1 AI | Candidate extraction through the AI gateway (`text_component_extraction` task, built-in Gemini fallback from `GEMINI_API_KEY`/`GEMINI_MODEL`), evidence grounding, geometry references for model nodes, knowledge-layer context | `services/ai.py::create_extraction` | Implemented |
| 1 AI | Model branches grouped for interpretation | AI receives one JSON line per node (with parent index) | **Partial**: no branch-level grouping or aggregated bounds |
| 1 Review | Engineer review of component, property, relationship and fact candidates; import of approved candidates only | `api/routes/ai.py` PATCH/`import`, `ai.py::import_approved_candidates` | Implemented |
| 1 Reconcile | Import matches an existing component by type+name or tag and adds the new source's values as facts (sources kept side by side) | `import_approved_candidates` | Implemented |
| 1 Reconcile | Conflicting values across sources flagged | `assessment/checks.py::disagreements`, `completeness_report` | Implemented (flagged during assessment, never overwritten) |
| 2 Retrieval | Hybrid (BGE-M3 dense + full text), vector, full-text search with filters | `services/retrieval/service.py` | Implemented; BGE-M3 needs `requirements-retrieval.txt` and a model cache |
| 2 Retrieval | Revision → retrieval query | `retrieval/adapters.py::VersionedDesignQueryAdapter` | Implemented |
| 2 Knowledge | Component taxonomy, expected properties, abbreviations, regulatory terms, units | `services/knowledge/` | Implemented |
| 2 Design search | Semantic search over design components | — | **Missing** (no design embeddings; see section 4) |
| 2 Interpretation | AI maps a provision to design evidence, quantitative conditions gated by a verbatim quote | `assessment/ai_review.py` | Implemented; **no exceptions / alternative interpretations / ambiguity factors** |
| 3 Checks | Structured requirements tied to provisions (ADA 404.2.3, 403.5.1, 405.2; SOLAS II-2/13/3.3.4, II-2/4/2.2.5.1) with completeness, consistency and deterministic comparison | `assessment/checks.py` | Implemented |
| 3 Tools | `geometry` (distance, bounding-box distance, clearance, area, volume), `requirement_comparison`, `documents`, `fluid`, `structural` | `services/calculations/` | Implemented; **no intersection/containment, no module metadata (inputs, units, limitations, version)** |
| 3 Orchestration | `POST /assessments/run` (retrieval → candidate findings), `POST /engineering-checks/run`, `POST /engineering-checks/ai-review` | `assessment/orchestrator.py`, `checks.py`, `ai_review.py` | Implemented separately; **not chained**, each run completes (and so locks) the revision |
| 3 Scores | Rule ambiguity score, estimated compliance likelihood | — | **Missing** (only a per-finding `confidence`) |
| 3 Automation | Assessment after candidate import | — | **Missing** |
| 3 Review | Engineer review of findings (`PATCH /findings/{id}`), statuses, `verified_by_engineer` | `assessment/service.py` | Implemented |
| UI | Evidence intake: revision, upload, candidate review, import, regulation search, Gemini document review | `src/EvidenceIntake.tsx` | Implemented |
| UI | Findings workspace: completeness, checks, AI review, finding review | `src/FindingsWorkspace.tsx` | Implemented; **no matrix, no scores, no hand-over from import** |
| UI | Reference model (R/V Taani preview; ShipCheck RCRV streaming viewer from private Vultr storage) | `src/VesselViewer.tsx`, `shipcheck/` | Implemented (kept as is) |
| UI | Viewer for an uploaded design model with component highlighting | — | **Missing** (the file is stored and served by `GET /ai/source-documents/{id}/file`) |
| Ops | Persistent job queue | — | **Missing**; assessment rows serve as the persistent run record (section 3) |
| Ops | User accounts and project-level authorization | — | **Missing** (no accounts exist yet; future work) |

## 2. Integration gaps addressed in this change

1. **Scores** (`services/assessment/scoring.py`): every finding gets a rule ambiguity score (0–100, explained by
   factors with the source words that triggered them) and a separate estimated compliance likelihood (0–100 or
   `not_estimable`, never calibrated, method and version recorded). Stored in `calculation_results.scores`; no
   schema migration.
2. **Comparison modules** (`services/calculations/modules.py`): named modules (`geometry.distance`,
   `geometry.clearance`, `geometry.intersection`, `geometry.containment`, `geometry.volume`,
   `properties.numeric_comparison`, `properties.completeness`, `evidence.document_comparison`) with inputs, units,
   method, limitations and version, backed by the existing tools; intersection and containment are added to the
   geometry tool.
3. **Workflow orchestrator** (`services/assessment/workflow.py`): one run per revision chains structured checks,
   retrieval (hybrid, falling back to full text when BGE-M3 is not installed, and saying so), optional AI
   interpretation, method selection and scoring into one assessment. Runs are *provisional* (the revision stays
   editable); a new run supersedes the previous provisional one and marks which findings changed; *finalize*
   completes the assessment and locks the revision exactly as before.
4. **Automation**: importing approved candidates queues a provisional run in the background.
5. **PDF text** extraction with page references; **model branch groups** for AI interpretation.
6. **UI**: the findings workspace becomes the results page: run status, compliance matrix with both scores,
   provision text, evidence, calculations, missing information, review, and an uploaded-model viewer.

## 3. Decisions

- **No migration.** Scores, run inputs and the change summary live in the existing JSON columns of `sc_findings`;
  the assessment row (`status`: `queued` → `running` → `provisional` / `failed` / `superseded` / `completed`) is the
  persistent, retryable run record.
- **Provisional vs completed.** Automatic runs must not lock a revision that is still receiving sources, so they
  stay provisional. Finalizing checks that the design data has not changed since the run (fingerprint) and then
  completes the assessment, which makes the revision immutable as before.
- **AI never decides.** Pass/fail-type results come only from executed deterministic tools; AI output without an
  executed comparison yields `not_estimable`. A score never changes a finding's status or review state.
