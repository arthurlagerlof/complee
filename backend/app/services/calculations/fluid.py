from typing import Any

from app.services.calculations.registry import VerificationResult


class FluidCalculationTool:
    name = "fluid"

    def execute(self, inputs: dict[str, Any]) -> VerificationResult:
        missing = [field for field in ("calculation_type", "inputs", "units") if field not in inputs]
        missing.append("validated fluid calculation implementation")
        return VerificationResult(
            status="needs_information",
            missing_information=missing,
            explanation=(
                "Fluid calculations are not implemented. No pressure, flow, or pipe-design result was inferred."
            ),
        )
