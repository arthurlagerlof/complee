import uuid
import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import quote, unquote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import Field
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.ai.providers import AIProviderError
from app.ai.schemas import (
    AIExecutionOut,
    CandidateReview,
    ExtractionOut,
    ExtractionRequest,
    EngineeringValueReview,
    FactReview,
    GenerationRequest,
    GenerationResponse,
    ImportResponse,
    ModelCreate,
    ModelOut,
    ModelUpdate,
    ProviderCreate,
    ProviderOut,
    ProviderUpdate,
    RelationshipReview,
    SourceDocumentOut,
    SourceUploadResult,
    StructuredGenerationRequest,
    TaskConfigurationOut,
    TaskConfigurationPut,
)
from app.core.config import settings
from app.ai.schemas import ExtractionResult
from app.db.database import get_db
from app.db.models import DesignRevision, SourceDocument
from app.services import ai
from app.services import ai_builtins
from app.services.common import ConflictError, EntityNotFound, InvalidReference
from app.services.design.service import ensure_revision_editable
from app.services.extractions import SourceProcessingError, parse_source
from app.services.assessment.document_review import review_document
from app.services.retrieval.service import EmbeddingProviderError, VectorSearchUnavailable


router = APIRouter(prefix="/ai", tags=["ai"])
logger = logging.getLogger(__name__)
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024
MAX_UPLOAD_COUNT = 20
MAX_DOCUMENT_REVIEW_BYTES = 10 * 1024 * 1024


class CandidateImportRequest(BaseModel):
    candidate_indexes: list[int] = Field(default_factory=list)
    fact_indexes: list[int] = Field(default_factory=list)


