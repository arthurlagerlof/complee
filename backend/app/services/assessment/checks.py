"""Engineering checks on real design information: completeness, consistency and deterministic requirement checks.

A small set of well-defined structured requirements, each tied to a provision in the regulation database (its
clause, edition and text are snapshotted into every finding). For each applicable design component the engine
1. checks that the property the requirement needs is available (completeness),
2. checks that all sources (drawings, specifications, model, documents) agree on it (consistency),
3. compares the value with the requirement using the deterministic comparison tool (engineering check).
Every finding records the provision and version, the affected component, the design evidence with its sources,
the required value or condition, the calculation result, missing information and assumptions, a confidence and
the engineer review status ("open"). Nothing here declares compliance; an engineer reviews every finding.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Assessment, DesignComponent, DesignFact, DesignRevision, Finding, FindingComponent, Vessel
from app.services import knowledge
from app.services.assessment.service import _requirement_snapshot
from app.services.calculations.comparison import to_number
from app.services.calculations.registry import registry
from app.services.common import EntityNotFound, commit_changes
from app.services.retrieval.service import get_requirement


@dataclass(frozen=True)
class StructuredRequirement:
    id: str
    title: str
    component_type: str  # knowledge catalogue type id
    property: str
    comparison: str  # min | max | in_set
    required: Any
    unit: str | None
    provision_id: uuid.UUID
    clause: str
    source_quote: str  # the figure as it appears in the provision text (read in the database)
    scope_assumption: str
    vessel_types: tuple[str, ...] = ()  # empty: no vessel-type restriction recorded
    allowed: tuple[str, ...] = ()
    selector: dict[str, tuple[str, ...]] = field(default_factory=dict)  # property or name must contain one of


CHECKS: tuple[StructuredRequirement, ...] = (
    StructuredRequirement(
        id="ADA-404.2.3-DOOR-CLEAR-WIDTH", title="Door clear width", component_type="door", property="clear_width",
        comparison="min", required=815, unit="mm", provision_id=uuid.UUID("020bb0c6-3747-4534-93a7-a0238773f2a3"),
        clause="ADA 404.2.3", source_quote="Door openings shall provide a clear width of 32 inches (815 mm) minimum.",
        scope_assumption="Applies to doors on an accessible route (2010 ADA Standards, used through the PVAG for passenger vessels); confirm that this door is on one.",
    ),
    StructuredRequirement(
        id="ADA-403.5.1-WALKING-SURFACE-WIDTH", title="Walking surface clear width", component_type="corridor",
        property="clear_width", comparison="min", required=915, unit="mm",
        provision_id=uuid.UUID("32047311-9335-41dd-910c-5652c778655e"), clause="ADA 403.5.1",
        source_quote="the clear width of walking surfaces shall be 36 inches (915 mm) minimum",
        scope_assumption="Applies to walking surfaces on an accessible route; the text allows 32 inches (815 mm) for at most 24 inches (610 mm) of length.",
    ),
    StructuredRequirement(
        id="ADA-405.2-RAMP-SLOPE", title="Ramp running slope", component_type="ramp", property="running_slope",
        comparison="max", required="1:12", unit="ratio", provision_id=uuid.UUID("7bcd8670-1cbe-47b7-a671-f7f18c29c046"),
        clause="ADA 405.2", source_quote="Ramp runs shall have a running slope not steeper than 1:12.",
        scope_assumption="Applies to ramps on an accessible route.",
    ),
    StructuredRequirement(
        id="SOLAS-II-2-13.3.3.4-DEAD-END-CORRIDOR", title="Dead-end corridor length (cargo ships)", component_type="corridor",
        property="dead_end_length", comparison="max", required=7, unit="m",
        provision_id=uuid.UUID("99934073-3b7f-49ec-a025-90cad48d8562"), clause="SOLAS II-2/13/3.3.4",
        source_quote="No dead-end corridors having a length of more than 7 m shall be accepted.",
        scope_assumption="Regulation 13.3.3 covers cargo ships; for other ship types confirm which escape requirements apply.",
        vessel_types=("cargo",),
    ),
    StructuredRequirement(
        id="SOLAS-II-2-4.2.2.5.1-FO-PIPE-MATERIAL", title="Oil fuel pipe material", component_type="pipe", property="material",
        comparison="in_set", required="steel or other approved material", unit=None, allowed=("steel",),
        provision_id=uuid.UUID("57fa28dc-08ea-49ca-b0b6-912f49e15736"), clause="SOLAS II-2/4/2.2.5.1",
        source_quote="Oil fuel pipes and their valves and fittings shall be of steel or other approved material",
        scope_assumption="Other approved materials and restricted use of flexible pipes are allowed by the text; a non-steel material needs engineer review, not rejection.",
        selector={"system": ("fuel oil", "oil fuel", "fo", "hfo", "mgo", "mdo", "diesel")},
    ),
)


def _value_of(raw: Any) -> tuple[Any, str | None]:
    if isinstance(raw, dict):
        return raw.get("value"), raw.get("unit")
    return raw, None


def _source(ref: dict[str, Any] | None) -> dict[str, Any]:
    ref = ref or {}
    evidence = ref.get("evidence") or []
    return {k: v for k, v in {
        "source_type": ref.get("source_type"), "source_name": ref.get("source_name"),
        "source_file_id": ref.get("source_file_id"), "extraction_id": ref.get("extraction_id"),
        "evidence": evidence[0] if evidence else None,
    }.items() if v is not None}


def resolve_type(component: DesignComponent) -> str | None:
    """Catalogue type of a design component: its own type when it is a catalogue id, else the best knowledge match."""
    if knowledge.component_type(component.component_type):
        return component.component_type
    matches = knowledge.match_component_types(f"{component.component_type} {component.name}")
    if not matches:
        return None
    return matches[0].get("more_specific") or matches[0]["id"]


def _type_family(type_id: str | None) -> set[str]:
    out = set()
    while type_id:
        out.add(type_id)
        t = knowledge.component_type(type_id)
        type_id = t.parent if t else None
    return out


def property_values(component: DesignComponent, facts: list[DesignFact], name: str) -> list[dict[str, Any]]:
    """Every value the revision holds for a component property: the component record and each source's fact."""
    values = []
    value, unit = _value_of((component.properties or {}).get(name))
    if value is not None:
        values.append({"value": value, "unit": unit, "origin": "component", "component_id": str(component.id),
                       "source": _source(component.source_reference), "review_status": component.review_status,
                       "confidence": component.confidence})
    for fact in facts:
        if fact.component_id == component.id and fact.fact_type in (f"component_property:{name}", name):
            value, unit = _value_of(fact.value)
            if value is not None:
                values.append({"value": value, "unit": unit, "origin": "fact", "fact_id": str(fact.id),
                               "source": _source(fact.source_reference), "review_status": fact.review_status,
                               "confidence": fact.confidence})
    return values


