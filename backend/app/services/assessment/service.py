import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.db.models import Assessment, DesignComponent, DesignRevision, Finding, FindingComponent
from app.schemas.assessment import AssessmentCreate, FindingCreate, FindingUpdate
from app.services.common import EntityNotFound, InvalidReference, commit_changes, save_and_refresh
from app.services.retrieval.service import get_requirement, get_retrieval_finding


def _requirement_snapshot(requirement) -> dict:
    return {
        "id": str(requirement.id),
        "instrument_id": str(requirement.instrument_id),
        "instrument_code": requirement.document_code,
        "instrument_name": requirement.regulatory_document,
        "instrument_availability": requirement.source_availability,
        "provision_availability": requirement.provision_availability,
        "edition": requirement.edition,
        "clause_key": requirement.clause_reference,
        "heading_path": requirement.chapter,
        "language": requirement.language,
        "source_url": requirement.source_url,
        "text": requirement.text,
    }


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
    requirement = get_requirement(session, payload.requirement_id)
    if requirement is None:
        raise EntityNotFound("Regulatory requirement not found.")
    if payload.retrieval_finding_id is not None:
        retrieval_finding = get_retrieval_finding(session, payload.retrieval_finding_id)
        if retrieval_finding is None:
            raise EntityNotFound("Saved retrieval finding not found.")
        if retrieval_finding.provision_id != payload.requirement_id:
            raise InvalidReference("The saved retrieval finding refers to a different provision.")
    if payload.component_ids:
        components = session.scalars(
            select(DesignComponent).where(DesignComponent.id.in_(payload.component_ids))
        ).all()
        if len(components) != len(set(payload.component_ids)) or any(
            component.revision_id != assessment.revision_id for component in components
        ):
            raise InvalidReference("Finding components must belong to the assessment revision.")
    values = payload.model_dump(exclude={"component_ids"})
    finding = Finding(
        **values,
        revision_id=assessment.revision_id,
        requirement_snapshot=_requirement_snapshot(requirement),
    )
    session.add(finding)
    session.flush()
    session.add_all(
        FindingComponent(
            finding_id=finding.id,
            component_id=component_id,
            revision_id=assessment.revision_id,
        )
        for component_id in payload.component_ids
    )
    commit_changes(session)
    session.refresh(finding)
    return finding


def update_finding(session: Session, finding_id: uuid.UUID, payload: FindingUpdate) -> Finding:
    finding = session.get(Finding, finding_id)
    if finding is None:
        raise EntityNotFound("Finding not found.")
    updates = payload.model_dump(exclude_unset=True)
    recording_review = (
        "reviewed_by" in updates
        or "review_notes" in updates
        or updates.get("finding_type") == "verified_by_engineer"
    )
    if recording_review:
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


def list_findings(
    session: Session, assessment_id: uuid.UUID, limit: int, offset: int
) -> list[Finding]:
    if session.get(Assessment, assessment_id) is None:
        raise EntityNotFound("Assessment not found.")
    query = (
        select(Finding)
        .where(Finding.assessment_id == assessment_id)
        .options(selectinload(Finding.component_links))
        .order_by(Finding.created_at, Finding.id)
        .limit(limit)
        .offset(offset)
    )
    return list(session.scalars(query))


def get_finding(session: Session, finding_id: uuid.UUID) -> Finding:
    query = (
        select(Finding)
        .where(Finding.id == finding_id)
        .options(selectinload(Finding.component_links))
    )
    finding = session.scalar(query)
    if finding is None:
        raise EntityNotFound("Finding not found.")
    return finding
