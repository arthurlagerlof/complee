from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field


VerificationStatus = Literal[
    "calculated", "evidence_found", "missing_information", "needs_information", "needs_review"
]


class VerificationResult(BaseModel):
    status: VerificationStatus
    result: dict[str, Any] = Field(default_factory=dict)
    missing_information: list[str] = Field(default_factory=list)
    explanation: str


class VerificationTool(Protocol):
    name: str

    def execute(self, inputs: dict[str, Any]) -> VerificationResult: ...


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, VerificationTool] = {}

    def register(self, tool: VerificationTool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Verification tool {tool.name!r} is already registered.")
        self._tools[tool.name] = tool

    def get(self, name: str) -> VerificationTool:
        try:
            return self._tools[name]
        except KeyError as exc:
            raise KeyError(f"Unknown verification tool: {name}") from exc

    def execute(self, name: str, inputs: dict[str, Any]) -> VerificationResult:
        return self.get(name).execute(inputs)

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._tools))


class GeometryInput(BaseModel):
    operation: Literal["distance", "bounding_box_distance", "area", "volume", "clearance"]
    first: dict[str, Any] | None = None
    second: dict[str, Any] | None = None


def build_registry() -> ToolRegistry:
    from app.services.calculations.comparison import RequirementComparisonTool
    from app.services.calculations.documents import DocumentEvidenceTool
    from app.services.calculations.fluid import FluidCalculationTool
    from app.services.calculations.geometry import GeometryCalculationTool
    from app.services.calculations.structural import StructuralCalculationTool

    registry = ToolRegistry()
    for tool in (
        GeometryCalculationTool(),
        DocumentEvidenceTool(),
        FluidCalculationTool(),
        StructuralCalculationTool(),
        RequirementComparisonTool(),
    ):
        registry.register(tool)
    return registry


registry = build_registry()
