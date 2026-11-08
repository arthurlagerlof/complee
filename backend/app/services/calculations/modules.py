"""Named comparison and calculation modules for the assessment orchestrator.

Each module describes its inputs, accepted types, units, method, output, limitations and version, and runs on one of
the existing calculation tools (no second implementation). The orchestrator selects a module from a structured
requirement's `method`; nothing here is decided by an AI model.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from app.services.calculations.registry import VerificationResult, registry


@dataclass(frozen=True)
class CalculationModule:
    name: str
    version: str
    tool: str
    operation: str | None
    description: str
    inputs: dict[str, str]
    units: str
    method: str
    output: dict[str, str]
    limitations: tuple[str, ...]
    deterministic: bool = True


_BOX = "{min: [x, y, z], max: [x, y, z], unit}"
MODULES: tuple[CalculationModule, ...] = (
    CalculationModule(
        name="geometry.distance", version="1.0", tool="geometry", operation="distance",
        description="Straight-line distance between two points.",
        inputs={"first": "{coordinates: [x, y(, z)], unit}", "second": "{coordinates: [x, y(, z)], unit}"},
        units="Both points in the same length unit; the result uses that unit.",
        method="Euclidean distance.", output={"distance": "number", "unit": "string"},
        limitations=("Points must be supplied; nothing is inferred from names or proximity.",),
    ),
    CalculationModule(
        name="geometry.clearance", version="1.0", tool="geometry", operation="clearance",
        description="Clear gap between two axis-aligned bounding boxes (0 when they touch or overlap).",
        inputs={"first": _BOX, "second": _BOX}, units="Same length unit for both boxes.",
        method="Per-axis gap between boxes, combined as a Euclidean distance.",
        output={"distance": "number", "unit": "string"},
        limitations=("Bounding boxes only: curved or rotated geometry is approximated by its world-space box.",),
    ),
    CalculationModule(
        name="geometry.intersection", version="1.0", tool="geometry", operation="intersection",
        description="Whether two axis-aligned bounding boxes overlap, and by how much.",
        inputs={"first": _BOX, "second": _BOX, "tolerance": "number ≥ 0 (optional, same unit)"},
        units="Same length unit for both boxes; overlap size in unit^dimensions.",
        method="Per-axis overlap of world-space bounding boxes.",
        output={"intersects": "boolean", "touching": "boolean", "overlap_per_axis": "number[]", "overlap_size": "number"},
        limitations=("Overlapping boxes do not prove that the surfaces intersect.",),
    ),
    CalculationModule(
        name="geometry.containment", version="1.0", tool="geometry", operation="containment",
        description="Whether the second bounding box lies inside the first (e.g. equipment inside a space).",
        inputs={"first": f"{_BOX} (container)", "second": f"{_BOX} (contained item)", "tolerance": "number ≥ 0 (optional)"},
        units="Same length unit for both boxes.", method="Per-axis margins between the boxes.",
        output={"contained": "boolean", "margin_per_axis": "number[]"},
        limitations=("A space's bounding box can include volume outside the space for non-rectangular spaces.",),
    ),
    CalculationModule(
        name="geometry.volume", version="1.0", tool="geometry", operation="volume",
        description="Volume of a rectangular extent from three explicit dimensions.",
        inputs={"first": "{dimensions: [l, b, h], unit}"}, units="One length unit; result in unit^3.",
        method="Product of the three dimensions.", output={"value": "number", "unit": "string"},
        limitations=("Not a tank capacity: mesh volume, frames and fittings are not considered.",),
    ),
    CalculationModule(
        name="properties.numeric_comparison", version="1.0", tool="requirement_comparison", operation=None,
        description="Compare a design value with a required minimum, maximum or allowed set.",
        inputs={"measured": "number | string with unit | ratio '1:N'", "unit": "string", "comparison": "min | max | in_set",
                "required": "number | ratio", "required_unit": "string", "allowed": "string[] (in_set)"},
        units="Converted to SI through the knowledge-layer unit table before comparison; ratios as rise/run.",
        method="Unit conversion, then ≥ / ≤ / membership; margin reported.",
        output={"satisfied": "boolean", "margin": "number", "measured": "number", "required": "number"},
        limitations=("An in_set mismatch is not a failure when the provision allows approved alternatives.",),
    ),
    CalculationModule(
        name="properties.completeness", version="1.0", tool="property_presence", operation=None,
        description="Check that the properties a requirement needs exist for a component.",
        inputs={"properties": "object of property name → value", "required": "string[]"},
        units="Not applicable.", method="Presence of a non-empty value for every required property.",
        output={"present": "string[]", "missing": "string[]"},
        limitations=("Presence only: the correctness of a value is not checked.",),
    ),
    CalculationModule(
        name="evidence.document_comparison", version="1.0", tool="ai_assisted_review", operation=None,
        description="AI-assisted comparison of a provision with design evidence (relevance, conditions, missing information).",
        inputs={"provision": "regulation database provision", "design": "revision components and facts"},
        units="Not applicable.",
        method="AI gateway task engineering_assistance; any threshold it reports must be quoted verbatim from the provision "
               "and is then compared by properties.numeric_comparison.",
        output={"relevant_evidence": "list", "conditions": "list", "missing_information": "string[]"},
        limitations=("Never a compliance decision; without an executed comparison the likelihood is not estimable.",),
        deterministic=False,
    ),
)
_BY_NAME = {module.name: module for module in MODULES}


def describe() -> list[dict[str, Any]]:
    return [{**asdict(module), "limitations": list(module.limitations)} for module in MODULES]


def get(name: str) -> CalculationModule:
    try:
        return _BY_NAME[name]
    except KeyError as exc:
        raise KeyError(f"Unknown calculation module: {name}") from exc


def _completeness(inputs: dict[str, Any]) -> VerificationResult:
    properties, required = inputs.get("properties"), inputs.get("required")
    if not isinstance(properties, dict) or not isinstance(required, list):
        return VerificationResult(status="needs_information", missing_information=["properties", "required"],
                                  explanation="Provide the component properties and the list of required properties.")

    def present(name: str) -> bool:
        value = properties.get(name)
        if isinstance(value, dict):
            value = value.get("value")
        return value not in (None, "", [])

    missing = [name for name in required if not present(name)]
    return VerificationResult(
        status="missing_information" if missing else "evidence_found",
        result={"present": [name for name in required if present(name)], "missing": missing},
        missing_information=missing,
        explanation=("Missing: " + ", ".join(missing) + ".") if missing else "All required properties have a value.",
    )


def execute(name: str, inputs: dict[str, Any]) -> VerificationResult:
    module = get(name)
    if not module.deterministic:
        raise ValueError(f"{name} is AI-assisted; run it through the assessment workflow, not as a calculation.")
    if module.tool == "property_presence":
        return _completeness(inputs)
    payload = {**inputs, "operation": module.operation} if module.operation else inputs
    return registry.execute(module.tool, payload)
