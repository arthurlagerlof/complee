import json
import uuid
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import DesignComponent, DesignFact
from app.schemas.regulation import LegacyDesignFactOut
from app.services.common import EntityNotFound, InvalidReference
from app.services.design.service import build_retrieval_context
from app.services.retrieval.service import get_legacy_design_fact


class DesignQueryAdapter(Protocol):
    def build_query(
        self,
        session: Session,
        *,
        query: str | None = None,
        revision_id: uuid.UUID | None = None,
        component_id: uuid.UUID | None = None,
        fact_ids: list[uuid.UUID] | None = None,
        legacy_fact_id: uuid.UUID | None = None,
    ) -> str: ...


class VersionedDesignQueryAdapter:
    def build_query(
        self,
        session: Session,
        *,
        query: str | None = None,
        revision_id: uuid.UUID | None = None,
        component_id: uuid.UUID | None = None,
        fact_ids: list[uuid.UUID] | None = None,
        legacy_fact_id: uuid.UUID | None = None,
    ) -> str:
        parts = [query.strip()] if query and query.strip() else []
        if revision_id is not None:
            revision_query = build_retrieval_context(session, revision_id)
            if revision_query:
                parts.append(revision_query)
        if component_id is not None:
            component = session.get(DesignComponent, component_id)
            if component is None:
                raise EntityNotFound("Design component not found.")
            if revision_id is not None and component.revision_id != revision_id:
                raise InvalidReference("The component does not belong to the requested design revision.")
            properties = json.dumps(component.properties, ensure_ascii=False, sort_keys=True)
            geometry = json.dumps(component.geometry_reference, ensure_ascii=False, sort_keys=True)
            source = json.dumps(component.source_reference, ensure_ascii=False, sort_keys=True)
            parts.append(
                f"Component type: {component.component_type}; name: {component.name}; "
                f"properties: {properties}; geometry reference: {geometry}; source reference: {source}."
            )
            fact_query = self._facts_query(
                session,
                select(DesignFact).where(
                    DesignFact.revision_id == component.revision_id,
                    (DesignFact.component_id == component.id) | (DesignFact.component_id.is_(None)),
                ),
                component.name,
            )
            if fact_query:
                parts.append(fact_query)
        if fact_ids:
            facts = list(session.scalars(select(DesignFact).where(DesignFact.id.in_(fact_ids))))
            if len(facts) != len(set(fact_ids)):
                raise EntityNotFound("One or more design facts were not found.")
            if revision_id is not None and any(fact.revision_id != revision_id for fact in facts):
                raise InvalidReference("Every design fact must belong to the requested design revision.")
            parts.append(self._facts_query(session, facts, None))
        if legacy_fact_id is not None:
            fact = get_legacy_design_fact(session, legacy_fact_id)
            if fact is None:
                raise EntityNotFound("Legacy design fact not found.")
            parts.append(self.legacy_fact_query(fact))
        result = "\n".join(part for part in parts if part.strip())
        if not result:
            raise InvalidReference(
                "Provide a text query, design revision, design component, or one or more design facts."
            )
        return result

    @staticmethod
    def legacy_fact_query(fact: LegacyDesignFactOut) -> str:
        values = [
            f"Legacy design fact type: {fact.kind}" if fact.kind else "",
            f"Name: {fact.name}" if fact.name else "",
            f"Deck: {fact.deck}" if fact.deck else "",
            f"Value: {fact.value}" if fact.value else "",
            f"Source file: {fact.source_file}" if fact.source_file else "",
        ]
        return "; ".join(value for value in values if value)

    @staticmethod
    def _facts_query(session: Session, facts, component_name: str | None) -> str:
        if isinstance(facts, list):
            fact_rows = facts
        else:
            fact_rows = list(session.scalars(facts))
        component_ids = {fact.component_id for fact in fact_rows if fact.component_id}
        names = {
            component.id: component.name
            for component in session.scalars(
                select(DesignComponent).where(DesignComponent.id.in_(component_ids))
            )
        } if component_ids else {}
        lines: list[str] = []
        for fact in sorted(fact_rows, key=lambda item: str(item.id)):
            subject = component_name or names.get(fact.component_id) or "vessel design"
            value = (
                f"; value: {json.dumps(fact.value, ensure_ascii=False, sort_keys=True)}"
                if fact.value is not None
                else ""
            )
            source = json.dumps(fact.source_reference, ensure_ascii=False, sort_keys=True)
            lines.append(
                f"Design fact about {subject} ({fact.fact_type}): {fact.statement}{value}; "
                f"source reference: {source}"
            )
        return "\n".join(lines)


design_query_adapter: DesignQueryAdapter = VersionedDesignQueryAdapter()
