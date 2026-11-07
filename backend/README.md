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

Source availability is not conflated: SOLAS is `summary` at instrument and clause level; ADA has `full` availability; DNV has `portal` availability at instrument level while loaded DNV provisions have `full` clause text. These flags describe loaded material, not completeness of the underlying conventions or rules.

The backend that preceded this integration used a configurable HTTP embedding endpoint and reciprocal-rank fusion, and did not implement the pinned local BGE-M3 pipeline. No separate BGE-M3 Python retrieval script was present in the backend tree. Retrieval now uses the specified BGE-M3 snapshot and score formula rather than that competing behavior.

### Database grants required

The configured role `shipdesign_app` has read access to the legacy tables, but inspection found:

- No `CREATE` privilege on schema `public` (or database `CREATE` privilege), so it cannot apply the app migration there.
- No `USAGE` privilege on schema `extensions`, so it cannot invoke the pgvector operator/type for semantic or hybrid search.

An administrator must grant the privileges; the application does not modify grants:

```sql
GRANT CREATE ON SCHEMA public TO shipdesign_app;
GRANT USAGE ON SCHEMA extensions TO shipdesign_app;
```

`SELECT` on `public.provisions` is already available, including the embedding column. The app does not need `REFERENCES` privileges on legacy tables because it does not create external foreign keys. If vector access fails, the API reports the current role and administrator SQL rather than silently switching retrieval modes.

## Setup

Use Python 3.11 or newer. From `backend`:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Set `DATABASE_URL`, `APP_ENV`, `DEBUG` and `FRONTEND_ORIGINS` in an untracked `backend/.env` (the repository ignores `.env` files). Use the app database role and do not put credentials in source control. `.env.example` contains placeholders.

Apply the app-owned migration after an administrator has granted schema creation:

```powershell
python -m alembic upgrade head
```

To enable local semantic and hybrid retrieval, install the optional encoder dependency:

```powershell
python -m pip install -r requirements-retrieval.txt
```

The default model is `BAAI/bge-m3`, pinned to snapshot `5617a9f61b028005a4858fdac845db406aefb181`, with 1,024-dimensional L2-normalized query vectors. The first model load needs the snapshot in the local Hugging Face cache; it may be pre-cached with:

```powershell
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3', revision='5617a9f61b028005a4858fdac845db406aefb181', device='cpu')"
```

`EMBEDDING_DEVICE` and optional `EMBEDDING_CACHE_FOLDER` configure local inference. No hosted embedding or LLM API is called. If the package/model is unavailable, vector and hybrid search return an explicit service error. Full-text search remains a separately selectable mode and is English-only.

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

## Current scope and limitations

- Design CRUD, provenance, source-aware context and same-revision relationships are implemented. CAD/drawing/document import is an interface only; parsing and automatic extraction are not implemented.
- Retrieval uses the canonical legacy tables and does not copy provisions or regenerate embeddings. Query embedding is local BGE-M3. Full-text is English; it is not equivalent to multilingual semantic search.
- Assessment runs persist immutable requirement snapshots and design/component traceability. Automated input-presence checks and basic deterministic geometry/document tools are available. Fluid mechanics, structural calculations, AI interpretation and automatic regulatory applicability determinations are not implemented.
- Engineering review is required. This API is not a classification-society approval or certification service.
