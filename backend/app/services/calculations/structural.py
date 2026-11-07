from typing import Any

from app.services.calculations.registry import VerificationResult


class StructuralCalculationTool:
    name = "structural"

    def execute(self, inputs: dict[str, Any]) -> VerificationResult:
        missing = [field for field in ("loads", "material", "supporting_evidence") if field not in inputs]
        missing.append("validated structural calculation implementation")
        return VerificationResult(
            status="needs_information",
            missing_information=missing,
            explanation=(
                "Structural calculations are not implemented. No stress, strength, or safety result was inferred."
            ),
        )
