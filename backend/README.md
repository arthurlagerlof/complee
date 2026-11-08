# Ship Compliance API

FastAPI modular monolith for versioned ship-design data, regulatory candidate retrieval and engineer-reviewed assessments. Retrieval identifies relevant candidate provisions; it does not determine applicability, compliance, safety or class approval.

## Architecture

- **Design understanding** (`app/services/design`): projects, vessels, revisions, components, relationships, source references and design facts. `app/services/extractions` provides deterministic DOCX/TXT, text-based PDF (per line, with page numbers; no OCR), DXF and glTF 2.0 adapters; for glTF it also builds branch groups (assemblies with aggregated world bounds) that the AI interprets as logical objects, and a cited group maps back to its mesh nodes for viewer highlighting. AI results stay in reviewable extraction records until explicitly imported.
- **Regulatory retrieval** (`app/services/retrieval`): read-only queries against the existing regulatory tables, local BGE-M3 query embedding, vector search, full-text search, metadata/applicability filters and hybrid ranking.
- **Assessment** (`app/services/assessment`): candidate-to-design orchestration, reusable calculation/evidence tools, immutable source snapshots and engineer review. An assessment never declares compliance automatically.
- **Engineering checks** (`app/services/assessment/checks.py`, `app/services/calculations/comparison.py`): five structured requirements, each tied to a provision in the regulation database whose figure was read there (ADA 404.2.3 door clear width, ADA 403.5.1 walking surface width, ADA 405.2 ramp slope, SOLAS II-2/13/3.3.4 dead-end corridors, SOLAS II-2/4/2.2.5.1 oil fuel pipe material). `POST /api/v1/engineering-checks/run` checks each applicable component (catalogue type resolved from its type and name) for (1) completeness: is the needed property in any source; (2) consistency: do the drawing, specification, model and document values agree after unit conversion; (3) the deterministic comparison (`requirement_comparison` tool, also in the calculation registry). Each finding stores the provision snapshot with edition, the component, every source value with its origin, the required value and quoted source text, the calculation, missing information, scope and vessel-type applicability assumptions, a confidence with its formula, and status `open` for engineer review. `GET /api/v1/engineering-checks` lists the checks; `GET /api/v1/design-revisions/{id}/completeness` reports key properties and source disagreements for every component against the knowledge catalogue (computed, not stored).
- **AI-assisted provision review** (`app/services/assessment/ai_review.py`): `POST /api/v1/engineering-checks/ai-review` with a revision and up to 10 retrieved provision ids (from `/regulations/search`). The AI (task `engineering_assistance`, else the backend Gemini) maps each provision to the revision's design data with the knowledge-layer context: relevant components and values, missing information, applicability questions and any quantitative condition. It makes no compliance decision. A condition is calculated only when its required-value quote appears verbatim in the provision text; the deterministic `requirement_comparison` tool then uses the design value from the database, never a value from the AI. Results are stored as open findings (`verification_method` `ai_assisted_review`) with the AI execution id.
- **Engineering knowledge layer** (`app/services/knowledge`, data in `catalogue.json`): 21 component types (SWBS-grouped taxonomy) with expected properties and units, 8 relationship types with inverses, 56 maritime abbreviations (ambiguous ones such as BW, DB, FD, MCR, P flagged with all meanings), yard tag conventions, unit conversion to canonical units, and 16 regulatory terms whose official definitions are read from the regulation database by clause key (SOLAS II-2/3/…). It holds no regulatory limit values and no project data. The AI extraction prompt (`text-component-extraction.v2`) includes a context built from it for each source: the component types the text appears to mention, their expected properties and relationships, the abbreviations used, unit conventions and the official definitions involved, marked as background knowledge that must never be used as a source value. Component types also link to regulatory retrieval (catalogue clause prefixes plus full-text matches for their terms). Read-only routes under `/api/v1/knowledge`: `catalogue`, `component-types[/{id}[/regulations]]`, `abbreviations`, `terms`, `POST interpret` (deterministic hints for a name or text, optional prompt context) and `POST convert`.
- **Assessment workflow** (`app/services/assessment/workflow.py`): `POST /api/v1/design-revisions/{id}/assessment-runs` assesses a revision end to end in one assessment: the structured checks, retrieval per catalogue component type (hybrid; when BGE-M3 is not installed it falls back to full text and records why), AI interpretation of the top provisions (optional; skipped and reported when no AI is configured), the remaining provisions as review candidates, and both scores for every finding. Importing approved candidates (`POST /ai/extractions/{id}/import`, `auto_assess` default true) queues a run in the background. Runs are provisional, so the revision stays editable; a new run supersedes the previous one and marks findings `new`/`changed`/`unchanged` (earlier reviews are referenced, never copied); identical or active runs are not repeated (`force` overrides). `POST /assessment-runs/{id}/finalize` completes the run only if the design fingerprint is unchanged, which locks the revision; `POST /assessment-runs/{id}/retry` re-runs a failed or stalled run; `GET /design-revisions/{id}/assessment-runs` and `GET /assessment-runs/{id}` report status, stage results and changes. Every finding stores the requirement interpretation, the comparison method and result, and the run record (inputs, design fingerprint, stages, errors). Add `?wait=true` to run in the request.
- **Scores** (`app/services/assessment/scoring.py`): each finding has a rule ambiguity score (0–100 with bands, explained by factors and the provision words that caused them) and a separate estimated compliance likelihood (0–100 or `not_estimable` with the information needed; heuristic, `not_calibrated`, method versioned). The likelihood is only estimated when a deterministic comparison actually ran. Exposed on findings as `rule_ambiguity`, `compliance_likelihood`, `assessment_status`, `review_status` and `provision_reference` (stored in `calculation_results.scores`; no migration).
- **Calculation modules** (`app/services/calculations/modules.py`): `geometry.distance`, `geometry.clearance`, `geometry.intersection`, `geometry.containment`, `geometry.volume`, `properties.numeric_comparison`, `properties.completeness` and `evidence.document_comparison`, each with inputs, units, method, output, limitations and version (`GET /api/v1/calculations/modules`, `POST /api/v1/calculations/modules/{name}`), running on the existing tools.

