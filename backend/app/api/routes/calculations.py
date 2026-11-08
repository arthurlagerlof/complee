from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.calculations import modules
from app.services.calculations.registry import GeometryInput, registry


router = APIRouter()


class CalculationRequest(BaseModel):
    inputs: dict[str, Any] = Field(default_factory=dict)


@router.get("/calculations/tools", response_model=list[str])
def list_calculation_tools():
    return list(registry.names())


@router.get("/calculations/modules")
def list_calculation_modules():
    """Named comparison modules (inputs, units, method, limitations, version) used by the assessment workflow."""
    return modules.describe()


@router.post("/calculations/modules/{module_name}")
def run_calculation_module(module_name: str, payload: CalculationRequest):
    try:
        return modules.execute(module_name, payload.inputs)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/calculations/{tool_name}")
def calculate(tool_name: str, payload: CalculationRequest):
    inputs = payload.inputs
    if tool_name == "geometry":
        inputs = GeometryInput.model_validate(inputs).model_dump(exclude_none=True)
    try:
        return registry.execute(tool_name, inputs)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
