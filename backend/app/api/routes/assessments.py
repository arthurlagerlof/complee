import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.schemas.assessment import AssessmentCreate, AssessmentOut, FindingCreate, FindingOut, FindingUpdate
from app.schemas.assessment import AssessmentRunRequest
from app.services.assessment import checks, service
from app.services.assessment.orchestrator import run_assessment
from app.services.common import InvalidReference
from app.services.retrieval.service import EmbeddingProviderError, VectorSearchUnavailable


router = APIRouter()


@router.post("/assessments", response_model=AssessmentOut, status_code=status.HTTP_201_CREATED)
def create_assessment(payload: AssessmentCreate, db: Session = Depends(get_db)):
    return service.create_assessment(db, payload)


@router.post("/assessments/run", response_model=AssessmentOut, status_code=status.HTTP_201_CREATED)
def assess_design(payload: AssessmentRunRequest, db: Session = Depends(get_db)):
    try:
        return run_assessment(db, payload)
    except (EmbeddingProviderError, VectorSearchUnavailable) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class EngineeringCheckRunRequest(BaseModel):
    revision_id: uuid.UUID
    check_ids: list[str] | None = Field(default=None, max_length=50)


@router.get("/engineering-checks")
def list_engineering_checks():
    """Structured requirements the engine can check, each tied to a provision in the regulation database."""
    return checks.check_catalogue()


@router.post("/engineering-checks/run", status_code=status.HTTP_201_CREATED)
def run_engineering_checks(payload: EngineeringCheckRunRequest, db: Session = Depends(get_db)):
    """Completeness, consistency and deterministic requirement checks for a design revision. Every finding is
    stored open for engineer review; nothing declares compliance."""
    outcome = checks.run_engineering_checks(db, payload.revision_id, payload.check_ids)
    findings = [FindingOut.model_validate(service.get_finding(db, finding_id)) for finding_id in outcome["finding_ids"]]
    return {"assessment_id": outcome["assessment_id"], "summary": outcome["summary"],
            "skipped_checks": outcome["skipped_checks"], "findings": findings}


@router.get("/design-revisions/{revision_id}/completeness")
def revision_completeness(revision_id: uuid.UUID, db: Session = Depends(get_db)):
    """Which key engineering properties (knowledge catalogue) each component has, and where sources disagree."""
    return checks.completeness_report(db, revision_id)


@router.get("/assessments", response_model=list[AssessmentOut])
def list_assessments(
    revision_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return service.list_assessments(db, revision_id, limit, offset)


@router.get("/assessments/{assessment_id}", response_model=AssessmentOut)
def get_assessment(assessment_id: uuid.UUID, db: Session = Depends(get_db)):
    return service.get_assessment(db, assessment_id)


@router.post(
    "/assessments/{assessment_id}/findings",
    response_model=FindingOut,
    status_code=status.HTTP_201_CREATED,
)
def create_assessment_finding(
    assessment_id: uuid.UUID, payload: FindingCreate, db: Session = Depends(get_db)
):
    if assessment_id != payload.assessment_id:
        raise InvalidReference("The assessment ID in the path and request body must match.")
    return service.create_finding(db, payload)


@router.get("/assessments/{assessment_id}/findings", response_model=list[FindingOut])
def list_assessment_findings(
    assessment_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return service.list_findings(db, assessment_id, limit, offset)


@router.post("/findings", response_model=FindingOut, status_code=status.HTTP_201_CREATED)
def create_finding(payload: FindingCreate, db: Session = Depends(get_db)):
    return service.create_finding(db, payload)


@router.patch("/findings/{finding_id}", response_model=FindingOut)
def update_finding(
    finding_id: uuid.UUID, payload: FindingUpdate, db: Session = Depends(get_db)
):
    return service.update_finding(db, finding_id, payload)


@router.get("/findings/{finding_id}", response_model=FindingOut)
def get_finding(finding_id: uuid.UUID, db: Session = Depends(get_db)):
    return service.get_finding(db, finding_id)
