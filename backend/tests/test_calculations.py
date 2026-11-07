import pytest

from app.services.calculations.documents import DocumentEvidenceTool
from app.services.calculations.geometry import GeometryCalculationTool
from app.services.calculations.registry import ToolRegistry


def test_geometry_calculates_only_explicit_same_unit_inputs():
    tool = GeometryCalculationTool()
    result = tool.execute(
        {
            "operation": "distance",
            "first": {"coordinates": [0, 0, 0], "unit": "m"},
            "second": {"coordinates": [3, 4, 0], "unit": "m"},
        }
    )
    assert result.status == "calculated"
    assert result.result == {"distance": 5.0, "unit": "m"}

    volume = tool.execute(
        {"operation": "volume", "first": {"dimensions": [2, 3, 4], "unit": "m"}}
    )
    assert volume.result == {"value": 24.0, "unit": "m^3"}


def test_geometry_requires_information_and_rejects_invalid_units_and_bounds():
    tool = GeometryCalculationTool()
    missing = tool.execute({"operation": "distance"})
    assert missing.status == "needs_information"
    assert missing.missing_information == ["first", "second"]

    with pytest.raises(ValueError, match="same coordinate unit"):
        tool.execute(
            {
                "operation": "distance",
                "first": {"coordinates": [0, 0], "unit": "m"},
                "second": {"coordinates": [1, 1], "unit": "mm"},
            }
        )

    with pytest.raises(ValueError, match="must not exceed"):
        tool.execute(
            {
                "operation": "clearance",
                "first": {"min": [2, 0], "max": [1, 3], "unit": "m"},
                "second": {"min": [0, 0], "max": [1, 1], "unit": "m"},
            }
        )


def test_document_verification_does_not_claim_technical_adequacy():
    result = DocumentEvidenceTool().execute(
        {
            "required_documents": ["Fire plan", "Calculation"],
            "available_documents": ["fire plan"],
        }
    )
    assert result.status == "missing_information"
    assert result.missing_information == ["Calculation"]

    complete = DocumentEvidenceTool().execute(
        {"required_documents": ["Fire plan"], "available_documents": ["fire plan"]}
    )
    assert complete.status == "evidence_found"
    assert "adequacy was not evaluated" in complete.explanation


def test_tool_registry_rejects_duplicate_and_unknown_tools():
    tool = GeometryCalculationTool()
    registry = ToolRegistry()
    registry.register(tool)
    with pytest.raises(ValueError, match="already registered"):
        registry.register(tool)
    with pytest.raises(KeyError, match="Unknown verification tool"):
        registry.get("unknown")