Application models use `ApplicationBase.metadata`. Exact, read-only legacy mappings use independent `LegacyBase.metadata`. Alembic imports only application metadata and filters to `sc_*` tables. Legacy identifiers are validated application-level references; the migration does not add foreign keys to externally managed tables.

## Existing regulatory database

The configured PostgreSQL endpoint was inspected read-only. It contains:

| Table | Columns and role |
|---|---|
| `public.instruments` | UUID id, unique code, name, authority, source availability, source URL, note and vessel-type `text[]` applicability |
| `public.provisions` | UUID id, instrument and parent UUIDs, clause key, heading path, canonical body, language, edition, provision availability, topic `text[]` applicability, generated `search_tsv` and embedding |
| `public.design_facts` | UUID id, kind, name, deck, value and source file |
| `public.findings` | UUID id, design-fact/provision references, ranking explanation, cited clause/heading/body snapshot and availability; these are saved retrieval matches, not assessment findings |

Observed counts were 3 instruments, 11,924 provisions, 1 legacy design fact and 1 saved retrieval finding. All provision embedding values are present; the column type is `extensions.vector(1024)`. The vector extension is installed in `extensions`; the provision full-text column is generated with English `to_tsvector` and has a GIN index. No vector index was present.

The legacy schema does not record an embedding model/revision on the embedding column. The existing vectors are 1,024-dimensional and L2-normalized, matching the configured query-vector shape and normalization, and live searches returned relevant provisions. This does not independently prove which model/revision originally generated every stored vector; confirm the ingestion pipeline's provenance before making a formal model-equivalence claim. The application does not regenerate or modify those vectors.

Source availability is not conflated: SOLAS is `summary` at instrument and clause level; ADA has `full` availability; DNV has `portal` availability at instrument level while loaded DNV provisions have `full` clause text. These flags describe loaded material, not completeness of the underlying conventions or rules.

The backend that preceded this integration used a configurable HTTP embedding endpoint and reciprocal-rank fusion, and did not implement the pinned local BGE-M3 pipeline. No separate BGE-M3 Python retrieval script was present in the backend tree. Retrieval now uses the specified BGE-M3 snapshot and score formula rather than that competing behavior.

### Database permissions

The configured role `shipdesign_app` was verified read-only on 2026-11-07 to have `CREATE` on `public`, `USAGE` on `extensions`, and `SELECT` on `public.provisions.embedding`; the vector type and cosine operator are present. The database migration and ShipCheck import have since been applied; the 15 existing application tables and legacy records were preserved. Do not reapply grants that are already present.

