from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session


class EntityNotFound(Exception):
    pass


class ConflictError(Exception):
    pass


class InvalidReference(Exception):
    pass


def commit_changes(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise ConflictError("The change conflicts with existing data or a related record.") from exc


def save_and_refresh(session: Session, entity):
    session.add(entity)
    commit_changes(session)
    session.refresh(entity)
    return entity