def _normalized(entry: dict[str, Any]) -> Any:
    number = to_number(entry["value"], entry["unit"])
    if number is not None:
        return round(number[0], 6), number[1]
    return str(entry["value"]).strip().lower(), None


def disagreements(values: list[dict[str, Any]], tolerance: float = 0.005) -> list[dict[str, Any]]:
    """Distinct values (after unit conversion; relative tolerance 0.5 %) when the sources disagree, else []."""
    distinct: list[tuple[Any, list[dict[str, Any]]]] = []
    for entry in values:
        key = _normalized(entry)
        for existing, members in distinct:
            same = (key == existing) or (
                isinstance(key[0], float) and isinstance(existing[0], float) and key[1] == existing[1]
                and abs(key[0] - existing[0]) <= tolerance * max(abs(key[0]), abs(existing[0]), 1e-9)
            )
            if same:
                members.append(entry)
                break
        else:
            distinct.append((key, [entry]))
    if len(distinct) < 2:
        return []
    return [{"normalized": {"value": k[0], "unit": k[1]}, "sources": [m["source"] for m in members],
             "as_written": [f"{m['value']} {m['unit'] or ''}".strip() for m in members]} for k, members in distinct]


def _selected(check: StructuredRequirement, component: DesignComponent, facts: list[DesignFact]) -> bool:
    for prop, needles in check.selector.items():
        texts = [str(v["value"]).lower() for v in property_values(component, facts, prop)] + [component.name.lower()]
        if not any(n in t.split() or (len(n) > 3 and n in t) for t in texts for n in needles):
            return False
    return True


def _confidence(values: list[dict[str, Any]], applicability_confirmed: bool, component: DesignComponent) -> tuple[float, str]:
    # With no value at all, the finding rests on the component record itself (that the property is missing).
    inputs = values or [{"confidence": component.confidence, "review_status": component.review_status}]
    known = [v["confidence"] for v in inputs if v.get("confidence") is not None]
    base = min(known) if known else 0.5
    reviewed = all(v.get("review_status") == "approved" for v in inputs)
    score = base * (1.0 if reviewed else 0.5) * (1.0 if applicability_confirmed else 0.7)
    return round(score, 2), ("min(source confidences, or the component's when no value exists; default 0.5) × 0.5 if any input is not engineer-approved "
                             "× 0.7 if applicability to the vessel type is not confirmed")