The app role needs database connection and `USAGE`/`CREATE` on `public` to run the application migration. Retrieval needs `SELECT` on the existing legacy tables and embedding column, plus `USAGE` on the schema containing pgvector. Have an administrator inspect the exact missing privilege before issuing a grant; the application never changes database permissions. No `REFERENCES` privilege is needed on legacy tables because application tables intentionally have no foreign keys into them. API vector errors are explicit and do not fall back to another search mode.

## Setup

Use Python 3.11 or newer. From `backend`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

For local BGE-M3 vector and hybrid retrieval, install the optional encoder dependencies into the same environment:

```powershell
python -m pip install -r requirements-retrieval.txt
```

Set `DATABASE_URL`, `APP_ENV`, `DEBUG` and `FRONTEND_ORIGINS` in an untracked `backend/.env` (the repository ignores `.env` files). Use the app database role and do not put credentials in source control. `.env.example` contains placeholders.

Apply the app-owned migration after an administrator has granted schema creation:

```powershell
python -m alembic upgrade head
```

### ShipCheck catalog cutover

The ShipCheck browser reads its rules, scenarios, model data, expected results, regulation links, and precomputed results from `GET /api/v1/shipcheck/catalog/{source_key}`. Binary 3D tiles remain on the existing `/model/...` gateway. The imported catalog JSON files have been removed from the repository after validating their hashes and record counts against the database; the database is the active source of truth.

The additive `20261108_0004` migration creates three `sc_shipcheck_*` tables. `sc_shipcheck_dataset_versions` stores immutable source-hash versions, `sc_shipcheck_dataset_records` stores ordered JSON records, and `sc_shipcheck_active_datasets` identifies the active version per fixed source key. Re-imports are idempotent; changed inputs add a version and switch the active pointer in one transaction. Old versions are retained, and downgrade is blocked if any catalog data has been imported. Migration `20261108_0005` aligns the existing AI-extraction table with the ORM's prompt/schema version fields; existing extraction rows receive `legacy-unknown` rather than being dropped or rewritten.

To import a future catalog version, prepare an external source directory containing the named catalog file(s) under `shipcheck/` (matching the historical paths recorded with each version). Set `SHIPCHECK_CATALOG_SOURCE_ROOT` to that directory and run from `backend` with selected source keys. The repository no longer contains these inputs. For a newly prepared APS parts export, `npm run prepare-model` writes to the OS temp directory; set `SHIPCHECK_CATALOG_STAGING_FILE` to a path ending in `shipcheck/ships/rcrv/parts.json`, set `SHIPCHECK_CATALOG_SOURCE_ROOT` to the parent directory containing that `shipcheck/` tree, then import `model-rcrv-parts`.

```powershell
python -m app.scripts.import_shipcheck_catalog rules scenarios model-rcrv-parts
```

The importer reads only its fixed registry of catalog keys and does not delete or update regulatory, legacy, or existing application records. Omitting source keys imports all registered catalogs. ShipCheck's Node server proxies catalog requests to FastAPI through `SHIPCHECK_DATA_API_URL`; set it to the API base URL on the server and to `http://127.0.0.1:8000` for local development. If a catalog has not been imported, the API reports a clear 503 instead of reading JSON from disk.

The migration and initial import have been applied to the configured database after backup confirmation and target approval. The registered importer can still add new immutable versions when intentionally supplied with external catalog inputs.

The pinned configuration is `BAAI/bge-m3`, snapshot `5617a9f61b028005a4858fdac845db406aefb181`, CPU by default, 1,024-dimensional L2-normalized query vectors. The supported settings are `EMBEDDING_MODEL`, `EMBEDDING_MODEL_REVISION`, `EMBEDDING_DEVICE`, and optional `EMBEDDING_CACHE_FOLDER`. Do not change the model, revision, normalization, or dimension to match a local convenience; these query vectors must be compatible with the existing provision embeddings. If `EMBEDDING_CACHE_FOLDER` is unset, Hugging Face uses its normal cache location (on Windows, typically `%USERPROFILE%\.cache\huggingface\hub`). `HF_HOME` can be set in the process environment to relocate the Hugging Face cache.

Download and verify the exact snapshot with the configured settings:

```powershell
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3', revision='5617a9f61b028005a4858fdac845db406aefb181', device='cpu')"
```

