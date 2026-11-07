# Ship Compliance API

FastAPI modular monolith for versioned ship-design data, regulatory candidate retrieval and engineer-reviewed assessments. Retrieval identifies relevant candidate provisions; it does not determine applicability, compliance, safety or class approval.

## Architecture

- **Design understanding** (`app/services/design`): projects, vessels, revisions, components, relationships, source references and design facts. Importer protocol defines a common output for CAD, drawings, documents, calculations and spreadsheets; no source parser or AI extraction is claimed.
- **Regulatory retrieval** (`app/services/retrieval`): read-only queries against the existing regulatory tables, local BGE-M3 query embedding, vector search, full-text search, metadata/applicability filters and hybrid ranking.
- **Assessment** (`app/services/assessment`): candidate-to-design orchestration, reusable calculation/evidence tools, immutable source snapshots and engineer review. An assessment never declares compliance automatically.

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

The configured role `shipdesign_app` was verified read-only on 2026-11-07 to have `CREATE` on `public`, `USAGE` on `extensions`, and `SELECT` on `public.provisions.embedding`; the vector type and cosine operator are present. The configured database currently has zero `sc_*` tables: the application migration is still pending. Do not reapply grants that are already present.

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

To enable local semantic and hybrid retrieval later, install the optional dependency set if you did not already do so above:

```powershell
python -m pip install -r requirements-retrieval.txt
```

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

The initial migration creates exactly the nine application-owned `sc_*` tables. It adds database-level same-revision constraints for relationships, component-associated facts, and finding-component links. `sc_findings` stores provision/retrieval identifiers without legacy foreign keys and snapshots the exact text, edition and source metadata. Downgrade drops only these app tables. Extensions, embeddings and legacy tables are not created, altered or dropped.

Run unit and API tests without production access:

```powershell
python -m pytest
```

To run the migration upgrade/downgrade integration test, provide `TEST_DATABASE_URL` for an empty, disposable PostgreSQL database on loopback whose database name contains `test`. The test fails closed for non-loopback hosts and existing `sc_*` tables. It creates sentinel legacy tables only if absent, compares their schema/data before and after, then downgrades.

### Production migration runbook

The configured production migration is intentionally unapplied. Before approval:

1. Take a database backup using the organization's established procedure and confirm that the backup is restorable. Capture the current schema/table inventory and confirm `public` contains no `sc_*` tables.
2. Confirm `DATABASE_URL` points to the intended production database without printing or logging it. Check the Alembic head with `python -m alembic heads` and current revision with `python -m alembic current`.
3. Confirm the role has database `CONNECT` and `USAGE`/`CREATE` on `public`. Separately verify legacy-table read access and pgvector schema/embedding-column access for retrieval. The configured role's relevant grants were verified on 2026-11-07; do not repeat or broaden grants without a failed exact privilege check.
4. Review the migration file and its scope. It creates only the nine tables listed above and does not create or alter legacy provisions, embeddings, extensions, or other regulatory data.
5. In an approved change window, run from `backend`:

   ```powershell
   python -m alembic upgrade head
   ```

6. Verify `python -m alembic current`, `python -m alembic check`, the exact nine `sc_*` tables, expected same-revision foreign keys, and unchanged legacy table/extension inventories and row counts. Then perform health and read-only retrieval checks.

Rollback is not automatic: the migration's `downgrade base` drops the nine application tables and all application data in them. If rollback is approved before the application has accepted data, run `python -m alembic downgrade base`; otherwise restore the verified pre-migration backup under the incident/change procedure. Never use downgrade as a way to repair or modify legacy regulatory data.

## Current scope and limitations

- Design CRUD, provenance, source-aware context and same-revision relationships are implemented. CAD/drawing/document import is an interface only; parsing and automatic extraction are not implemented.
- Retrieval uses the canonical legacy tables and does not copy provisions or regenerate embeddings. Query embedding is local BGE-M3. Full-text is English; it is not equivalent to multilingual semantic search.
- Assessment runs persist immutable requirement snapshots and design/component traceability. Automated input-presence checks and basic deterministic geometry/document tools are available. Fluid mechanics, structural calculations, AI interpretation and automatic regulatory applicability determinations are not implemented.
- Engineering review is required. This API is not a classification-society approval or certification service.
