import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Assessment,
    DesignComponent,
    DesignFact,
    DesignRevision,
    Finding,
    FindingComponent,
    Vessel,
)
from app.schemas.assessment import AssessmentRunRequest, RequirementCandidateInput
from app.services.calculations.registry import VerificationResult, registry
from app.services.common import EntityNotFound, InvalidReference, commit_changes
from app.services.retrieval.adapters import design_query_adapter
from app.services.retrieval.service import (
    get_requirement,
    get_retrieval_finding,
    search_regulations,
)
from app.services.assessment.service import _requirement_snapshot


def _read_property(properties: dict[str, Any], path: str) -> bool:
    current: Any = properties
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return False
        current = current[part]
    return current is not None


def _required_information(
    required: list[str], revision_id: uuid.UUID, session: Session
) -> tuple[list[str], set[uuid.UUID]]:
    missing: list[str] = []
    linked_components: set[uuid.UUID] = set()
    components_by_id = {
        component.id: component
        for component in session.scalars(
            select(DesignComponent).where(DesignComponent.revision_id == revision_id)
        )
    }
    facts = list(session.scalars(select(DesignFact).where(DesignFact.revision_id == revision_id)))
    for item in required:
        if item.startswith("fact:"):
            fact_type = item.removeprefix("fact:")
            matching_facts = [fact for fact in facts if fact.fact_type == fact_type] if fact_type else []
            if not matching_facts:
                missing.append(item)
            else:
                linked_components.update(
                    fact.component_id for fact in matching_facts if fact.component_id is not None
                )
            continue
        if item.startswith("component:"):
            parts = item.split(":", maxsplit=2)
            if len(parts) != 3 or not parts[2]:
                raise InvalidReference(
                    "Required component information must use 'component:<uuid>:<property.path>'."
                )
            try:
                component_id = uuid.UUID(parts[1])
            except ValueError as exc:
                raise InvalidReference(f"Invalid component reference in required information: {item}") from exc
            component = components_by_id.get(component_id)
            if component is None:
                raise InvalidReference(
                    f"Required information references a component outside design revision {revision_id}."
                )
            linked_components.add(component_id)
            if not _read_property(component.properties, parts[2]):
                missing.append(item)
            continue
        raise InvalidReference(
            "Required information must use 'fact:<fact_type>' or 'component:<uuid>:<property.path>'."
        )
    return missing, linked_components


