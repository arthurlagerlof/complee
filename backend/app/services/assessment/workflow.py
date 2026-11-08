"""End-to-end assessment workflow for one design revision.

One run chains the existing pieces and stores everything as findings of one assessment:

1. structured engineering checks (completeness, source consistency, deterministic comparison) — checks.py;
2. regulatory retrieval per catalogue component type (hybrid BGE-M3 + full text; falls back to full text and says so
   when the embedding model is not installed) — retrieval/service.py, knowledge layer;
3. AI interpretation of the top retrieved provisions through the AI gateway, with verbatim-quote-gated deterministic
   comparison — ai_review.py (optional, skipped and reported when no AI is configured);
4. remaining retrieved provisions as candidates for engineering review;
5. rule ambiguity and estimated compliance likelihood for every finding — scoring.py.

Runs are *provisional*: the revision stays editable while sources are still being added. A new run supersedes the
previous provisional one and records which findings are new, changed or unchanged. Finalizing a run checks that the
design data is unchanged since the run and completes the assessment, which makes the revision immutable (as every
completed assessment does). The assessment row is the persistent run record (queued → running → provisional /
failed); run inputs, stage results and errors are stored with every finding so a run can be reproduced.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.db.models import (
    Assessment,
    ComponentRelationship,
    DesignComponent,
    DesignFact,
    DesignRevision,
    Finding,
    FindingComponent,
    Vessel,
)
from app.services import knowledge
from app.services.assessment import ai_review
from app.services.assessment.checks import prepare_engineering_checks, resolve_type
from app.services.assessment.scoring import SCORING_VERSION, ScoringContext, score_finding
from app.services.assessment.service import _requirement_snapshot
from app.services.calculations import modules
from app.services.common import ConflictError, EntityNotFound, InvalidReference
from app.services.retrieval.service import (
    EmbeddingProviderError,
    VectorSearchUnavailable,
    get_requirement,
    search_regulations,
)

logger = logging.getLogger(__name__)

WORKFLOW_VERSION = "shipcheck-workflow.v1"
ACTIVE = {"queued", "running"}
STALE_AFTER = timedelta(minutes=15)
MAX_COMPONENTS_PER_PROVISION = 25


@dataclass
class RunOptions:
    retrieval_mode: str = "hybrid"  # hybrid | vector | full_text
    per_type_limit: int = 4
    max_provisions: int = 12
    ai_interpretation: str = "auto"  # auto | off
    max_ai_provisions: int = 3
    extra_requirement_ids: list[str] = field(default_factory=list)
    trigger: str = "manual"
    force: bool = False

    def key(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("trigger")
        data.pop("force")
        return data


# ---------------------------------------------------------------- fingerprints and run records


def design_fingerprint(session: Session, revision_id: uuid.UUID) -> str:
    """SHA-256 over the revision's components, facts and relationships (values, sources and review states)."""
    components = session.scalars(select(DesignComponent).where(DesignComponent.revision_id == revision_id)).all()
    facts = session.scalars(select(DesignFact).where(DesignFact.revision_id == revision_id)).all()
    relations = session.scalars(select(ComponentRelationship).where(ComponentRelationship.revision_id == revision_id)).all()
    payload = {
        "components": sorted(
            [str(c.id), c.component_type, c.name, c.properties, c.geometry_reference, c.source_reference, c.review_status]
            for c in components),
        "facts": sorted(
            [str(f.id), str(f.component_id), f.fact_type, f.statement, f.value, f.source_reference, f.review_status]
            for f in facts),
        "relationships": sorted(
            [str(r.source_component_id), str(r.target_component_id), r.relationship_type, r.properties] for r in relations),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def _run_record(assessment: Assessment) -> dict[str, Any]:
    for finding in assessment.findings:
        run = (finding.evidence or {}).get("workflow", {}).get("run")
        if run:
            return run
    return {}


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _is_stale(assessment: Assessment) -> bool:
    created = _aware(assessment.created_at)
    return assessment.status in ACTIVE and created is not None and datetime.now(timezone.utc) - created > STALE_AFTER


def run_summary(assessment: Assessment) -> dict[str, Any]:
    run = _run_record(assessment)
    counts: dict[str, int] = {}
    changes: dict[str, int] = {}
    likelihood: dict[str, int] = {}
    for finding in assessment.findings:
        counts[finding.finding_type] = counts.get(finding.finding_type, 0) + 1
        change = (finding.evidence or {}).get("workflow", {}).get("change")
        if change:
            changes[change] = changes.get(change, 0) + 1
        label = ((finding.calculation_results or {}).get("scores") or {}).get("compliance_likelihood", {}).get("label")
        if label:
            likelihood[label] = likelihood.get(label, 0) + 1
    return {
        "assessment_id": str(assessment.id),
        "revision_id": str(assessment.revision_id),
        "status": "stale" if _is_stale(assessment) else assessment.status,
        "created_at": assessment.created_at,
        "completed_at": assessment.completed_at,
        "findings": len(assessment.findings),
        "finding_types": counts,
        "likelihood_labels": likelihood,
        "changes_vs_previous": changes,
        "removed_vs_previous": run.get("removed_vs_previous", []),
        "workflow_version": run.get("version"),
        "trigger": run.get("trigger"),
        "options": run.get("options"),
        "design_fingerprint": run.get("design_fingerprint"),
        "stages": run.get("stages", {}),
        "previous_assessment_id": run.get("previous_assessment_id"),
    }


def list_runs(session: Session, revision_id: uuid.UUID) -> list[dict[str, Any]]:
    if session.get(DesignRevision, revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    assessments = session.scalars(
        select(Assessment).where(Assessment.revision_id == revision_id).order_by(Assessment.created_at.desc())
    ).all()
    # Newest first; runs created in the same instant are ordered by state so the current run comes first.
    rank = {"running": 0, "queued": 0, "provisional": 1, "completed": 1, "failed": 2, "superseded": 3}
    ordered = sorted(assessments, key=lambda a: (-(_aware(a.created_at) or datetime.min.replace(tzinfo=timezone.utc)).timestamp(),
                                                 rank.get(a.status, 2)))
    return [run_summary(a) for a in ordered]


def get_run(session: Session, assessment_id: uuid.UUID) -> Assessment:
    assessment = session.get(Assessment, assessment_id)
    if assessment is None:
        raise EntityNotFound("Assessment run not found.")
    return assessment


def queue_run(session: Session, revision_id: uuid.UUID, options: RunOptions) -> tuple[Assessment, bool]:
    """Create a queued run, or return the active / identical one instead of processing the same data twice."""
    if session.get(DesignRevision, revision_id) is None:
        raise EntityNotFound("Design revision not found.")
    for requirement_id in options.extra_requirement_ids:
        try:
            uuid.UUID(str(requirement_id))
        except ValueError as exc:
            raise InvalidReference(f"Invalid provision id: {requirement_id}") from exc
    existing = session.scalars(
        select(Assessment).where(Assessment.revision_id == revision_id).order_by(Assessment.created_at.desc())
    ).all()
    if not options.force:
        for assessment in existing:
            if assessment.status in ACTIVE and not _is_stale(assessment):
                return assessment, False
        fingerprint = design_fingerprint(session, revision_id)
        for assessment in existing:
            if assessment.status in {"provisional", "completed"}:
                run = _run_record(assessment)
                if run.get("design_fingerprint") == fingerprint and run.get("options") == options.key():
                    return assessment, False
                break
    assessment = Assessment(revision_id=revision_id, status="queued")
    session.add(assessment)
    session.commit()
    session.refresh(assessment)
    return assessment, True


# ---------------------------------------------------------------- stages


def _structured_outcomes(session: Session, revision_id: uuid.UUID) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    _, prepared, skipped = prepare_engineering_checks(session, revision_id)
    outcomes = []
    for check, requirement, component, outcome in prepared:
        calc = dict(outcome["calculation_results"])
        result = calc.get("result") or {}
        evidence = outcome["evidence"]
        conflicts = evidence.get("disagreement", [])
        missing = outcome["assumptions"].get("missing_information", [])
        comparison = None
        if calc.get("tool") == "requirement_comparison" and result.get("satisfied") is not None:
            comparison = {**result, "comparison": check.comparison}
        if missing:
            module_name, code = "properties.completeness", "required_information_missing"
        elif conflicts:
            module_name, code = "properties.source_consistency", "sources_disagree"
        elif comparison is None:
            module_name, code = "properties.numeric_comparison", "not_comparable"
        else:
            module_name = "properties.numeric_comparison"
            code = "satisfied" if comparison["satisfied"] else ("not_in_listed_set" if check.comparison == "in_set" else "not_satisfied")
        calc["comparison"] = {
            "method": module_name,
            "module_version": modules.get(module_name).version if module_name != "properties.source_consistency" else "checks.v1",
            "result": code,
            "assumptions": [check.scope_assumption],
            "calculation_details": {k: calc[k] for k in ("tool", "status", "result", "explanation") if k in calc} or None,
        }
        applicability = outcome["assumptions"].get("applicability_to_vessel_type") == "confirmed"
        outcomes.append({
            "requirement": requirement,
            "verification_method": f"engineering_check:{check.id}",
            "finding_type": outcome["finding_type"],
            "description": outcome["description"],
            "evidence": {**evidence, "capability": outcome["capability"],
                         "requirement_interpretation": {
                             "source": requirement.document_code, "provision_id": str(requirement.id),
                             "clause": check.clause, "edition": requirement.edition, "description": check.title,
                             "applicable_conditions": [check.scope_assumption]
                             + ([f"vessel types: {', '.join(check.vessel_types)}"] if check.vessel_types else []),
                             "component_selectors": {"component_type": check.component_type,
                                                     **{k: list(v) for k, v in check.selector.items()}},
                             "required_properties": [check.property], "comparison_method": "properties.numeric_comparison",
                             "required_value": {"comparison": check.comparison, "value": check.required, "unit": check.unit,
                                                "allowed": list(check.allowed)},
                             "source_quote": check.source_quote,
                             "interpretation_source": "structured_check_catalogue (quote verified in the regulation database)",
                             "approval_status": "pending_engineer_review",
                         }},
            "calculation_results": calc,
            "assumptions": outcome["assumptions"],
            "suggested_action": outcome["suggested_action"],
            "component_ids": {component.id},
            "scoring": ScoringContext(
                provision_text=requirement.text,
                source_availability=requirement.provision_availability or requirement.source_availability,
                edition=requirement.edition, method="deterministic", structured_condition=True,
                applicability_confirmed=applicability, scope_assumption=check.scope_assumption,
                finding_type=outcome["finding_type"], comparison=comparison,
                input_values=evidence.get("values", []), conflicts=conflicts, missing_information=missing,
            ),
        })
    stage = {"status": "completed", "findings": len(outcomes), "skipped_checks": skipped}
    return outcomes, stage


def _search(session: Session, query: str, terms: list[str], options: RunOptions, info: dict[str, Any]) -> tuple[list[Any], str]:
    if options.retrieval_mode in {"hybrid", "vector"} and not info.get("fallback_reason"):
        try:
            with session.begin_nested():
                results, _ = search_regulations(session, query, options.per_type_limit, {}, options.retrieval_mode)
            return results, options.retrieval_mode
        except (EmbeddingProviderError, VectorSearchUnavailable, DBAPIError) as exc:
            info["fallback_reason"] = f"{options.retrieval_mode} search unavailable ({type(exc).__name__}): {str(exc)[:240]}"
    merged: dict[str, Any] = {}
    for term in terms[:4]:
        try:
            with session.begin_nested():
                results, _ = search_regulations(session, term, options.per_type_limit, {}, "full_text")
        except DBAPIError as exc:
            info.setdefault("errors", []).append(f"full-text search for {term!r} failed: {type(exc).__name__}")
            continue
        for result in results:
            merged.setdefault(str(result.id), result)
    return list(merged.values())[: options.per_type_limit], "full_text"


def _retrieval_candidates(
    session: Session, components: list[DesignComponent], facts: list[DesignFact], options: RunOptions, covered: set[str]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    groups: dict[str, list[DesignComponent]] = {}
    unclassified = []
    for component in components:
        type_id = resolve_type(component)
        if type_id:
            groups.setdefault(type_id, []).append(component)
        else:
            unclassified.append(component.name)
    info: dict[str, Any] = {"mode_requested": options.retrieval_mode, "mode_used": None, "fallback_reason": None,
                            "queries": [], "unclassified_components": unclassified[:50],
                            "note": "Retrieval ranks candidates; similarity does not establish applicability."}
    candidates: dict[str, dict[str, Any]] = {}
    modes = set()
    for type_id, members in sorted(groups.items()):
        spec = knowledge.component_type(type_id)
        properties = sorted({name for c in members for name in (c.properties or {})}
                            | {f.fact_type.removeprefix("component_property:") for f in facts
                               if f.component_id in {c.id for c in members} and f.fact_type.startswith("component_property:")})
        terms = list(spec.regulatory.terms) or [spec.name]
        query = f"{spec.name}. " + "; ".join(terms) + (f". Design properties: {', '.join(properties)}" if properties else "")
        results, mode = _search(session, query, terms, options, info)
        modes.add(mode)
        info["queries"].append({"component_type": type_id, "components": len(members), "query": query, "method": mode,
                                "results": len(results)})
        for rank, requirement in enumerate(results):
            linked = any(requirement.document_code == ref.document and (requirement.clause_reference or "").startswith(ref.clause_prefix)
                         for ref in spec.regulatory.clauses)
            entry = candidates.setdefault(str(requirement.id), {"requirement": requirement, "groups": [], "best_rank": rank,
                                                                "catalogue_linked": False})
            entry["best_rank"] = min(entry["best_rank"], rank)
            entry["catalogue_linked"] |= linked
            entry["groups"].append({
                "component_type": type_id, "component_ids": [str(c.id) for c in members][:MAX_COMPONENTS_PER_PROVISION],
                "component_names": [c.name for c in members][:MAX_COMPONENTS_PER_PROVISION], "query": query, "method": mode,
                "rank": rank, "catalogue_linked": linked,
                "scores": {k: getattr(requirement, k) for k in ("similarity_score", "meaning_distance", "word_search_score",
                                                                 "combined_score", "ranking_score") if getattr(requirement, k) is not None},
            })
    info["mode_used"] = ", ".join(sorted(modes)) if modes else None
    for requirement_id in options.extra_requirement_ids:
        if requirement_id in candidates:
            candidates[requirement_id]["requested_by_engineer"] = True
            continue
        requirement = get_requirement(session, uuid.UUID(str(requirement_id)))
        if requirement is None:
            info.setdefault("errors", []).append(f"requested provision {requirement_id} not found")
            continue
        candidates[str(requirement.id)] = {"requirement": requirement, "groups": [], "best_rank": -1, "catalogue_linked": False,
                                           "requested_by_engineer": True}
    excluded = [cid for cid in candidates if cid in covered and not candidates[cid].get("requested_by_engineer")]
    for cid in excluded:
        candidates.pop(cid)
    info["excluded_already_checked"] = excluded
    ordered = sorted(candidates.values(), key=lambda c: (not c.get("requested_by_engineer"), not c["catalogue_linked"], c["best_rank"]))
    info["candidates"] = len(ordered)
    return ordered[: max(options.max_provisions, len(options.extra_requirement_ids))], info


def _applicability(requirement, vessel: Vessel | None) -> tuple[bool | None, str]:
    applies = [a.lower() for a in (requirement.instrument_applicability or [])]
    vessel_type = (vessel.vessel_type or "").lower() if vessel else ""
    if not applies:
        return None, "The instrument records no ship-type restriction; applicability has not been assessed."
    if vessel_type and any(a in vessel_type or vessel_type in a for a in applies):
        return True, f"The instrument applies to {', '.join(applies)}; vessel type {vessel_type!r} matches."
    return False, f"The instrument applies to {', '.join(applies)}; vessel type {vessel_type or 'unknown'!r} does not match."


def _retrieval_outcome(candidate: dict[str, Any], vessel: Vessel | None, ai_note: str | None) -> dict[str, Any]:
    requirement = candidate["requirement"]
    names = sorted({n for g in candidate["groups"] for n in g["component_names"]})
    component_ids = {uuid.UUID(i) for g in candidate["groups"] for i in g["component_ids"]}
    applicable, applicability_note = _applicability(requirement, vessel)
    how = "requested by the engineer" if candidate.get("requested_by_engineer") and not candidate["groups"] else (
        "retrieved by " + ", ".join(sorted({g["method"] for g in candidate["groups"]})))
    description = (
        f"{requirement.document_code} {requirement.clause_reference} was {how} as possibly relevant"
        + (f" to {', '.join(names[:6])}{' …' if len(names) > 6 else ''}" if names else "")
        + ". It has not been interpreted against the design; applicability and requirements need engineering review."
    )
    return {
        "requirement": requirement,
        "verification_method": "retrieval_candidate",
        "finding_type": "needs_engineering_review",
        "description": description,
        "evidence": {"retrieval": {"groups": candidate["groups"], "catalogue_linked": candidate["catalogue_linked"],
                                   "requested_by_engineer": bool(candidate.get("requested_by_engineer"))},
                     "applicability": applicability_note,
                     **({"ai_interpretation": ai_note} if ai_note else {}),
                     "requirement_interpretation": {
                         "source": requirement.document_code, "provision_id": str(requirement.id),
                         "clause": requirement.clause_reference, "edition": requirement.edition,
                         "interpretation_source": "none", "approval_status": "pending_engineer_review"}},
        "calculation_results": {"comparison": {"method": None, "result": "not_compared", "assumptions": [],
                                               "calculation_details": None}},
        "assumptions": {"compliance_decision_made": False, "missing_information": [],
                        "applicability": applicability_note},
        "suggested_action": "Decide whether the provision applies; if it does, identify the design properties it constrains.",
        "component_ids": component_ids,
        "scoring": ScoringContext(provision_text=requirement.text,
                                  source_availability=requirement.provision_availability or requirement.source_availability,
                                  edition=requirement.edition, method="retrieval_only", applicability_confirmed=applicable),
    }


def _ai_outcome(candidate: dict[str, Any], interpreted: dict[str, Any], vessel: Vessel | None) -> dict[str, Any]:
    requirement = candidate["requirement"]
    review = interpreted["review"]
    calculations = interpreted["calculation_results"].get("calculations", [])
    applicable, applicability_note = _applicability(requirement, vessel)
    executed = [c for c in calculations if (c.get("result") or {}).get("satisfied") is not None]
    chosen = next((c for c in executed if not c["result"]["satisfied"]), executed[0] if executed else None)
    comparison = {**chosen["result"], "comparison": chosen["comparison"]} if chosen else None
    values = ([chosen["design_value"]] + list(chosen.get("other_source_values", []))) if chosen else []
    calc = dict(interpreted["calculation_results"])
    calc["comparison"] = {
        "method": "evidence.document_comparison" + (" + properties.numeric_comparison" if chosen else ""),
        "module_version": modules.get("evidence.document_comparison").version,
        "result": ("satisfied" if comparison["satisfied"] else "not_satisfied") if comparison else "interpreted_not_compared",
        "assumptions": review.applicability_questions, "calculation_details": chosen,
    }
    evidence = {**interpreted["evidence"], "retrieval": {"groups": candidate["groups"], "catalogue_linked": candidate["catalogue_linked"],
                                                         "requested_by_engineer": bool(candidate.get("requested_by_engineer"))},
                "applicability": applicability_note,
                "requirement_interpretation": {
                    "source": requirement.document_code, "provision_id": str(requirement.id), "clause": requirement.clause_reference,
                    "edition": requirement.edition, "description": review.requirement_summary,
                    "applicable_conditions": review.applicability_questions, "condition_type": review.condition_type,
                    "conditions": [c.model_dump() for c in review.conditions], "exceptions": review.exceptions,
                    "alternative_interpretations": review.alternative_interpretations, "undefined_terms": review.undefined_terms,
                    "comparison_method": calc["comparison"]["method"], "interpretation_source": "ai_gateway",
                    "interpretation_confidence": review.confidence, "approval_status": "pending_engineer_review"}}
    component_ids = set(interpreted["linked_component_ids"]) or {uuid.UUID(i) for g in candidate["groups"] for i in g["component_ids"]}
    return {
        "requirement": requirement,
        "verification_method": interpreted["verification_method"],
        "finding_type": interpreted["finding_type"],
        "description": interpreted["description"],
        "evidence": evidence,
        "calculation_results": calc,
        "assumptions": {**interpreted["assumptions"], "applicability": applicability_note},
        "suggested_action": interpreted["suggested_action"],
        "component_ids": component_ids,
        "scoring": ScoringContext(
            provision_text=requirement.text, source_availability=requirement.provision_availability or requirement.source_availability,
            edition=requirement.edition, method="ai_assisted", structured_condition=bool(chosen),
            applicability_confirmed=applicable, applicability_questions=review.applicability_questions,
            alternative_interpretations=review.alternative_interpretations, undefined_terms=review.undefined_terms,
            exceptions_reported=review.exceptions, finding_type=interpreted["finding_type"], comparison=comparison,
            input_values=values, missing_information=[] if chosen else review.missing_information, threshold_from_ai=bool(chosen),
        ),
    }


def _key(outcome: dict[str, Any]) -> str:
    return "|".join([outcome["verification_method"], str(outcome["requirement"].id),
                     ",".join(sorted(str(c) for c in outcome["component_ids"]))])


def _signature(finding_type: str, calculation_results: dict[str, Any]) -> list[Any]:
    scores = (calculation_results or {}).get("scores") or {}
    comparison = (calculation_results or {}).get("comparison") or {}
    return [finding_type, scores.get("rule_ambiguity", {}).get("score"), scores.get("compliance_likelihood", {}).get("score"),
            comparison.get("result"), json.dumps(comparison.get("calculation_details"), sort_keys=True, default=str)]


# ---------------------------------------------------------------- execution


def execute_run(session: Session, assessment_id: uuid.UUID, options: RunOptions) -> dict[str, Any]:
    assessment = get_run(session, assessment_id)
    if assessment.status not in ACTIVE:
        raise ConflictError(f"Run is {assessment.status}; only queued runs can be executed.")
    revision_id = assessment.revision_id
    assessment.status = "running"
    session.commit()
    stages: dict[str, Any] = {}
    try:
        revision = session.get(DesignRevision, revision_id)
        vessel = session.get(Vessel, revision.vessel_id) if revision else None
        fingerprint = design_fingerprint(session, revision_id)
        components = list(session.scalars(select(DesignComponent).where(DesignComponent.revision_id == revision_id)))
        facts = list(session.scalars(select(DesignFact).where(DesignFact.revision_id == revision_id)))

        outcomes: list[dict[str, Any]] = []
        try:
            structured, stages["structured_checks"] = _structured_outcomes(session, revision_id)
            outcomes += structured
        except Exception as exc:  # noqa: BLE001 - a failed stage must not discard the other stages
            logger.exception("Structured checks failed for run %s", assessment_id)
            stages["structured_checks"] = {"status": "failed", "error": str(exc)[:500]}
        covered = {str(o["requirement"].id) for o in outcomes}

        try:
            candidates, stages["retrieval"] = _retrieval_candidates(session, components, facts, options, covered)
            stages["retrieval"]["status"] = "completed"
        except Exception as exc:  # noqa: BLE001
            logger.exception("Retrieval failed for run %s", assessment_id)
            candidates, stages["retrieval"] = [], {"status": "failed", "error": str(exc)[:500]}

        ai_stage: dict[str, Any] = {"status": "skipped", "interpreted": 0, "errors": []}
        ai_notes: dict[str, str] = {}
        interpreted_ids: set[str] = set()
        if options.ai_interpretation == "off":
            ai_stage["reason"] = "AI interpretation was turned off for this run."
        elif not candidates:
            ai_stage["reason"] = "No retrieved provisions to interpret."
        elif not components:
            ai_stage["reason"] = "The revision has no design components to compare."
        else:
            try:
                ctx = ai_review.prepare_context(session, revision_id)
            except Exception as exc:  # noqa: BLE001 - AI not configured: continue without interpretation
                ai_stage["reason"] = f"AI is not available: {str(exc)[:300]}"
                ctx = None
            if ctx is not None:
                ai_stage["status"] = "completed"
                for candidate in candidates[: options.max_ai_provisions]:
                    requirement = candidate["requirement"]
                    try:
                        interpreted = ai_review.interpret(session, ctx, requirement)
                    except Exception as exc:  # noqa: BLE001 - one failed interpretation must not stop the run
                        message = f"{requirement.document_code} {requirement.clause_reference}: {str(exc)[:300]}"
                        ai_stage["errors"].append(message)
                        ai_notes[str(requirement.id)] = f"AI interpretation failed: {str(exc)[:300]}"
                        continue
                    outcomes.append(_ai_outcome(candidate, interpreted, vessel))
                    interpreted_ids.add(str(requirement.id))
                ai_stage["interpreted"] = len(interpreted_ids)
                if ai_stage["errors"] and not interpreted_ids:
                    ai_stage["status"] = "failed"
        stages["ai_interpretation"] = ai_stage
        for candidate in candidates:
            if str(candidate["requirement"].id) not in interpreted_ids:
                outcomes.append(_retrieval_outcome(candidate, vessel, ai_notes.get(str(candidate["requirement"].id))))

        valid_components = {c.id for c in components}
        previous = session.scalars(
            select(Assessment).where(Assessment.revision_id == revision_id, Assessment.id != assessment.id,
                                     Assessment.status.in_(["provisional", "completed"]))
            .order_by(Assessment.created_at.desc())
        ).first()
        previous_by_key: dict[str, Finding] = {}
        if previous is not None:
            for finding in previous.findings:
                key = (finding.evidence or {}).get("workflow", {}).get("key")
                if key:
                    previous_by_key[key] = finding
        run = {"version": WORKFLOW_VERSION, "scoring_version": SCORING_VERSION, "trigger": options.trigger,
               "options": options.key(), "design_fingerprint": fingerprint, "stages": stages,
               "previous_assessment_id": str(previous.id) if previous else None,
               "started_at": datetime.now(timezone.utc).isoformat()}
        unique: dict[str, dict[str, Any]] = {}
        for outcome in outcomes:
            unique.setdefault(_key(outcome), outcome)
        run["removed_vs_previous"] = sorted(set(previous_by_key) - set(unique))
        for key, outcome in unique.items():
            requirement = outcome["requirement"]
            calculation_results = {**outcome["calculation_results"], "scores": score_finding(outcome["scoring"])}
            prior = previous_by_key.get(key)
            if prior is None:
                change, prior_info = "new", None
            else:
                same = _signature(prior.finding_type, prior.calculation_results) == _signature(outcome["finding_type"], calculation_results)
                change = "unchanged" if same else "changed"
                prior_info = {"finding_id": str(prior.id), "finding_type": prior.finding_type, "status": prior.status,
                              "reviewed_by": prior.reviewed_by, "review_notes": prior.review_notes}
            finding = Finding(
                assessment_id=assessment.id, revision_id=revision_id, requirement_id=requirement.id,
                requirement_snapshot=_requirement_snapshot(requirement), verification_method=outcome["verification_method"][:100],
                finding_type=outcome["finding_type"], status="open", description=outcome["description"],
                evidence={**outcome["evidence"], "workflow": {"key": key, "change": change, "previous_finding": prior_info, "run": run}},
                calculation_results=calculation_results, assumptions=outcome["assumptions"],
                suggested_action=outcome["suggested_action"],
            )
            session.add(finding)
            session.flush()
            session.add_all(FindingComponent(finding_id=finding.id, component_id=cid, revision_id=revision_id)
                            for cid in sorted(outcome["component_ids"] & valid_components, key=str))
        for older in list(session.scalars(select(Assessment).where(
                Assessment.revision_id == revision_id, Assessment.id != assessment.id, Assessment.status == "provisional"))):
            older.status = "superseded"
        assessment.status = "provisional"
        session.commit()
    except Exception as exc:  # noqa: BLE001 - record the failure on the run so it can be retried
        logger.exception("Assessment run %s failed", assessment_id)
        session.rollback()
        failed = session.get(Assessment, assessment_id)
        if failed is not None:
            failed.status = "failed"
            session.commit()
        return {"assessment_id": str(assessment_id), "status": "failed", "error": str(exc)[:500], "stages": stages}
    session.refresh(assessment)
    return run_summary(assessment)


def run_in_background(session_factory: Callable[[], Session], assessment_id: uuid.UUID, options: RunOptions) -> None:
    """Background-task entry point: its own session, never raises."""
    try:
        with session_factory() as session:
            execute_run(session, assessment_id, options)
    except Exception:  # noqa: BLE001
        logger.exception("Background assessment run %s could not start", assessment_id)


def prepare_retry(session: Session, assessment_id: uuid.UUID) -> Assessment:
    assessment = get_run(session, assessment_id)
    if assessment.status not in {"failed"} and not _is_stale(assessment):
        raise ConflictError(f"Only failed or stale runs can be retried; this run is {assessment.status}.")
    for finding in list(assessment.findings):
        session.delete(finding)
    assessment.status = "queued"
    session.commit()
    session.refresh(assessment)
    return assessment


def finalize_run(session: Session, assessment_id: uuid.UUID) -> dict[str, Any]:
    """Complete a provisional run when the design data is unchanged since it ran; the revision becomes immutable."""
    assessment = get_run(session, assessment_id)
    if assessment.status != "provisional":
        raise ConflictError(f"Only the current provisional run can be finalized; this run is {assessment.status}.")
    run = _run_record(assessment)
    if not run:
        raise ConflictError("This run has no findings to finalize.")
    if run.get("design_fingerprint") != design_fingerprint(session, assessment.revision_id):
        raise ConflictError("The design data changed after this run. Run the assessment again before finalizing.")
    assessment.status = "completed"
    assessment.completed_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(assessment)
    return run_summary(assessment)
