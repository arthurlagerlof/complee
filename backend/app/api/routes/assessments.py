import uuid
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, sessionmaker

from app.db.database import get_db
from app.schemas.assessment import AssessmentCreate, AssessmentOut, FindingCreate, FindingOut, FindingUpdate
from app.schemas.assessment import AssessmentRunRequest
from app.services.assessment import checks, service, workflow
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


class WorkflowRunRequest(BaseModel):
    retrieval_mode: Literal["hybrid", "vector", "full_text"] = "hybrid"
    per_type_limit: int = Field(default=4, ge=1, le=10)
    max_provisions: int = Field(default=12, ge=0, le=40)
    ai_interpretation: Literal["auto", "off"] = "auto"
    max_ai_provisions: int = Field(default=3, ge=0, le=10)
    extra_requirement_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    force: bool = False


def _session_factory(db: Session):
    """Background runs get their own session on the same database as the request (tests included)."""
    return sessionmaker(bind=db.get_bind(), autoflush=False, expire_on_commit=False)


def _options(payload: WorkflowRunRequest, trigger: str) -> workflow.RunOptions:
    data = payload.model_dump()
    data["extra_requirement_ids"] = [str(i) for i in payload.extra_requirement_ids]
    return workflow.RunOptions(**data, trigger=trigger)


@router.post("/design-revisions/{revision_id}/assessment-runs", status_code=status.HTTP_202_ACCEPTED)
def start_assessment_run(
    revision_id: uuid.UUID,
    background: BackgroundTasks,
    payload: WorkflowRunRequest | None = None,
    wait: bool = Query(default=False, description="Run in the request instead of in the background."),
    db: Session = Depends(get_db),
):
    """Assess a revision end to end: structured checks, retrieval, optional AI interpretation, scores. The run is
    provisional (the revision stays editable) until it is finalized. An identical or active run is returned instead
    of starting a duplicate unless force is set."""
    options = _options(payload or WorkflowRunRequest(), "manual")
    assessment, created = workflow.queue_run(db, revision_id, options)
    if created and wait:
        return workflow.execute_run(db, assessment.id, options)
    if created:
        background.add_task(workflow.run_in_background, _session_factory(db), assessment.id, options)
    return {**workflow.run_summary(assessment), "created": created}


@router.get("/design-revisions/{revision_id}/assessment-runs")
def list_assessment_runs(revision_id: uuid.UUID, db: Session = Depends(get_db)):
    return workflow.list_runs(db, revision_id)


@router.get("/assessment-runs/{assessment_id}")
def get_assessment_run(assessment_id: uuid.UUID, db: Session = Depends(get_db)):
    return workflow.run_summary(workflow.get_run(db, assessment_id))


@router.post("/assessment-runs/{assessment_id}/retry", status_code=status.HTTP_202_ACCEPTED)
def retry_assessment_run(
    assessment_id: uuid.UUID,
    background: BackgroundTasks,
    payload: WorkflowRunRequest | None = None,
    wait: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    assessment = workflow.prepare_retry(db, assessment_id)
    options = _options(payload or WorkflowRunRequest(), "retry")
    if wait:
        return workflow.execute_run(db, assessment.id, options)
    background.add_task(workflow.run_in_background, _session_factory(db), assessment.id, options)
    return workflow.run_summary(assessment)


@router.post("/assessment-runs/{assessment_id}/finalize")
def finalize_assessment_run(assessment_id: uuid.UUID, db: Session = Depends(get_db)):
    """Complete the run if the design data is unchanged since it ran; the revision then becomes immutable."""
    return workflow.finalize_run(db, assessment_id)


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


class AIReviewRequest(BaseModel):
    revision_id: uuid.UUID
    requirement_ids: list[uuid.UUID] = Field(min_length=1, max_length=10)
    component_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)


@router.post("/engineering-checks/ai-review", status_code=status.HTTP_201_CREATED)
def ai_review(payload: AIReviewRequest, db: Session = Depends(get_db)):
    """AI-assisted comparison of retrieved provisions with the revision's design data. The AI maps evidence and
    missing information; quoted quantitative conditions are calculated deterministically. Findings stay open."""
    from app.services.assessment.ai_review import review_requirements

    outcome = review_requirements(db, payload.revision_id, payload.requirement_ids, payload.component_ids)
    findings = [FindingOut.model_validate(service.get_finding(db, finding_id)) for finding_id in outcome["finding_ids"]]
    return {"assessment_id": outcome["assessment_id"], "findings": findings}


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
