from typing import Any

from app.services.calculations.registry import VerificationResult


class DocumentEvidenceTool:
    name = "documents"

    def execute(self, inputs: dict[str, Any]) -> VerificationResult:
        required = inputs.get("required_documents")
        available = inputs.get("available_documents")
        if not isinstance(required, list) or not isinstance(available, list):
            return VerificationResult(
                status="missing_information",
                missing_information=["required_documents", "available_documents"],
                explanation="Provide explicit required and available document lists.",
            )
        if any(not isinstance(item, str) or not item.strip() for item in required + available):
            raise ValueError("Document names must be non-empty strings.")
        available_set = {item.casefold() for item in available}
        missing = [item for item in required if item.casefold() not in available_set]
        if missing:
            return VerificationResult(
                status="missing_information",
                result={"available_documents": available, "missing_documents": missing},
                missing_information=missing,
                explanation="One or more requested supporting documents were not listed as available.",
            )
        if not required:
            return VerificationResult(
                status="needs_review",
                result={"available_documents": available},
                explanation="No required document types were specified for checking.",
            )
        return VerificationResult(
            status="evidence_found",
            result={"available_documents": available, "matched_documents": required},
            explanation="The listed document types are present; their technical adequacy was not evaluated.",
        )
