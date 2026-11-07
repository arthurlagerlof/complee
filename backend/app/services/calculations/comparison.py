"""Deterministic comparison of a design value with a structured requirement (minimum, maximum or allowed set).

Units are converted with the knowledge layer's exact factors before comparing; ratios accept 1:12, 8.33 % or
0.0833. The tool reports the arithmetic only. It does not decide applicability or compliance."""

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from app.services.knowledge import convert


class ComparisonInput(BaseModel):
    measured: Any = None
    unit: str | None = None
    comparison: Literal["min", "max", "in_set"]
    required: Any
    required_unit: str | None = None
    allowed: list[str] = Field(default_factory=list)


def to_number(value: Any, unit: str | None) -> tuple[float, str | None] | None:
    """(value in canonical unit, canonical unit) or None when the value is not numeric or the unit unknown."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        ratio = re.fullmatch(r"1\s*:\s*(\d+(?:\.\d+)?)", text)
        if ratio:
            return 1 / float(ratio.group(1)), "ratio"
        percent = re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*%", text)
        if percent:
            return float(percent.group(1)) / 100, "ratio"
        number = re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*([^\d\s].*)?", text)
        if not number:
            return None
        value, unit = float(number.group(1)), (number.group(2) or unit)
    if not isinstance(value, (int, float)):
        return None
    if unit in (None, "", "ratio"):
        return float(value), unit or None
    if unit == "%":
        return float(value) / 100, "ratio"
    converted = convert(float(value), unit)
    return (converted["value"], converted["unit"]) if converted else None


def _fmt(x: float, unit: str | None = None) -> str:
    if unit == "ratio":
        return f"1:{1 / x:.3g}" if x > 0 else f"{x:.4g}"
    number = f"{x:.4g}" if abs(x) < 1 else f"{round(x, 3):g}"
    return f"{number} {unit}" if unit else number


class RequirementComparisonTool:
    name = "requirement_comparison"

    def execute(self, inputs: dict[str, Any]):
        # Imported here: the registry module builds its tool list (including this tool) at import time.
        from app.services.calculations.registry import VerificationResult

        try:
            data = ComparisonInput.model_validate(inputs)
        except ValidationError as exc:
            return VerificationResult(status="needs_information", explanation=f"Invalid comparison input: {exc.errors()[0]['msg']}")
        if data.measured is None or data.measured == "":
            return VerificationResult(status="missing_information", missing_information=["measured value"], explanation="No design value to compare.")
        if data.comparison == "in_set":
            measured = str(data.measured).strip().lower()
            allowed = [a.lower() for a in data.allowed]
            satisfied = any(a == measured or re.search(rf"\b{re.escape(a)}\b", measured) for a in allowed)
            return VerificationResult(
                status="calculated" if satisfied else "needs_review",
                result={"measured": data.measured, "allowed": data.allowed, "satisfied": satisfied},
                explanation=(f"'{data.measured}' is in the allowed set." if satisfied
                             else f"'{data.measured}' is not in {data.allowed}; it may still be an approved alternative, engineer review needed."),
            )
        measured = to_number(data.measured, data.unit)
        required = to_number(data.required, data.required_unit)
        if measured is None or required is None:
            return VerificationResult(status="needs_information", missing_information=["comparable numeric value and unit"],
                                      explanation=f"Cannot compare {data.measured!r} {data.unit or ''} with {data.required!r} {data.required_unit or ''}.")
        if measured[1] != required[1]:
            return VerificationResult(status="needs_information", missing_information=["value in a unit of the required quantity"],
                                      explanation=f"Measured unit {measured[1]} does not match the required quantity ({required[1]}).")
        m, r = measured[0], required[0]
        unit = measured[1]
        satisfied = m >= r if data.comparison == "min" else m <= r
        margin = m - r if data.comparison == "min" else r - m
        return VerificationResult(
            status="calculated",
            result={"measured": round(m, 6), "required": round(r, 6), "unit": measured[1], "comparison": data.comparison,
                    "margin": round(margin, 6), "satisfied": satisfied},
            explanation=f"measured {_fmt(m, unit)}, required {'≥' if data.comparison == 'min' else '≤'} {_fmt(r, unit)}: "
                        f"{'satisfied' if satisfied else 'not satisfied'}"
                        + (f" (margin {_fmt(margin, unit)})." if unit != "ratio" else "."),
        )
