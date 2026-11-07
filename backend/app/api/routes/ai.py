import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.ai.schemas import (
    AIExecutionOut,
    CandidateReview,
    ExtractionOut,
    ExtractionRequest,
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
    StructuredGenerationRequest,
    TaskConfigurationOut,
    TaskConfigurationPut,
)
from app.ai.schemas import ExtractionResult
from app.db.database import get_db
from app.services import ai
from app.services import ai_builtins


router = APIRouter(prefix="/ai", tags=["ai"])


class CandidateImportRequest(BaseModel):
    candidate_indexes: list[int]


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


@router.patch("/extractions/{extraction_id}/relationships/{relationship_index}", response_model=ExtractionOut)
def review_relationship(
    extraction_id: uuid.UUID,
    relationship_index: int,
    payload: RelationshipReview,
    db: Session = Depends(get_db),
):
    return ai.review_relationship(db, extraction_id, relationship_index, payload.review_status)


@router.post("/extractions/{extraction_id}/import", response_model=ImportResponse)
def import_extraction(
    extraction_id: uuid.UUID,
    payload: CandidateImportRequest,
    db: Session = Depends(get_db),
):
    return ai.import_approved_candidates(db, extraction_id, payload.candidate_indexes)