def _verify_candidate(
    candidate: RequirementCandidateInput,
    revision_id: uuid.UUID,
    session: Session,
) -> dict[str, Any]:
    requirement = get_requirement(session, candidate.requirement_id)
    if requirement is None:
        raise EntityNotFound(f"Regulatory provision {candidate.requirement_id} was not found.")
    if candidate.retrieval_finding_id is not None:
        retrieval_finding = get_retrieval_finding(session, candidate.retrieval_finding_id)
        if retrieval_finding is None:
            raise EntityNotFound(f"Retrieval finding {candidate.retrieval_finding_id} was not found.")
        if retrieval_finding.provision_id != candidate.requirement_id:
            raise InvalidReference("The saved retrieval finding refers to a different provision.")

    component_ids = set(candidate.component_ids)
    if component_ids:
        components = list(
            session.scalars(select(DesignComponent).where(DesignComponent.id.in_(component_ids)))
        )
        if len(components) != len(component_ids) or any(
            component.revision_id != revision_id for component in components
        ):
            raise InvalidReference("Candidate components must belong to the assessment revision.")

    missing, referenced_components = _required_information(
        candidate.required_information, revision_id, session
    )
    component_ids.update(referenced_components)
    tool_result: VerificationResult | None = None
    if candidate.tool_name is not None:
        tool_result = registry.execute(candidate.tool_name, candidate.tool_inputs)
    if missing or (
        tool_result and tool_result.status in {"missing_information", "needs_information"}
    ):
        finding_type = "missing_information"
    elif tool_result and tool_result.status == "evidence_found":
        finding_type = "evidence_found"
    else:
        finding_type = "needs_engineering_review"

    components = list(
        session.scalars(select(DesignComponent).where(DesignComponent.id.in_(component_ids)))
    ) if component_ids else []
    facts = list(
        session.scalars(
            select(DesignFact).where(
                DesignFact.revision_id == revision_id,
                (DesignFact.component_id.is_(None)) | (DesignFact.component_id.in_(component_ids)),
            )
        )
    )
    evidence = {
        "design_revision_id": str(revision_id),
        "components": [
            {
                "id": str(component.id),
                "name": component.name,
                "source_reference": component.source_reference,
            }
            for component in sorted(components, key=lambda item: str(item.id))
        ],
        "design_facts": [
            {
                "id": str(fact.id),
                "statement": fact.statement,
                "source_reference": fact.source_reference,
            }
            for fact in sorted(facts, key=lambda item: str(item.id))
        ],
        "required_information_checked": candidate.required_information,
    }
    if candidate.retrieval_finding_id is not None:
        evidence["retrieval_finding_id"] = str(candidate.retrieval_finding_id)
    calculation_results = {}
    if tool_result is not None:
        calculation_results = {
            "tool": candidate.tool_name,
            "status": tool_result.status,
            "result": tool_result.result,
            "missing_information": tool_result.missing_information,
            "explanation": tool_result.explanation,
        }
    return {
        "requirement": requirement,
        "retrieval_finding_id": candidate.retrieval_finding_id,
        "component_ids": component_ids,
        "finding_type": finding_type,
        "verification_method": candidate.tool_name or candidate.verification_method,
        "evidence": evidence,
        "calculation_results": calculation_results,
        "missing_information": missing,
    }


def run_assessment(session: Session, payload: AssessmentRunRequest) -> Assessment:
    revision = session.get(DesignRevision, payload.revision_id)
    if revision is None:
        raise EntityNotFound("Design revision not found.")

    candidates = payload.candidates
    if not candidates:
        vessel = session.get(Vessel, revision.vessel_id)
        query = design_query_adapter.build_query(
            session, query=payload.query, revision_id=revision.id
        )
        requirements, _ = search_regulations(
            session,
            query,
            payload.limit,
            {"ship_type": vessel.vessel_type if vessel else None},
            payload.retrieval_mode,
        )
        candidates = [
            RequirementCandidateInput(requirement_id=requirement.id) for requirement in requirements
        ]

    prepared = [
        _verify_candidate(candidate, revision.id, session) for candidate in candidates
    ]
    assessment = Assessment(revision_id=revision.id, status="in_progress")
    session.add(assessment)
    session.flush()
    for candidate in prepared:
        requirement = candidate["requirement"]
        finding = Finding(
            assessment_id=assessment.id,
            revision_id=revision.id,
            requirement_id=requirement.id,
            retrieval_finding_id=candidate["retrieval_finding_id"],
            requirement_snapshot=_requirement_snapshot(requirement),
            verification_method=candidate["verification_method"],
            finding_type=candidate["finding_type"],
            status="open",
            description=(
                f"Candidate provision {requirement.clause_reference} requires engineering review. "
                "This assessment does not determine compliance."
            ),
            evidence=candidate["evidence"],
            calculation_results=candidate["calculation_results"],
            assumptions={
                "compliance_decision_made": False,
                "missing_information": candidate["missing_information"],
            },
        )
        session.add(finding)
        session.flush()
        session.add_all(
            FindingComponent(
                finding_id=finding.id,
                component_id=component_id,
                revision_id=revision.id,
            )
            for component_id in sorted(candidate["component_ids"], key=str)
        )
    assessment.status = "completed"
    assessment.completed_at = datetime.now(timezone.utc)
    commit_changes(session)
    session.refresh(assessment)
    return assessment