This first load downloads the snapshot when it is not cached and the machine can reach Hugging Face. To pre-cache somewhere other than the default, set `EMBEDDING_CACHE_FOLDER` before running the command, or set `HF_HOME` to the desired Hugging Face cache root. For an offline deployment, download the same model and revision on a connected machine using the same dependency versions, transfer the Hugging Face cache securely, and point `HF_HOME` or `EMBEDDING_CACHE_FOLDER` to it; do not substitute another model.

The exact cache download can also be run explicitly:

```powershell
python -c "from app.core.config import settings; from huggingface_hub import snapshot_download; print(snapshot_download(repo_id=settings.embedding_model, revision=settings.embedding_model_revision, cache_dir=settings.embedding_cache_folder))"
```

For offline use, transfer the complete `models--BAAI--bge-m3` cache directory, including its `blobs`, `refs`, and `snapshots`, to the same configured cache root. Set `HF_HUB_OFFLINE=1` in the API process if it must not contact Hugging Face at runtime.

Verify model loading and the embedding contract from `backend`:

```powershell
python -c "import math; from app.services.retrieval.service import BgeM3Embedder; v=BgeM3Embedder().embed('fire containment in machinery spaces'); print({'dimensions': len(v), 'l2_norm': math.sqrt(sum(x*x for x in v))})"
```

Expected output has 1,024 dimensions and an L2 norm close to 1. No hosted embedding or LLM API is called. If the package or snapshot cannot load, vector and hybrid search return an explicit service error; full-text remains separately selectable and English-only.

After the API is configured and running, exercise the database-backed modes independently:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/regulations/search?query=fire%20containment%20machinery%20spaces&mode=vector&ship_type=research&topic=fire&limit=3'
Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/regulations/search?query=fire%20containment%20machinery%20spaces&mode=full_text&ship_type=research&topic=fire&limit=3'
Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/regulations/search?query=fire%20containment%20machinery%20spaces&mode=hybrid&ship_type=research&topic=fire&limit=3'
```

Hybrid ranking remains `0.7 × cosine distance − 0.3 × English ts_rank`; lower scores rank higher. Both applicability filters run before ranking. Results preserve the original provision identifiers and text, document, edition, clause, and availability metadata. No duplicate regulatory or embedding tables are created. A Finnish vector query may retrieve English provisions semantically; Finnish full-text matching is not implemented or claimed.

Common failures:

- Missing `sentence-transformers`: install `requirements-retrieval.txt` in the same interpreter used to run the API.
- Snapshot unavailable: verify connectivity to Hugging Face or populate the pinned snapshot cache, then check `EMBEDDING_MODEL_REVISION` and `EMBEDDING_CACHE_FOLDER` (or `HF_HOME`).
- `permission denied for schema extensions`: an administrator must verify and, only if missing, grant `USAGE` on the configured pgvector schema to the application role.
- `permission denied for table/column provisions.embedding`: an administrator must verify legacy table/column `SELECT` privileges. Do not grant unrelated permissions.
- Missing pgvector type/operator or incompatible vector dimension: stop and inspect the existing extension/type/operator and embedding dimension; do not alter the legacy schema or regenerate embeddings as a workaround.

Start the API:

```powershell
python -m uvicorn app.main:app --reload
```

Interactive API documentation: `http://127.0.0.1:8000/docs`. Health endpoints: `/health` and `/health/database`.

## API examples

Create a project, vessel and revision:

```http
POST /api/v1/projects
Content-Type: application/json

{"name":"Concept study","description":"Early-stage design"}
```

```http
POST /api/v1/vessels
Content-Type: application/json

{"project_id":"<project-uuid>","name":"Research vessel","vessel_type":"research"}
```

```http
POST /api/v1/design-revisions
Content-Type: application/json

{"vessel_id":"<vessel-uuid>","revision_name":"Concept A","revision_number":1}
```

Add a component with explicit units and source provenance, then a fact:

```http
POST /api/v1/components
Content-Type: application/json

{
  "revision_id":"<revision-uuid>",
  "component_type":"fuel_tank",
  "name":"Tank 1",
  "properties":{"capacity":{"value":20,"unit":"m3"}},
  "geometry_reference":{"cad_object_id":"CAD-TANK-1"},
  "source_reference":{"source_type":"cad","file_id":"model-1"},
  "confidence":0.95
}
```

