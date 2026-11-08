"""Two separate, explainable scores for every assessed requirement.

* Rule ambiguity (0-100): how clear the provision and its applicability are. Derived deterministically from the
  provision text (vague qualifiers, exceptions, cross-references, whether a measurable condition is stated, whether
  the stored text is only a summary) plus applicability and, when an AI interpretation exists, the alternative
  interpretations and undefined terms it reported. Every point is listed as a factor with the words that caused it.
* Estimated compliance likelihood (0-100 or not_estimable): how strongly the available evidence indicates that the
  design satisfies the requirement. It is only estimated when a deterministic comparison was actually executed on a
  design value; missing information, conflicting sources, AI interpretation without an executed comparison and
  "approved alternative" questions give not_estimable with the reason. The number is a heuristic estimate, never a
  calibrated probability: it has not been validated against engineer-reviewed historical assessments.

The two scores are never combined, and neither changes a finding's status or review state.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

SCORING_VERSION = "shipcheck-scoring.v1"
AMBIGUITY_METHOD = "rule-ambiguity.lexical-and-applicability.v2"
LIKELIHOOD_METHOD = "compliance-likelihood.heuristic.v1"

# Longest phrases first so "other approved" is counted once, not again as "approved".
_VAGUE = (
    "to the satisfaction of the administration", "as far as reasonable and practicable", "as far as practicable",
    "reasonably practicable", "where practicable", "where necessary", "if necessary", "as appropriate",
    "other approved", "approved", "equivalent", "adequate", "adequately", "suitable", "suitably", "satisfactory",
    "sufficient", "appropriate", "efficient", "effective", "readily", "normally", "special consideration",
)
# Wording that hands the decision to the flag Administration or to case-by-case judgement weighs more.
_DISCRETION = {
    "to the satisfaction of the administration", "as far as reasonable and practicable", "as far as practicable",
    "reasonably practicable", "where practicable", "special consideration",
}
_EXCEPTIONS = (
    "provided that", "in lieu of", "notwithstanding", "need not", "may be accepted", "may be permitted",
    "may be allowed", "subject to", "except", "unless", "however", "alternatively", "exempt", "exception",
)
_CROSS_REFERENCE = re.compile(
    r"\b(?:regulations?|paragraphs?|chapters?|sections?|parts?|tables?|annex|appendix|resolution)\s+(?:[IVX]+\b|\d)"
    r"|\bas defined in\b|\bin accordance with\b|\breferred to in\b|\bspecified in\b",
    re.IGNORECASE,
)
_MEASURABLE = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:mm|cm|m|km|inch(?:es)?|ft|feet|kg|t|tonnes?|kn|kN|N|%|°\s*C|bar|MPa|kPa|kW|W|h|hours?|"
    r"min(?:utes)?|s|seconds?|m2|m²|m3|m³|l|litres?|degrees?)\b|\b\d+\s*:\s*\d+\b",
    re.IGNORECASE,
)


AI_FACTOR_CAP = 20
_AI_FACTORS = {"exception_reported_by_ai", "applicability_question", "alternative_interpretation", "undefined_term"}


def _band(score: int) -> str:
    if score <= 20:
        return "clear"
    if score <= 40:
        return "mostly_clear"
    if score <= 60:
        return "some_ambiguity"
    if score <= 80:
        return "significant_interpretation"
    return "highly_ambiguous"


def _excerpt(text: str, start: int, end: int, width: int = 70) -> str:
    left, right = max(0, start - width), min(len(text), end + width)
    return ("…" if left else "") + " ".join(text[left:right].split()) + ("…" if right < len(text) else "")


def _find_phrases(text: str, phrases: tuple[str, ...]) -> list[tuple[str, str]]:
    """Distinct phrases found in the text (whole words, case-insensitive), with an excerpt; longer phrases win."""
    lowered = text.lower()
    taken: list[tuple[int, int]] = []
    found: list[tuple[str, str]] = []
    for phrase in sorted(phrases, key=len, reverse=True):
        for match in re.finditer(rf"\b{re.escape(phrase)}\b", lowered):
            span = match.span()
            if any(span[0] < e and s < span[1] for s, e in taken):
                continue
            taken.append(span)
            if phrase not in {p for p, _ in found}:
                found.append((phrase, _excerpt(text, *span)))
    return found


@dataclass
class ScoringContext:
    """What the scorer needs to know about one finding. Built by the assessment workflow."""

    provision_text: str
    source_availability: str | None = None  # "summary" or "full" (publication coverage in the regulation DB)
    edition: str | None = None
    method: str = "retrieval_only"  # deterministic | ai_assisted | retrieval_only
    structured_condition: bool = False  # a min/max/in_set condition is defined (structured check or verified AI quote)
    applicability_confirmed: bool | None = None  # None: not assessed
    scope_assumption: str | None = None
    applicability_questions: list[str] = field(default_factory=list)
    alternative_interpretations: list[str] = field(default_factory=list)
    undefined_terms: list[str] = field(default_factory=list)
    exceptions_reported: list[str] = field(default_factory=list)
    finding_type: str = "needs_engineering_review"
    comparison: dict[str, Any] | None = None  # requirement_comparison result (satisfied, margin, required, comparison)
    input_values: list[dict[str, Any]] = field(default_factory=list)  # property_values entries used
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    missing_information: list[str] = field(default_factory=list)
    threshold_from_ai: bool = False


def rule_ambiguity(ctx: ScoringContext) -> dict[str, Any]:
    text = ctx.provision_text or ""
    factors: list[dict[str, Any]] = [{"factor": "baseline", "points": 5,
                                      "detail": "Any automated reading of a provision leaves some residual interpretation."}]

    def add(name: str, points: int, detail: str, quote: str | None = None) -> None:
        if points:
            factors.append({"factor": name, "points": points, "detail": detail, **({"quote": quote} if quote else {})})

    if not text.strip():
        add("no_provision_text", 60, "The provision text is not available, so the requirement cannot be read.")
    vague = _find_phrases(text, _VAGUE)
    for i, (phrase, quote) in enumerate(vague):
        points = (12 if phrase in _DISCRETION else 7) if i < 4 else 0
        add("vague_qualifier", points, f"Qualifier “{phrase}” leaves the threshold to judgement or approval.", quote)
    exceptions = _find_phrases(text, _EXCEPTIONS)
    for i, (phrase, quote) in enumerate(exceptions):
        add("exception_or_qualification", 5 if i < 3 else 0, f"“{phrase}” introduces an exception or qualification.", quote)
    extra_reported = [e for e in ctx.exceptions_reported if e][: max(0, 3 - len(exceptions))]
    for item in extra_reported:
        add("exception_reported_by_ai", 4, f"Exception reported by the AI interpretation: {item}")
    # Upper-case matches ("CHAPTER 4") are headings of the stored text, not references.
    refs = list(dict.fromkeys(m.group(0) for m in _CROSS_REFERENCE.finditer(text) if not m.group(0).isupper()))
    for i, ref in enumerate(refs[:3]):
        add("cross_reference", 4, f"Depends on another provision or definition (“{ref}”).")
    if text.strip() and not ctx.structured_condition and not _MEASURABLE.search(text):
        add("no_measurable_condition", 20, "The provision states no measurable value, ratio or listed set to verify against.")
    if (ctx.source_availability or "").lower() == "summary":
        add("summary_text_only", 15, "The stored text is a publication summary, not the official wording of the provision.")
    if not ctx.edition:
        add("edition_unknown", 5, "The edition of the provision is not recorded.")
    if ctx.applicability_confirmed is False:
        add("applicability_not_confirmed", 10, "Applicability to this vessel or space is not confirmed.")
    elif ctx.applicability_confirmed is None:
        add("applicability_not_assessed", 8, "Applicability to this vessel has not been assessed (retrieval similarity does not establish it).")
    elif ctx.scope_assumption:
        add("scope_assumption", 5, f"Scope assumption to confirm: {ctx.scope_assumption}")
    for question in ctx.applicability_questions[:3]:
        add("applicability_question", 4, f"Open applicability question: {question}")
    for item in ctx.alternative_interpretations[:2]:
        add("alternative_interpretation", 10, f"Another plausible interpretation: {item}")
    for term in ctx.undefined_terms[:2]:
        add("undefined_term", 5, f"Term without a definition in the retrieved text: {term}")

    # Uncertainty reported by the AI (questions, readings, undefined terms) is heuristic and tends to be verbose:
    # together it adds at most AI_FACTOR_CAP points; the rest stay listed with 0 points.
    budget = AI_FACTOR_CAP
    for factor in factors:
        if factor["factor"] in _AI_FACTORS:
            counted = min(factor["points"], budget)
            if counted < factor["points"]:
                factor["detail"] += f" (not counted: AI-reported factors are capped at {AI_FACTOR_CAP} points)"
            factor["points"], budget = counted, budget - counted
    score = max(0, min(100, sum(f["points"] for f in factors)))
    top = sorted((f for f in factors if f["factor"] != "baseline"), key=lambda f: -f["points"])[:3]
    explanation = (
        "Clear requirement with objective verification." if not top else
        "Main contributors: " + "; ".join(f["detail"] for f in top)
    )
    return {"score": score, "scale": "0-100", "band": _band(score), "explanation": explanation,
            "factors": factors, "method": AMBIGUITY_METHOD}


def _toward_midpoint(score: float, amount: float) -> float:
    return max(score - amount, 50.0) if score > 50 else min(score + amount, 50.0)


def _not_estimable(reason: str, needed: list[str] | None = None) -> dict[str, Any]:
    return {"score": None, "scale": "0-100", "label": "not_estimable", "calibration": "not_calibrated",
            "estimate_type": "heuristic", "explanation": reason, "information_needed": needed or [],
            "factors": [], "method": LIKELIHOOD_METHOD}


def compliance_likelihood(ctx: ScoringContext, ambiguity_score: int) -> dict[str, Any]:
    if ctx.missing_information:
        return _not_estimable("Critical design information is missing, so the requirement cannot be evaluated.",
                              list(ctx.missing_information))
    if ctx.conflicts:
        written = [", ".join(c.get("as_written", [])) for c in ctx.conflicts]
        return _not_estimable(f"The sources disagree ({' vs '.join(written)}); one value must be confirmed first.",
                              ["One confirmed value for the conflicting property"])
    satisfied = (ctx.comparison or {}).get("satisfied")
    if ctx.comparison is None or satisfied is None:
        reason = {
            "ai_assisted": "No comparison was executed: an AI interpretation alone is not evidence of compliance.",
            "retrieval_only": "The provision was retrieved as possibly relevant; no comparison with design data was run.",
        }.get(ctx.method, "No comparison with design data was executed.")
        return _not_estimable(reason, ["A structured requirement or verified threshold and the matching design value"])
    if satisfied is False and (ctx.comparison or {}).get("comparison") == "in_set":
        return _not_estimable("The design value is not in the listed set, but the provision allows approved alternatives; "
                              "the outcome depends on that approval.", ["Approval status of the alternative material or type"])

    score = 90.0 if satisfied else 10.0
    factors = [{"factor": "executed_comparison", "effect": round(score),
                "detail": f"Deterministic comparison executed: requirement {'satisfied' if satisfied else 'not satisfied'} by the design value."}]

    def adjust(name: str, amount: float, detail: str) -> None:
        nonlocal score
        before = score
        score = _toward_midpoint(score, amount)
        if score != before:
            factors.append({"factor": name, "effect": round(score - before), "detail": detail})

    unverified = [v for v in ctx.input_values if v.get("review_status") != "approved"]
    if unverified or not ctx.input_values:
        adjust("input_not_verified", 20, "The design value is not engineer-approved.")
    elif any((v.get("source") or {}).get("extraction_id") for v in ctx.input_values):
        adjust("input_ai_extracted", 5, "The design value was extracted by AI (engineer-approved at import).")
    if ctx.applicability_confirmed is False:
        adjust("applicability_not_confirmed", 15, "Applicability to this vessel is not confirmed.")
    if ctx.threshold_from_ai:
        adjust("threshold_identified_by_ai", 10, "The threshold was identified by AI (its quote was verified verbatim in the provision).")
    if ambiguity_score > 40:
        adjust("rule_ambiguity", (ambiguity_score - 40) / 2, f"Rule ambiguity {ambiguity_score}/100 lowers certainty in either direction.")
    margin, required = (ctx.comparison or {}).get("margin"), (ctx.comparison or {}).get("required")
    if isinstance(margin, (int, float)) and isinstance(required, (int, float)) and required:
        if abs(margin) <= 0.02 * abs(required):
            adjust("near_limit", 10, "The design value is within 2 % of the limit.")
    if len(ctx.input_values) >= 2 and not ctx.conflicts:
        before = score
        score = min(95.0, score + 3) if score > 50 else max(5.0, score - 3)
        factors.append({"factor": "corroborated", "effect": round(score - before), "detail": "Two or more sources agree on the value."})

    final = int(round(max(5.0, min(95.0, score))))
    label = "likely_satisfied" if final >= 70 else "likely_not_satisfied" if final <= 30 else "uncertain"
    reasons = "; ".join(f["detail"].rstrip(".") for f in factors[1:]) or "no reducing factors"
    return {"score": final, "scale": "0-100", "label": label, "calibration": "not_calibrated", "estimate_type": "heuristic",
            "explanation": f"Estimated compliance likelihood (heuristic, not a calibrated probability). {factors[0]['detail']} "
                           f"Adjustments: {reasons}.",
            "information_needed": [], "factors": factors, "method": LIKELIHOOD_METHOD}


def score_finding(ctx: ScoringContext) -> dict[str, Any]:
    ambiguity = rule_ambiguity(ctx)
    return {"version": SCORING_VERSION, "rule_ambiguity": ambiguity,
            "compliance_likelihood": compliance_likelihood(ctx, ambiguity["score"])}
