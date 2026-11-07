import uuid
import json

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.db.models import (
    Assessment,
    ComponentRelationship,
    DesignComponent,
    DesignFact,
    DesignRevision,
    Project,
    Vessel,
)
from app.schemas.design import (
    ComponentRelationshipCreate,
    DesignComponentCreate,
    DesignComponentUpdate,
    DesignFactCreate,
    DesignFactUpdate,
    DesignRevisionCreate,
    ProjectCreate,
    VesselCreate,
)
from app.services.common import ConflictError, EntityNotFound, InvalidReference, commit_changes, save_and_refresh


def _ensure_revision_editable(session: Session, revision_id: uuid.UUID) -> None:
    has_completed_assessment = session.scalar(
        select(Assessment.id)
        .where(
            Assessment.revision_id == revision_id,
            (Assessment.status == "completed") | Assessment.completed_at.is_not(None),
        )
        .limit(1)
    )
    if has_completed_assessment is not None:
        raise ConflictError("A design revision used by a completed assessment is immutable.")


def create_project(session: Session, payload: ProjectCreate) -> Project:
    return save_and_refresh(session, Project(**payload.model_dump()))


def list_projects(session: Session, limit: int, offset: int) -> list[Project]:
    return list(session.scalars(select(Project).order_by(Project.created_at.desc()).limit(limit).offset(offset)))


def create_vessel(session: Session, payload: VesselCreate) -> Vessel:
    if session.get(Project, payload.project_id) is None:
        raise EntityNotFound("Project not found.")
    return save_and_refresh(session, Vessel(**payload.model_dump()))


def list_vessels(
    session: Session, project_id: uuid.UUID | None, limit: int, offset: int
) -> list[Vessel]:
    query = select(Vessel)
    if project_id is not None:
        query = query.where(Vessel.project_id == project_id)
    return list(session.scalars(query.order_by(Vessel.name, Vessel.id).limit(limit).offset(offset)))


def get_vessel(session: Session, vessel_id: uuid.UUID) -> Vessel:
    vessel = session.get(Vessel, vessel_id)
    if vessel is None:
        raise EntityNotFound("Vessel not found.")
    return vessel


def create_revision(session: Session, payload: DesignRevisionCreate) -> DesignRevision:
    if session.get(Vessel, payload.vessel_id) is None:
        raise EntityNotFound("Vessel not found.")
    return save_and_refresh(session, DesignRevision(**payload.model_dump()))


def list_revisions(
    session: Session, vessel_id: uuid.UUID | None, limit: int, offset: int
) -> list[DesignRevision]:
    query = select(DesignRevision)
    if vessel_id is not None:
        query = query.where(DesignRevision.vessel_id == vessel_id)
    return list(session.scalars(query.order_by(DesignRevision.created_at.desc()).limit(limit).offset(offset)))


def get_revision(session: Session, revision_id: uuid.UUID) -> DesignRevision:
    revision = session.get(DesignRevision, revision_id)
    if revision is None:
        raise EntityNotFound("Design revision not found.")
    return revision