```http
POST /api/v1/design-facts
Content-Type: application/json

{
  "revision_id":"<revision-uuid>",
  "component_id":"<component-uuid>",
  "fact_type":"capacity",
  "statement":"Tank 1 capacity is 20 m3.",
  "value":{"value":20,"unit":"m3"},
  "source_reference":{"source_type":"manual","document":"design note"}
}
```

Retrieve the complete structured revision with `GET /api/v1/design-revisions/{revision_id}/understand`. `GET /api/v1/design-revisions/{revision_id}/retrieval-context` returns the stored components/facts rendered as a retrieval query; it does not infer geometry.

Search the existing corpus. Choose full-text mode when local BGE-M3 or pgvector grants are unavailable:

```http
GET /api/v1/regulations/search?query=fire%20containment&ship_type=research&topic=fire&mode=full_text
```

Use `mode=hybrid` (the default) or `mode=vector` for local BGE-M3 retrieval when configured. Optional filters include instrument/document, edition, chapter, clause, ship type and one or more clause topics. Instrument ship applicability and clause-topic applicability are separate filters and are applied before ranking. Hybrid ranking is `0.7 × cosine distance − 0.3 × English ts_rank`; lower scores rank higher. The response includes the original provision body and separate instrument/provision availability flags. Finnish or other non-English full-text ranking is not claimed.

Instead of `query`, provide `design_revision_id`, `design_component_id`, one or more repeated `design_fact_id` parameters, or `legacy_design_fact_id`. These inputs are converted to query text by a read-only adapter; it never synchronizes or writes to `public.design_facts`.

Assess supplied candidate clauses without an external AI service:

```http
POST /api/v1/assessments/run
Content-Type: application/json

{
  "revision_id":"<revision-uuid>",
  "candidates":[{
    "requirement_id":"<provision-uuid>",
    "component_ids":["<component-uuid>"],
    "required_information":["component:<component-uuid>:capacity.value"],
    "verification_method":"engineering_review"
  }]
}
```

The run endpoint can also accept `query` and `retrieval_mode` instead of `candidates`; it calls retrieval and creates findings for returned candidates. Use `retrieval_mode=full_text` to explicitly run without semantic retrieval. Each finding preserves the canonical provision text, edition and source metadata, plus design/source evidence and method. Required-information checks use explicit `fact:<fact_type>` or `component:<uuid>:<property.path>` references. An unspecified engineering check becomes `needs_engineering_review`; missing values become `missing_information`. Neither result means compliant or non-compliant.

Calculation tools are independently callable at `POST /api/v1/calculations/{geometry|documents|fluid|structural}`. For example:

```json
{
  "inputs":{
    "operation":"distance",
    "first":{"coordinates":[0,0,0],"unit":"m"},
    "second":{"coordinates":[3,4,0],"unit":"m"}
  }
}
```

Geometry calculations require explicit coordinates/dimensions and compatible units. Document checks confirm only that required document types are listed; they do not assess technical adequacy. Fluid and structural tools report missing implementation/input rather than fabricated engineering results. Findings can be reviewed using `PATCH /api/v1/findings/{finding_id}` with reviewer identity and notes.

## Migrations and tests

The migration chain creates app-owned `sc_*` tables, including the versioned ShipCheck catalog tables. It adds database-level same-revision constraints for relationships, component-associated facts, and finding-component links. `sc_findings` stores provision/retrieval identifiers without legacy foreign keys and snapshots the exact text, edition and source metadata. The AI migrations add provider/model/task configuration, execution history and reviewable extraction results. Extensions, embeddings and legacy tables are not created, altered or dropped.

Run unit and API tests without production access:

```powershell
python -m pytest
```

To run the migration upgrade/downgrade integration test, provide `TEST_DATABASE_URL` for an empty, disposable PostgreSQL database on loopback whose database name contains `test`. The test fails closed for non-loopback hosts and existing `sc_*` tables. It creates sentinel legacy tables only if absent, compares their schema/data before and after, then downgrades.

### Production migration runbook

For any future production schema or catalog change, verify the following against that specific change before approval:

