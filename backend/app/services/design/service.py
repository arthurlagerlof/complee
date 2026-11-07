import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ComponentRelationship, DesignComponent, DesignRevision, Project, Vessel
from app.schemas.design import (
    ComponentRelationshipCreate,
    DesignComponentCreate,
    DesignComponentUpdate,
    DesignRevisionCreate,
    ProjectCreate,
    VesselCreate,
)
from app.services.common import EntityNotFound, InvalidReference, commit_changes, save_and_refresh


def create_project(session: Session, payload: ProjectCreate) -> Project:
    return save_and_refresh(session, Project(**payload.model_dump()))


def list_projects(session: Session, limit: int, offset: int) -> list[Project]:
    return list(session.scalars(select(Project).order_by(Project.created_at.desc()).limit(limit).offset(offset)))


def create_vessel(session: Session, payload: VesselCreate) -> Vessel:
    if session.get(Project, payload.project_id) is None:
        raise EntityNotFound("Project not found.")
    return save_and_refresh(session, Vessel(**payload.model_dump()))


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
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(component, field, value)
    commit_changes(session)
    session.refresh(component)
    return component


def delete_component(session: Session, component_id: uuid.UUID) -> None:
    component = get_component(session, component_id)
    session.delete(component)
    commit_changes(session)


def create_relationship(
    session: Session, payload: ComponentRelationshipCreate
) -> ComponentRelationship:
    if session.get(DesignRevision, payload.revision_id) is None:
        raise EntityNotFound("Design revision not found.")
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