@router.post("/document-reviews")
def review_uploaded_documents(
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    """Review DOCX/TXT evidence against hybrid-retrieved TigerData regulations with Gemini."""
    if not files or len(files) > 5:
        raise HTTPException(status_code=400, detail="Upload between 1 and 5 DOCX or TXT files.")
    results = []
    total_bytes = 0
    for uploaded in files:
        filename = PurePosixPath((uploaded.filename or "upload").replace("\\", "/")).name
        if PurePosixPath(filename).suffix.lower() not in {".docx", ".txt"}:
            raise HTTPException(status_code=415, detail=f"{filename}: only DOCX and TXT document review is supported.")
        data = uploaded.file.read(MAX_DOCUMENT_REVIEW_BYTES + 1)
        total_bytes += len(data)
        if len(data) > MAX_DOCUMENT_REVIEW_BYTES:
            raise HTTPException(status_code=413, detail=f"{filename}: maximum size is 10 MB.")
        if total_bytes > 30 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Combined document review upload limit is 30 MB.")
        try:
            parsed = parse_source(filename, data)
        except SourceProcessingError as exc:
            raise HTTPException(status_code=422, detail=f"{filename}: {exc}") from exc
        if not parsed.content.strip():
            raise HTTPException(status_code=422, detail=f"{filename}: no readable text was found.")
        try:
            db.execute(text("SET LOCAL statement_timeout = '30s'"))
            results.append(review_document(db, filename, parsed.content, len(parsed.content)))
        except (EmbeddingProviderError, VectorSearchUnavailable) as exc:
            raise HTTPException(status_code=503, detail=f"TigerData regulation retrieval is unavailable: {exc}") from exc
        except DBAPIError as exc:
            logger.exception("TigerData/document review database request failed for %s", filename)
            raise HTTPException(status_code=503, detail="TigerData did not complete the review query. Retry after checking the database connection.") from exc
        except AIProviderError as exc:
            logger.exception("Gemini document review failed for %s", filename)
            raise HTTPException(status_code=502, detail=f"Gemini document review failed: {exc}") from exc
    return {"results": results}


@router.get("/built-in-providers")
def list_built_in_providers():
    return ai_builtins.list_builtins()


@router.post("/built-in-providers/{provider_id}/test")
def test_built_in_provider(provider_id: str):
    return ai_builtins.test_builtin(provider_id)


@router.get("/providers", response_model=list[ProviderOut])
def list_providers(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return [ai.provider_output(item) for item in ai.list_providers(db, limit, offset)]


@router.post("/providers", response_model=ProviderOut, status_code=status.HTTP_201_CREATED)
def create_provider(payload: ProviderCreate, db: Session = Depends(get_db)):
    return ai.provider_output(ai.create_provider(db, payload))


@router.get("/providers/{provider_id}", response_model=ProviderOut)
def get_provider(provider_id: uuid.UUID, db: Session = Depends(get_db)):
    return ai.provider_output(ai.get_provider(db, provider_id))


@router.patch("/providers/{provider_id}", response_model=ProviderOut)
def update_provider(provider_id: uuid.UUID, payload: ProviderUpdate, db: Session = Depends(get_db)):
    return ai.provider_output(ai.update_provider(db, provider_id, payload))


@router.delete("/providers/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider(provider_id: uuid.UUID, db: Session = Depends(get_db)):
    ai.delete_provider(db, provider_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/providers/{provider_id}/test")
def test_provider(provider_id: uuid.UUID, db: Session = Depends(get_db)):
    return ai.test_provider(db, provider_id)


@router.get("/providers/{provider_id}/models", response_model=list[ModelOut])
def provider_models(
    provider_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return ai.list_models(db, provider_id, limit, offset)


@router.get("/providers/{provider_id}/models/{model_name}")
def provider_model_info(provider_id: uuid.UUID, model_name: str, db: Session = Depends(get_db)):
    return ai.get_model_info(db, provider_id, model_name)


@router.post("/providers/{provider_id}/refresh-models", response_model=list[ModelOut])
def refresh_models(provider_id: uuid.UUID, db: Session = Depends(get_db)):
    return ai.refresh_models(db, provider_id)


@router.get("/models", response_model=list[ModelOut])
def list_models(
    provider_id: uuid.UUID | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return ai.list_models(db, provider_id, limit, offset)


@router.post("/models", response_model=ModelOut, status_code=status.HTTP_201_CREATED)
def create_model(payload: ModelCreate, db: Session = Depends(get_db)):
    return ai.create_model(db, payload)


@router.patch("/models/{model_id}", response_model=ModelOut)
def update_model(model_id: uuid.UUID, payload: ModelUpdate, db: Session = Depends(get_db)):
    return ai.update_model(db, model_id, payload)


@router.delete("/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(model_id: uuid.UUID, db: Session = Depends(get_db)):
    ai.delete_model(db, model_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/task-configurations", response_model=list[TaskConfigurationOut])
def list_task_configurations(db: Session = Depends(get_db)):
    return ai.list_task_configurations(db)


@router.get("/executions", response_model=list[AIExecutionOut])
def list_executions(
    provider_id: uuid.UUID | None = None,
    task_name: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return ai.list_executions(db, provider_id, task_name, limit, offset)


@router.put("/task-configurations/{task_name}", response_model=TaskConfigurationOut)
def set_task_configuration(
    task_name: str,
    payload: TaskConfigurationPut,
    db: Session = Depends(get_db),
):
    return ai.set_task_configuration(db, task_name, payload)


@router.post("/generate", response_model=GenerationResponse)
def generate(payload: GenerationRequest, db: Session = Depends(get_db)):
    return ai.generate(db, payload)


@router.post("/generate-structured", response_model=GenerationResponse)
def generate_structured(payload: StructuredGenerationRequest, db: Session = Depends(get_db)):
    return ai.generate(db, payload, ExtractionResult)


@router.post("/extractions", response_model=ExtractionOut, status_code=status.HTTP_201_CREATED)
def create_extraction(payload: ExtractionRequest, db: Session = Depends(get_db)):
    return ai.create_extraction(
        db,
        payload.revision_id,
        payload.source_text,
        payload.source_name,
        payload.source_file_id,
        payload.provider_id,
        payload.model_id,
    )


@router.post(
    "/extractions/upload",
    response_model=list[SourceUploadResult],
    status_code=status.HTTP_201_CREATED,
)
async def upload_extractions(
    revision_id: uuid.UUID = Form(...),
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    revision = db.get(DesignRevision, revision_id)
    if revision is None:
        raise EntityNotFound("Design revision not found.")
    ensure_revision_editable(db, revision_id)
    if not files or len(files) > MAX_UPLOAD_COUNT:
        raise HTTPException(
            status_code=422,
            detail=f"Upload between one and {MAX_UPLOAD_COUNT} files at a time.",
        )

    input_files: list[tuple[UploadFile, str, bytes]] = []
    total_bytes = 0
    for uploaded in files:
        original_filename = PurePosixPath((uploaded.filename or "uploaded-file").replace("\\", "/")).name
        data = await uploaded.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"{original_filename} exceeds the 25 MB file limit.")
        total_bytes += len(data)
        if total_bytes > MAX_UPLOAD_TOTAL_BYTES:
            raise HTTPException(status_code=413, detail="The combined upload exceeds the 100 MB limit.")
        input_files.append((uploaded, original_filename, data))

    related_files: dict[str, bytes] = {}
    related_hashes: dict[str, str] = {}
    ambiguous_related_names: set[str] = set()
    for _, filename, data in input_files:
        resource_hash = hashlib.sha256(data).hexdigest()
        if filename in related_hashes and related_hashes[filename] != resource_hash:
            ambiguous_related_names.add(filename)
            related_files.pop(filename, None)
            continue
        if filename not in ambiguous_related_names:
            related_files[filename] = data
            related_hashes[filename] = resource_hash

    referenced_assets: dict[str, list[str]] = {}
    for _, filename, data in input_files:
        if PurePosixPath(filename).suffix.lower() != ".gltf":
            continue
        try:
            gltf_manifest = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        for buffer in gltf_manifest.get("buffers", []):
            uri = buffer.get("uri") if isinstance(buffer, dict) else None
            if not isinstance(uri, str) or uri.startswith("data:"):
                continue
            resource_name = PurePosixPath(
                unquote(uri.replace("\\", "/").split("?", 1)[0])
            ).name
            if resource_name:
                referenced_assets.setdefault(resource_name, []).append(filename)

    results: list[SourceUploadResult] = []
    for uploaded, filename, data in input_files:
        suffix = PurePosixPath(filename).suffix.lower()
        source_id = uuid.uuid4()
        sha256 = hashlib.sha256(data).hexdigest()
        document = SourceDocument(
            id=source_id,
            revision_id=revision_id,
            filename=filename[:500],
            media_type=uploaded.content_type,
            file_extension=suffix,
            sha256=sha256,
            source_data=data,
            source_reference={
                "source_type": "drawing" if suffix == ".dxf" else "cad" if suffix in {".glb", ".gltf"} else "document",
                "source_name": filename,
                "source_file_id": str(source_id),
                "source_sha256": sha256,
                "file_extension": suffix,
            },
            processing_status="processing",
        )
        db.add(document)
        db.commit()
        db.refresh(document)
        try:
            if suffix == ".bin" and filename in referenced_assets:
                document.extraction_method = "gltf_buffer"
                document.parsed_data = {
                    "format": "gltf-buffer",
                    "referenced_by": referenced_assets[filename],
                }
                document.processing_status = "referenced_asset"
                document.completed_at = datetime.now(timezone.utc)
                document.source_reference = {
                    **document.source_reference,
                    "role": "referenced_gltf_buffer",
                    "referenced_by": referenced_assets[filename],
                }
                db.commit()
                db.refresh(document)
                results.append(SourceUploadResult(source_document=document))
                continue
            parsed = parse_source(filename, data, related_files)
            prefix = f"SOURCE_TYPE: {parsed.source_type}\nEXTRACTION_METHOD: {parsed.extraction_method}\n"
            budget = max(0, settings.ai_max_source_characters - len(prefix))
            marker = "[AI input truncated at configured source character limit; full parser output is retained.]"
            source_lines = parsed.content.splitlines()
            selected_lines: list[str] = []
            used_characters = 0
            for line in source_lines:
                required = len(line) + (1 if selected_lines else 0)
                if used_characters + required > budget - len(marker) - 1:
                    if not selected_lines and budget > len(marker) + 1:
                        selected_lines.append(line[: budget - len(marker) - 1])
                    break
                selected_lines.append(line)
                used_characters += required
            ai_input_truncated = len(selected_lines) < len(source_lines)
            source_text = prefix + "\n".join(selected_lines)
            if ai_input_truncated:
                source_text += f"\n{marker}"
            source_reference = {
                **document.source_reference,
                "source_file_id": str(document.id),
                "source_sha256": document.sha256,
                "source_media_type": document.media_type,
                "extraction_method": parsed.extraction_method,
                "parser_format": parsed.parsed_data.get("format"),
                "source_model_id": document.sha256,
                "model_generator": (
                    parsed.parsed_data.get("asset", {}).get("generator")
                    if isinstance(parsed.parsed_data.get("asset"), dict)
                    else None
                ),
                "ai_input_truncated": ai_input_truncated,
                "parser_interpretation_truncated": bool(
                    parsed.parsed_data.get("ai_interpretation_truncated")
                ),
                "parser_output_truncated": bool(parsed.parsed_data.get("truncated")),
            }
            document.parsed_data = parsed.parsed_data
            document.extraction_method = parsed.extraction_method
            document.source_reference = source_reference
            provider_id, model_id = ai.extraction_target(db)
            document.provider_id = provider_id
            document.model_id = model_id
            db.commit()
            extraction = ai.create_extraction(
                db,
                revision_id,
                source_text,
                filename,
                document.id,
                provider_id,
                model_id,
                source_reference,
            )
            truncation_warnings = []
            if ai_input_truncated:
                truncation_warnings.append(
                    "AI interpretation input was truncated; full parser output remains available."
                )
            if parsed.parsed_data.get("ai_interpretation_truncated"):
                truncation_warnings.append(
                    "The parser extracted more objects than were sent for AI interpretation."
                )
            if parsed.parsed_data.get("truncated"):
                truncation_warnings.append(
                    "The parser output reached its object limit; inspect the original source."
                )
            if truncation_warnings:
                extraction.result = {
                    **extraction.result,
                    "warnings": (
                        extraction.result.get("warnings", []) + truncation_warnings
                    )[:100],
                }
            document.provider_id = extraction.provider_id
            document.model_id = extraction.model_id
            document.extraction_id = extraction.id
            document.processing_status = "completed"
            document.completed_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(extraction)
            db.refresh(document)
            results.append(SourceUploadResult(source_document=document, extraction=extraction))
        except (
            SourceProcessingError,
            AIProviderError,
            ai.AIConfigurationError,
            ConflictError,
            EntityNotFound,
            InvalidReference,
        ) as exc:
            _mark_source_failed(db, document, str(exc))
            results.append(SourceUploadResult(source_document=document))
        except Exception as exc:
            logger.exception("Unexpected source extraction failure for source document %s", document.id)
            _mark_source_failed(db, document, "Source extraction failed unexpectedly.")
            results.append(SourceUploadResult(source_document=document))
    return results


def _mark_source_failed(session: Session, document: SourceDocument, message: str) -> None:
    session.rollback()
    document.processing_status = "failed"
    document.error_message = message[:4_000]
    document.completed_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(document)


@router.get(
    "/design-revisions/{revision_id}/source-documents",
    response_model=list[SourceDocumentOut],
)
def list_source_documents(revision_id: uuid.UUID, db: Session = Depends(get_db)):
    if db.get(DesignRevision, revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    return ai.list_source_documents(db, revision_id)


@router.get("/source-documents/{source_document_id}/file")
def download_source_document(source_document_id: uuid.UUID, db: Session = Depends(get_db)):
    document = db.get(SourceDocument, source_document_id)
    if document is None:
        raise EntityNotFound("Source document not found.")
    return Response(
        content=document.source_data,
        media_type=document.media_type or "application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(document.filename)}"
        },
    )


@router.get("/source-documents/{source_document_id}/parsed-data")
def get_source_document_parsed_data(
    source_document_id: uuid.UUID, db: Session = Depends(get_db)
):
    document = db.get(SourceDocument, source_document_id)
    if document is None:
        raise EntityNotFound("Source document not found.")
    return {
        "source_document_id": document.id,
        "source_reference": document.source_reference,
        "parsed_data": document.parsed_data,
    }


@router.get("/extractions/{extraction_id}", response_model=ExtractionOut)
def get_extraction(extraction_id: uuid.UUID, db: Session = Depends(get_db)):
    return ai.get_extraction(db, extraction_id)


@router.patch("/extractions/{extraction_id}/components/{candidate_index}", response_model=ExtractionOut)
def review_candidate(
    extraction_id: uuid.UUID,
    candidate_index: int,
    payload: CandidateReview,
    db: Session = Depends(get_db),
):
    return ai.review_candidate(db, extraction_id, candidate_index, payload)


@router.patch(
    "/extractions/{extraction_id}/components/{candidate_index}/properties/{property_name}",
    response_model=ExtractionOut,
)
def review_candidate_property(
    extraction_id: uuid.UUID,
    candidate_index: int,
    property_name: str,
    payload: EngineeringValueReview,
    db: Session = Depends(get_db),
):
    return ai.review_candidate_property(
        db, extraction_id, candidate_index, property_name, payload
    )


@router.patch("/extractions/{extraction_id}/relationships/{relationship_index}", response_model=ExtractionOut)
def review_relationship(
    extraction_id: uuid.UUID,
    relationship_index: int,
    payload: RelationshipReview,
    db: Session = Depends(get_db),
):
    return ai.review_relationship(db, extraction_id, relationship_index, payload)


@router.patch("/extractions/{extraction_id}/facts/{fact_index}", response_model=ExtractionOut)
def review_fact(
    extraction_id: uuid.UUID,
    fact_index: int,
    payload: FactReview,
    db: Session = Depends(get_db),
):
    return ai.review_fact(db, extraction_id, fact_index, payload)


@router.post("/extractions/{extraction_id}/import", response_model=ImportResponse)
def import_extraction(
    extraction_id: uuid.UUID,
    payload: CandidateImportRequest,
    db: Session = Depends(get_db),
):
    return ai.import_approved_candidates(
        db, extraction_id, payload.candidate_indexes, payload.fact_indexes
    )