def create_component(session: Session, payload: DesignComponentCreate) -> DesignComponent:
    if session.get(DesignRevision, payload.revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    _ensure_revision_editable(session, payload.revision_id)
    return save_and_refresh(session, DesignComponent(**payload.model_dump()))


def list_components(session: Session, revision_id: uuid.UUID, limit: int, offset: int) -> list[DesignComponent]:
    if session.get(DesignRevision, revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    query = (
        select(DesignComponent)
        .where(DesignComponent.revision_id == revision_id)
        .order_by(DesignComponent.created_at, DesignComponent.id)
        .limit(limit)
        .offset(offset)
    )
    return list(session.scalars(query))


def get_component(session: Session, component_id: uuid.UUID) -> DesignComponent:
    component = session.get(DesignComponent, component_id)
    if component is None:
        raise EntityNotFound("Design component not found.")
    return component


def update_component(
    session: Session, component_id: uuid.UUID, payload: DesignComponentUpdate
) -> DesignComponent:
    component = get_component(session, component_id)
    _ensure_revision_editable(session, component.revision_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(component, field, value)
    commit_changes(session)
    session.refresh(component)
    return component


def delete_component(session: Session, component_id: uuid.UUID) -> None:
    component = get_component(session, component_id)
    _ensure_revision_editable(session, component.revision_id)
    session.delete(component)
    commit_changes(session)


def create_relationship(
    session: Session, payload: ComponentRelationshipCreate
) -> ComponentRelationship:
    if session.get(DesignRevision, payload.revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    _ensure_revision_editable(session, payload.revision_id)
    components = session.scalars(
        select(DesignComponent).where(
            DesignComponent.id.in_([payload.source_component_id, payload.target_component_id])
        )
    ).all()
    if len(components) != 2 or any(component.revision_id != payload.revision_id for component in components):
        raise InvalidReference("Both relationship components must belong to the specified revision.")
    return save_and_refresh(session, ComponentRelationship(**payload.model_dump()))


def list_relationships(
    session: Session, revision_id: uuid.UUID, limit: int, offset: int
) -> list[ComponentRelationship]:
    if session.get(DesignRevision, revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    query = (
        select(ComponentRelationship)
        .where(ComponentRelationship.revision_id == revision_id)
        .order_by(ComponentRelationship.id)
        .limit(limit)
        .offset(offset)
    )
    return list(session.scalars(query))


def create_fact(session: Session, payload: DesignFactCreate) -> DesignFact:
    if session.get(DesignRevision, payload.revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    _ensure_revision_editable(session, payload.revision_id)
    if payload.component_id is not None:
        component = session.get(DesignComponent, payload.component_id)
        if component is None or component.revision_id != payload.revision_id:
            raise InvalidReference("The design fact component must belong to the specified revision.")
    return save_and_refresh(session, DesignFact(**payload.model_dump()))


def list_facts(session: Session, revision_id: uuid.UUID, limit: int, offset: int) -> list[DesignFact]:
    if session.get(DesignRevision, revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    query = (
        select(DesignFact)
        .where(DesignFact.revision_id == revision_id)
        .order_by(DesignFact.created_at, DesignFact.id)
        .limit(limit)
        .offset(offset)
    )
    return list(session.scalars(query))


def get_fact(session: Session, fact_id: uuid.UUID) -> DesignFact:
    fact = session.get(DesignFact, fact_id)
    if fact is None:
        raise EntityNotFound("Design fact not found.")
    return fact


def update_fact(session: Session, fact_id: uuid.UUID, payload: DesignFactUpdate) -> DesignFact:
    fact = get_fact(session, fact_id)
    _ensure_revision_editable(session, fact.revision_id)
    updates = payload.model_dump(exclude_unset=True)
    if updates.get("component_id") is not None:
        component = session.get(DesignComponent, updates["component_id"])
        if component is None or component.revision_id != fact.revision_id:
            raise InvalidReference("The design fact component must belong to the fact revision.")
    for field, value in updates.items():
        setattr(fact, field, value)
    commit_changes(session)
    session.refresh(fact)
    return fact


def get_revision_detail(session: Session, revision_id: uuid.UUID) -> DesignRevision:
    query = (
        select(DesignRevision)
        .where(DesignRevision.id == revision_id)
        .options(
            selectinload(DesignRevision.components),
            selectinload(DesignRevision.relationships),
            selectinload(DesignRevision.facts),
        )
    )
    revision = session.scalar(query)
    if revision is None:
        raise EntityNotFound("Design revision not found.")
    return revision


def build_retrieval_context(session: Session, revision_id: uuid.UUID) -> str:
    revision = get_revision_detail(session, revision_id)
    component_names = {component.id: component.name for component in revision.components}
    lines: list[str] = []
    for component in revision.components:
        properties = json.dumps(component.properties, ensure_ascii=False, sort_keys=True)
        geometry = json.dumps(component.geometry_reference, ensure_ascii=False, sort_keys=True)
        source = json.dumps(component.source_reference, ensure_ascii=False, sort_keys=True)
        lines.append(
            f"Component type: {component.component_type}; name: {component.name}; "
            f"properties: {properties}; geometry reference: {geometry}; source reference: {source}."
        )
    for fact in revision.facts:
        subject = component_names.get(fact.component_id, "vessel design")
        lines.append(f"Design fact about {subject} ({fact.fact_type}): {fact.statement}")
    return "\n".join(lines)
