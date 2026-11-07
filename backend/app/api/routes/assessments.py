import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.schemas.assessment import AssessmentCreate, AssessmentOut, FindingCreate, FindingOut, FindingUpdate
from app.services.assessment import service
from app.services.common import InvalidReference


router = APIRouter()


@router.post("/assessments", response_model=AssessmentOut, status_code=status.HTTP_201_CREATED)
def create_assessment(payload: AssessmentCreate, db: Session = Depends(get_db)):
    return service.create_assessment(db, payload)


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


@router.post("/findings", response_model=FindingOut, status_code=status.HTTP_201_CREATED)
def create_finding(payload: FindingCreate, db: Session = Depends(get_db)):
    return service.create_finding(db, payload)


@router.patch("/findings/{finding_id}", response_model=FindingOut)
def update_finding(
    finding_id: uuid.UUID, payload: FindingUpdate, db: Session = Depends(get_db)
):
    return service.update_finding(db, finding_id, payload)