def _evaluate(check: StructuredRequirement, component: DesignComponent, facts: list[DesignFact], vessel_type: str | None) -> dict[str, Any]:
    values = property_values(component, facts, check.property)
    applicability_confirmed = not check.vessel_types or bool(vessel_type and any(v in vessel_type.lower() for v in check.vessel_types))
    assumptions: dict[str, Any] = {
        "compliance_decision_made": False,
        "scope": check.scope_assumption,
        "applicability_to_vessel_type": "confirmed" if applicability_confirmed else f"not confirmed for vessel type {vessel_type or 'unknown'!r}",
        "missing_information": [],
    }
    required = {"comparison": check.comparison, "value": check.required, "unit": check.unit, "allowed": list(check.allowed),
                "source_quote": check.source_quote}
    evidence = {"check_id": check.id, "component": {"id": str(component.id), "name": component.name, "type": component.component_type,
                "source": _source(component.source_reference)}, "property": check.property, "values": values}
    confidence, method = _confidence(values, applicability_confirmed, component)
    assumptions["confidence"], assumptions["confidence_method"] = confidence, method
    label = f"{check.title} of {component.name!r} ({check.clause})"
    if not values:
        assumptions["missing_information"] = [check.property]
        return {"capability": "completeness", "finding_type": "missing_information", "evidence": evidence, "assumptions": assumptions,
                "calculation_results": {"required": required},
                "description": f"{label}: no {check.property.replace('_', ' ')} in any source, so the requirement cannot be checked.",
                "suggested_action": f"Add {check.property.replace('_', ' ')} from the drawing, specification or model and re-run the check."}
    conflict = disagreements(values)
    if conflict:
        evidence["disagreement"] = conflict
        return {"capability": "consistency", "finding_type": "potential_issue", "evidence": evidence, "assumptions": assumptions,
                "calculation_results": {"required": required},
                "description": f"{label}: the sources disagree ({' vs '.join(', '.join(c['as_written']) for c in conflict)}); "
                               "the requirement is not evaluated until one value is confirmed.",
                "suggested_action": "Resolve which source is current (drawing, specification or model) and correct the others."}
    entry = values[0]
    result = registry.execute("requirement_comparison", {
        "measured": entry["value"], "unit": entry["unit"], "comparison": check.comparison, "required": check.required,
        "required_unit": check.unit, "allowed": list(check.allowed)})
    calculation = {"tool": "requirement_comparison", "status": result.status, "result": result.result,
                   "explanation": result.explanation, "required": required}
    if result.status in ("needs_information", "missing_information"):
        assumptions["missing_information"] = result.missing_information
        finding_type, action = "missing_information", "Provide the value in a unit of the required quantity."
    elif result.result.get("satisfied"):
        finding_type, action = "evidence_found", "Engineer to confirm applicability and the source value."
    elif check.comparison == "in_set":
        finding_type, action = "needs_engineering_review", "Confirm whether the material is an approved alternative."
    else:
        finding_type, action = "potential_issue", "Review the design value against the requirement."
    return {"capability": "engineering_check", "finding_type": finding_type, "evidence": evidence, "assumptions": assumptions,
            "calculation_results": calculation,
            "description": f"{label}: {result.explanation} Deterministic comparison; engineer review required.",
            "suggested_action": action}


def prepare_engineering_checks(
    session: Session, revision_id: uuid.UUID, check_ids: list[str] | None = None
) -> tuple[DesignRevision, list[tuple[StructuredRequirement, Any, DesignComponent, dict[str, Any]]], list[dict[str, Any]]]:
    """Evaluate the structured checks for a revision without storing anything: (revision, outcomes, skipped)."""
    revision = session.get(DesignRevision, revision_id)
    if revision is None:
        raise EntityNotFound("Design revision not found.")
    unknown = sorted(set(check_ids or []) - {c.id for c in CHECKS})
    if unknown:
        raise EntityNotFound(f"Unknown engineering check: {', '.join(unknown)}")
    checks = [c for c in CHECKS if not check_ids or c.id in check_ids]
    vessel = session.get(Vessel, revision.vessel_id)
    components = list(session.scalars(select(DesignComponent).where(DesignComponent.revision_id == revision_id)))
    facts = list(session.scalars(select(DesignFact).where(DesignFact.revision_id == revision_id)))
    types = {c.id: _type_family(resolve_type(c)) for c in components}

    prepared, skipped = [], []
    for check in checks:
        requirement = get_requirement(session, check.provision_id)
        if requirement is None:
            skipped.append({"check_id": check.id, "reason": f"provision {check.clause} not found in the regulation database"})
            continue
        applicable = [c for c in components if check.component_type in types[c.id] and _selected(check, c, facts)]
        if not applicable:
            skipped.append({"check_id": check.id, "reason": f"no {check.component_type.replace('_', ' ')} in this revision"})
        for component in applicable:
            prepared.append((check, requirement, component, _evaluate(check, component, facts, vessel.vessel_type if vessel else None)))
    return revision, prepared, skipped


