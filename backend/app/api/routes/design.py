import uuid

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.schemas.design import (
    ComponentRelationshipCreate,
    ComponentRelationshipOut,
    DesignComponentCreate,
    DesignComponentOut,
    DesignComponentUpdate,
    DesignRevisionCreate,
    DesignRevisionOut,
    ProjectCreate,
    ProjectOut,
    VesselCreate,
    VesselOut,
)
from app.services.design import service


router = APIRouter()


@router.post("/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)):
    return service.create_project(db, payload)


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return service.list_projects(db, limit, offset)


@router.post("/vessels", response_model=VesselOut, status_code=status.HTTP_201_CREATED)
def create_vessel(payload: VesselCreate, db: Session = Depends(get_db)):
    return service.create_vessel(db, payload)


@router.get("/vessels/{vessel_id}", response_model=VesselOut)
def get_vessel(vessel_id: uuid.UUID, db: Session = Depends(get_db)):
    return service.get_vessel(db, vessel_id)


@router.post("/design-revisions", response_model=DesignRevisionOut, status_code=status.HTTP_201_CREATED)
def create_design_revision(payload: DesignRevisionCreate, db: Session = Depends(get_db)):
    return service.create_revision(db, payload)


@router.get("/design-revisions", response_model=list[DesignRevisionOut])
def list_design_revisions(
    vessel_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return service.list_revisions(db, vessel_id, limit, offset)


@router.get("/design-revisions/{revision_id}", response_model=DesignRevisionOut)
def get_design_revision(revision_id: uuid.UUID, db: Session = Depends(get_db)):
    return service.get_revision(db, revision_id)


@router.post("/components", response_model=DesignComponentOut, status_code=status.HTTP_201_CREATED)
def create_component(payload: DesignComponentCreate, db: Session = Depends(get_db)):
    return service.create_component(db, payload)


@router.get("/design-revisions/{revision_id}/components", response_model=list[DesignComponentOut])
def list_components(
    revision_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return service.list_components(db, revision_id, limit, offset)


@router.get("/components/{component_id}", response_model=DesignComponentOut)
def get_component(component_id: uuid.UUID, db: Session = Depends(get_db)):
    return service.get_component(db, component_id)


@router.patch("/components/{component_id}", response_model=DesignComponentOut)
def update_component(
    component_id: uuid.UUID, payload: DesignComponentUpdate, db: Session = Depends(get_db)
):
    return service.update_component(db, component_id, payload)


@router.delete("/components/{component_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_component(component_id: uuid.UUID, db: Session = Depends(get_db)):
    service.delete_component(db, component_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/relationships", response_model=ComponentRelationshipOut, status_code=status.HTTP_201_CREATED)
def create_relationship(payload: ComponentRelationshipCreate, db: Session = Depends(get_db)):
    return service.create_relationship(db, payload)


@router.get("/design-revisions/{revision_id}/relationships", response_model=list[ComponentRelationshipOut])
def list_relationships(
    revision_id: uuid.UUID,
    limit: int = Query(default=100, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    return service.list_relationships(db, revision_id, limit, offset)