1. Take a database backup using the organization's established procedure and confirm that the backup is restorable. Capture the current schema/table inventory, including existing `sc_*` tables and row counts.
2. Confirm `DATABASE_URL` points to the intended production database without printing or logging it. Check the Alembic head with `python -m alembic heads` and current revision with `python -m alembic current`.
3. Confirm the role has database `CONNECT` and `USAGE`/`CREATE` on `public`. Separately verify legacy-table read access and pgvector schema/embedding-column access for retrieval. The configured role's relevant grants were verified on 2026-11-07; do not repeat or broaden grants without a failed exact privilege check.
4. Review the migration files and their scope. Additive application migrations must not create or alter legacy provisions, embeddings, extensions, or other regulatory data.
5. In an approved change window, run from `backend`:

   ```powershell
   python -m alembic upgrade head
   ```

6. Verify `python -m alembic current`, `python -m alembic check`, the expected application tables, foreign keys, and unchanged legacy tables, existing application records, and extension inventories/row counts.
7. After the schema is verified, import any approved catalog source from its external staging directory. Confirm its source hash and count, then check the catalog API response shape before switching production ShipCheck to the new active version.

Rollback is not automatic. The applied ShipCheck catalog migration explicitly blocks downgrade while catalog history exists, and AI extraction schema rollback is also blocked when extraction records exist. Do not use `downgrade base` on the configured database: it would remove application-owned schema/data and is not a catalog rollback procedure. Restore the verified backup only under the organization's approved incident/change procedure; never use downgrade as a way to repair or modify legacy regulatory data.

## Current scope and limitations

- Design CRUD, provenance, source-aware context and same-revision relationships are implemented. Parsing covers TXT, DOCX, text-based PDF, DXF and glTF/GLB; DWG, IFC, STEP and scanned PDFs are not parsed and are reported as unsupported. See `docs/END_TO_END_WORKFLOW.md` for what is implemented, partial and future.
- Retrieval uses the canonical legacy tables and does not copy provisions or regenerate embeddings. Query embedding is local BGE-M3. Full-text is English; it is not equivalent to multilingual semantic search.
- Assessment runs persist immutable requirement snapshots and design/component traceability. Automated input-presence checks and basic deterministic geometry/document tools are available. Text-to-component extraction and advisory AI interpretation of provisions are available through the replaceable AI layer; fluid mechanics and structural calculations are placeholders, and applicability is never determined automatically (it is scored and left to the engineer).
- Engineering review is required. This API is not a classification-society approval or certification service.

## Replaceable AI providers and text extraction

The AI gateway is provider-neutral at the service boundary. Ollama uses its HTTP API; OpenAI and generic OpenAI-compatible endpoints use the chat-completions API; Anthropic uses its Messages API; Gemini uses Google's Generative Language API. Provider-specific HTTP mapping stays in `app/ai/providers.py`. No browser-side provider calls or automatic cloud fallback are used.