def run_engineering_checks(session: Session, revision_id: uuid.UUID, check_ids: list[str] | None = None) -> dict[str, Any]:
    revision, prepared, skipped = prepare_engineering_checks(session, revision_id, check_ids)

    assessment = Assessment(revision_id=revision.id, status="in_progress")
    session.add(assessment)
    session.flush()
    finding_ids = []
    for check, requirement, component, outcome in prepared:
        finding = Finding(
            assessment_id=assessment.id, revision_id=revision.id, requirement_id=requirement.id,
            requirement_snapshot=_requirement_snapshot(requirement), verification_method=f"engineering_check:{check.id}",
            finding_type=outcome["finding_type"], status="open", description=outcome["description"],
            evidence={**outcome["evidence"], "capability": outcome["capability"]},
            calculation_results=outcome["calculation_results"], assumptions=outcome["assumptions"],
            suggested_action=outcome["suggested_action"],
        )
        session.add(finding)
        session.flush()
        session.add(FindingComponent(finding_id=finding.id, component_id=component.id, revision_id=revision.id))
        finding_ids.append(finding.id)
    assessment.status = "completed"
    assessment.completed_at = datetime.now(timezone.utc)
    commit_changes(session)
    return {"assessment_id": assessment.id, "finding_ids": finding_ids, "skipped_checks": skipped,
            "summary": _summary([o for *_, o in prepared])}


def _summary(outcomes: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for o in outcomes:
        key = f"{o['capability']}:{o['finding_type']}"
        out[key] = out.get(key, 0) + 1
    return out


def completeness_report(session: Session, revision_id: uuid.UUID) -> dict[str, Any]:
    """Catalogue-based information completeness and source consistency for every component of a revision.
    Computed on request; nothing is stored."""
    if session.get(DesignRevision, revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    components = list(session.scalars(select(DesignComponent).where(DesignComponent.revision_id == revision_id)))
    facts = list(session.scalars(select(DesignFact).where(DesignFact.revision_id == revision_id)))
    rows, unclassified = [], []
    for component in components:
        type_id = resolve_type(component)
        spec = knowledge.component_type(type_id) if type_id else None
        if spec is None:
            unclassified.append({"component_id": str(component.id), "name": component.name, "component_type": component.component_type})
            continue
        present, missing, conflicts = [], [], []
        for prop in spec.properties:
            values = property_values(component, facts, prop.name)
            if values:
                present.append(prop.name)
                conflict = disagreements(values)
                if conflict:
                    conflicts.append({"property": prop.name, "values": conflict})
            elif prop.required:
                missing.append(prop.name)
        key = [p.name for p in spec.properties if p.required]
        rows.append({"component_id": str(component.id), "name": component.name, "catalogue_type": spec.id,
                     "key_properties": key, "present": present, "missing_key_properties": missing,
                     "complete": not missing, "inconsistent_properties": conflicts})
    return {
        "revision_id": str(revision_id),
        "catalogue_version": knowledge.catalogue().version,
        "components": rows,
        "unclassified_components": unclassified,
        "summary": {"components": len(components), "classified": len(rows), "complete": sum(r["complete"] for r in rows),
                    "with_missing_key_properties": sum(not r["complete"] for r in rows),
                    "with_inconsistent_sources": sum(bool(r["inconsistent_properties"]) for r in rows)},
    }


def check_catalogue() -> list[dict[str, Any]]:
    return [{"id": c.id, "title": c.title, "component_type": c.component_type, "property": c.property,
             "comparison": c.comparison, "required": c.required, "unit": c.unit, "allowed": list(c.allowed),
             "provision_id": str(c.provision_id), "clause": c.clause, "source_quote": c.source_quote,
             "scope_assumption": c.scope_assumption, "vessel_types": list(c.vessel_types)} for c in CHECKS]
