import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.db.models import Assessment, DesignComponent, DesignRevision, Finding
from app.schemas.assessment import AssessmentCreate, FindingCreate, FindingUpdate
from app.services.common import EntityNotFound, InvalidReference, commit_changes, save_and_refresh
from app.services.retrieval import get_requirement


def create_assessment(session: Session, payload: AssessmentCreate) -> Assessment:
    if session.get(DesignRevision, payload.revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    return save_and_refresh(session, Assessment(revision_id=payload.revision_id))


def list_assessments(
    session: Session, revision_id: uuid.UUID | None, limit: int, offset: int
) -> list[Assessment]:
    query = select(Assessment).options(selectinload(Assessment.findings))
    if revision_id is not None:
        query = query.where(Assessment.revision_id == revision_id)
    return list(session.scalars(query.order_by(Assessment.created_at.desc()).limit(limit).offset(offset)))


def get_assessment(session: Session, assessment_id: uuid.UUID) -> Assessment:
    query = (
        select(Assessment)
        .where(Assessment.id == assessment_id)
        .options(selectinload(Assessment.findings))
    )
    assessment = session.scalar(query)
    if assessment is None:
        raise EntityNotFound("Assessment not found.")
    return assessment


def create_finding(session: Session, payload: FindingCreate) -> Finding:
    assessment = session.get(Assessment, payload.assessment_id)
    if assessment is None:
        raise EntityNotFound("Assessment not found.")
    if get_requirement(session, payload.requirement_id) is None:
        raise EntityNotFound("Regulatory requirement not found.")
    if payload.component_ids:
        components = session.scalars(
            select(DesignComponent).where(DesignComponent.id.in_(payload.component_ids))
        ).all()
        if len(components) != len(set(payload.component_ids)) or any(
            component.revision_id != assessment.revision_id for component in components
        ):
            raise InvalidReference("Finding components must belong to the assessment revision.")
    return save_and_refresh(session, Finding(**payload.model_dump()))


def update_finding(session: Session, finding_id: uuid.UUID, payload: FindingUpdate) -> Finding:
    finding = session.get(Finding, finding_id)
    if finding is None:
        raise EntityNotFound("Finding not found.")
    updates = payload.model_dump(exclude_unset=True)
    if "reviewed_by" in updates or "review_notes" in updates:
        if not updates.get("reviewed_by") and not finding.reviewed_by:
            raise InvalidReference("An engineer name is required when recording a review.")
        finding.reviewed_by = updates.pop("reviewed_by", finding.reviewed_by)
        finding.review_notes = updates.pop("review_notes", finding.review_notes)
        finding.reviewed_at = datetime.now(timezone.utc)
    for field, value in updates.items():
        setattr(finding, field, value)
    commit_changes(session)
    session.refresh(finding)
    return finding