The **Settings → AI Providers** page shows exactly two environment-managed built-ins: Ollama and Gemini. It reads their configured endpoint/model IDs and provides a connection test. It does not create, edit or delete providers, models, API keys or secrets. Configure them in `backend/.env` (or the deployment's secret/environment manager) and restart the backend to load changes. `GET /api/v1/ai/built-in-providers` masks credentials; `POST /api/v1/ai/built-in-providers/{ollama|gemini}/test` checks reachability/model availability. Test status is held in backend process memory.

### Document review against TigerData

The Evidence Intake **Review with Gemini + TigerData** action posts DOCX/TXT files to `POST /api/v1/ai/document-reviews`. The backend parses text, runs hybrid regulation retrieval against TigerData (including vector search), and compares the retrieved provisions with the source text using the built-in Gemini configured in the backend environment. This document-only review does not persist source files or create compliance findings. Its quotations are checked against the original document and TigerData provision text; the result is advisory and is not a compliance decision. The endpoint accepts at most five files, 10 MB each and 30 MB combined. Design-revision extraction remains a separate flow at `/api/v1/ai/extractions/upload`.

Configure these backend environment values before using AI routes:

- `AI_ENCRYPTION_KEY`: a Fernet key used to encrypt API keys at rest. Generate one with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` and keep it in the backend secret store. Losing/changing the key makes saved credentials unreadable; users must enter them again.
- `AI_ALLOWED_HOSTS`: comma-separated exact hostnames/IPs or `host:port` entries permitted for outbound AI requests. Add the remote Ollama destination (for example `192.168.1.50:11434`) and any deliberately enabled cloud API host. A hostname without a port permits only the scheme's default port. Loopback hosts are allowed only outside production. Link-local, multicast, unspecified and cloud metadata hostnames are rejected. Configure network egress controls as an additional boundary.
- `AI_REQUEST_TIMEOUT_SECONDS`: provider request timeout (default `60`).
- `AI_MAX_SOURCE_CHARACTERS`: maximum extraction text length (default `100000`, hard limit `1000000`).
- `VITE_API_BASE_URL`: optional frontend API origin; defaults to `http://localhost:8000`.
- `OLLAMA_BASE_URL`: optional Ollama base URL, for example `http://localhost:11434` or a privately networked GPU server.
- `OLLAMA_API_KEY`: optional bearer token for an Ollama gateway; never returned to the frontend.
- `OLLAMA_MODELS` / `OLLAMA_MODEL`: optional comma-separated model IDs and a single model ID configured for the built-in provider.
- `GEMINI_API_KEY`: optional Google AI Studio/Gemini key, managed only by the backend environment.
- `GEMINI_BASE_URL`: Gemini API base URL; must remain on `https://generativelanguage.googleapis.com`.
- `GEMINI_MODEL`: optional configured Gemini model ID (for example `gemini-2.5-flash`).

Ollama is deployed independently from FastAPI. For a remote GPU service, use the exact installed identifier returned by `/api/tags`; do not assume a model alias. Protect remote Ollama with private networking or an authenticated gateway and firewall rules.

After applying migrations in a disposable/development database, start FastAPI and create/configure a provider from **Settings → AI Providers**. The app encrypts API keys using `AI_ENCRYPTION_KEY`; responses expose only `has_api_key`. Use **Test connection** and **Refresh models**, then assign a model to `text_component_extraction`. The test panel supports raw generation and validation against the text extraction Pydantic schema.

Discovered models start with chat capability only. The model list exposes an opt-in JSON mode: select JSON Schema for Ollama models or JSON object mode for compatible APIs only when that model/server supports it. Anthropic and models without that capability receive the schema instructions in the prompt and are still Pydantic-validated.

The same evidence-intake uploader submits files to `POST /api/v1/ai/extractions/upload` with a `revision_id` and repeated `files` fields. The endpoint stores the source bytes, SHA-256 reference, deterministic parser output, processing status, error and timestamps in `sc_source_documents`; successful AI output and review states stay in `sc_ai_extractions`. The existing `text_component_extraction` task configuration is used when configured; otherwise backend-managed Gemini uses `GEMINI_API_KEY` and `GEMINI_MODEL`. No browser-side provider calls or automatic import occur.

Implemented parsers:

- **DOCX/TXT:** extracts paragraphs and DOCX table cells or UTF-8 lines with stable paragraph/table-cell/line source IDs.
- **DXF:** uses ezdxf to capture model-space entities, layers, blocks, dimensions, labels, and available coordinates/geometry. Binary DWG is not supported.
- **GLB/GLTF:** supports glTF 2.0 scenes, hierarchy, node metadata, extensions, local/world transforms, mesh/accessor references, material metadata, vertex/index counts and connectivity samples, and local/world bounding boxes. `.gltf` external buffers must be included in the same upload; remote URIs are never fetched. Full parsed node/entity data is retained; AI interpretation input is capped by `AI_MAX_SOURCE_CHARACTERS` and reports truncation.

Other formats advertised by the evidence picker (including PDF, XLSX, DWG, STEP and IFC) are not parsed by this pipeline. Uploads are limited to 25 MB per file, 100 MB total and 20 files per request.

The AI receives parser output as untrusted input. Model-supplied approval statuses are reset to `pending`, and uploaded-source evidence is retained only when it maps to parser evidence; component geometry references are attached deterministically from the cited CAD entity/node IDs. Facts, property facts, components and relationships are independently reviewable. Import accepts only approved candidates/facts, preserves the source/evidence/model references, reuses an unambiguous existing component without overwriting it, and returns ambiguous matches for engineer review. Original source documents remain downloadable via `GET /api/v1/ai/source-documents/{id}/file`; parser output is available via `/parsed-data`. This is candidate data, not verified engineering data or a compliance decision.

Source-review and import routes:

```text
POST  /api/v1/ai/extractions/upload
GET   /api/v1/ai/design-revisions/{revision_id}/source-documents
GET   /api/v1/ai/source-documents/{source_document_id}/file
GET   /api/v1/ai/source-documents/{source_document_id}/parsed-data
GET   /api/v1/ai/extractions/{extraction_id}
PATCH /api/v1/ai/extractions/{extraction_id}/components/{candidate_index}
PATCH /api/v1/ai/extractions/{extraction_id}/components/{candidate_index}/properties/{property_name}
PATCH /api/v1/ai/extractions/{extraction_id}/relationships/{relationship_index}
PATCH /api/v1/ai/extractions/{extraction_id}/facts/{fact_index}
POST  /api/v1/ai/extractions/{extraction_id}/import
```

The import body may contain `candidate_indexes` and/or `fact_indexes`. Component property facts are imported only when individually approved. Source document status includes `processing`, `completed`, `failed`, or `referenced_asset` for GLTF binary sidecars. Parser and AI errors are exposed in the source record. The separate `GET /api/v1/ai/executions` route retains provider execution status, duration, token usage and validation outcome without storing prompts.

Example request sequence (replace IDs and keep API keys out of shell history):

```http
POST /api/v1/ai/providers
{"name":"Remote Ollama","provider_type":"ollama","base_url":"http://192.168.1.50:11434"}

POST /api/v1/ai/providers/{provider_id}/test
POST /api/v1/ai/providers/{provider_id}/refresh-models

PUT /api/v1/ai/task-configurations/text_component_extraction
{"provider_id":"<provider-uuid>","model_id":"<model-uuid>","generation_settings":{"temperature":0}}

POST /api/v1/ai/extractions
{"revision_id":"<revision-uuid>","source_name":"fuel-system.txt","source_text":"Fuel Tank TK-001 has a nominal capacity of 12 m3."}

PATCH /api/v1/ai/extractions/{extraction_id}/components/0
{"review_status":"approved","properties":{"capacity":{"value":12,"unit":"m3","review_status":"approved"}}}

POST /api/v1/ai/extractions/{extraction_id}/import
{"candidate_indexes":[0]}
```

Representative provider response (the credential itself is never returned):

```json
{
  "id": "<provider-uuid>",
  "name": "Remote Ollama",
  "provider_type": "ollama",
  "base_url": "http://192.168.1.50:11434",
  "enabled": true,
  "is_local": false,
  "has_api_key": false,
  "last_tested_at": null,
  "last_successful_test_at": null,
  "last_test_success": null
}
```

Representative extraction response includes `result.components`, `result.relationships` and `result.facts`; AI candidates are persisted with `pending` review status, source-grounded evidence, confidence and uncertainty. The API returns execution duration, token usage, provider/model IDs, prompt/schema versions, validation outcome and source reference. An import response returns existing/new component IDs, imported facts, and any ambiguous matches.

Manual integration check:

1. Start Ollama independently on the GPU host and run `ollama list`; copy the exact installed model name. Keep the listener private, and allow inbound access only from the FastAPI host.
2. Set `AI_ALLOWED_HOSTS` to the exact remote endpoint (for example `192.168.1.50:11434`), set a persistent `AI_ENCRYPTION_KEY`, and start FastAPI from `backend` with `python -m uvicorn app.main:app --reload`.
3. Configure the `text_component_extraction` task in the existing AI configuration, or configure `GEMINI_API_KEY` and `GEMINI_MODEL` in the backend environment.
4. Open the existing evidence intake, select files and a design revision, extract candidates, inspect/edit their evidence and fields, approve individual facts and candidates, and import. Verify via `GET /api/v1/design-revisions/{revision_id}/components` and `/facts`.
5. To change the AI target, update the existing `text_component_extraction` task configuration; if that task is absent, the upload workflow uses the backend-managed Gemini model. There is no automatic fallback after a configured provider fails.

AI management endpoints currently follow the backend's existing API convention and **do not have authentication/authorization middleware**. Do not expose this backend or the provider-management UI to untrusted networks. Add the deployment's authentication and user authorization before production exposure. Remote-provider access is restricted by the explicit outbound host allowlist, but that is not a substitute for network isolation.

Current limitations: PDF, spreadsheet, DWG, STEP, IFC and other unlisted parsers; background jobs; per-user authorization; and live Ollama/PostgreSQL demonstration are not implemented. Upload processing is synchronous. Source bytes and deterministic parser output are retained in the app database; AI prompts and provider error bodies are not. Automated tests mock provider HTTP calls and do not need a live Ollama server. Do not run Alembic migrations against production from development.
