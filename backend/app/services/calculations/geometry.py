import math
from typing import Any

from app.services.calculations.registry import VerificationResult


class GeometryCalculationTool:
    name = "geometry"

    def execute(self, inputs: dict[str, Any]) -> VerificationResult:
        operation = inputs.get("operation")
        if operation in {"distance", "bounding_box_distance", "clearance"}:
            return self._distance(inputs, operation)
        if operation in {"area", "volume"}:
            return self._measure(inputs, operation)
        if operation in {"intersection", "containment"}:
            return self._box_relation(inputs, operation)
        raise ValueError(
            "Geometry operation must be distance, bounding_box_distance, clearance, area, volume, intersection, or containment."
        )

    def _box_relation(self, inputs: dict[str, Any], operation: str) -> VerificationResult:
        """Axis-aligned bounding-box overlap (intersection) or whether `second` lies inside `first` (containment).
        Boxes are compared as given (world-space AABBs); exact mesh surfaces are not evaluated."""
        first = inputs.get("first")
        second = inputs.get("second")
        if first is None or second is None:
            return VerificationResult(
                status="needs_information",
                missing_information=["first", "second"],
                explanation="Two bounding boxes are required; no geometry was inferred.",
            )
        first_min, first_max, first_unit = self._box(first, "first")
        second_min, second_max, second_unit = self._box(second, "second")
        if len(first_min) != len(second_min):
            raise ValueError("Bounding boxes must use the same coordinate dimension.")
        if first_unit != second_unit:
            raise ValueError("Both bounding boxes must use the same coordinate unit.")
        tolerance = float(inputs.get("tolerance", 0.0))
        if not math.isfinite(tolerance) or tolerance < 0:
            raise ValueError("tolerance must be a finite non-negative value.")
        if operation == "intersection":
            overlaps = [min(first_max[i], second_max[i]) - max(first_min[i], second_min[i]) for i in range(len(first_min))]
            intersects = all(value > tolerance for value in overlaps)
            touching = not intersects and all(value >= -tolerance for value in overlaps)
            overlap_size = math.prod(max(value, 0.0) for value in overlaps)
            return VerificationResult(
                status="calculated",
                result={
                    "intersects": intersects,
                    "touching": touching,
                    "overlap_per_axis": overlaps,
                    "overlap_size": overlap_size,
                    "unit": f"{first_unit}^{len(first_min)}",
                },
                explanation=(
                    "Axis-aligned bounding boxes overlap." if intersects else
                    "Axis-aligned bounding boxes touch within the tolerance." if touching else
                    "Axis-aligned bounding boxes are separate."
                ) + " Bounding boxes only; the actual surfaces may not touch even when the boxes overlap.",
            )
        margins = [
            min(second_min[i] - first_min[i], first_max[i] - second_max[i]) for i in range(len(first_min))
        ]
        contained = all(value >= -tolerance for value in margins)
        return VerificationResult(
            status="calculated",
            result={"contained": contained, "margin_per_axis": margins, "unit": first_unit},
            explanation=(
                "The second bounding box lies inside the first." if contained else
                "The second bounding box extends outside the first."
            ) + " Axis-aligned bounding boxes only.",
        )

    @staticmethod
    def _point(point: Any, label: str) -> tuple[list[float], str]:
        if not isinstance(point, dict) or "coordinates" not in point or "unit" not in point:
            raise ValueError(f"{label} must include coordinates and an explicit unit.")
        values = point["coordinates"]
        if not isinstance(values, list) or len(values) not in (2, 3):
            raise ValueError(f"{label}.coordinates must contain two or three values.")
        coordinates = [float(value) for value in values]
        if not all(math.isfinite(value) for value in coordinates):
            raise ValueError(f"{label}.coordinates must be finite.")
        unit = point["unit"]
        if not isinstance(unit, str) or not unit.strip():
            raise ValueError(f"{label}.unit must be a non-empty unit string.")
        return coordinates, unit.strip()

    @staticmethod
    def _box(box: Any, label: str) -> tuple[list[float], list[float], str]:
        if not isinstance(box, dict) or "min" not in box or "max" not in box or "unit" not in box:
            raise ValueError(f"{label} must include min, max, and an explicit unit.")
        lower = box["min"]
        upper = box["max"]
        if not isinstance(lower, list) or not isinstance(upper, list) or len(lower) != len(upper):
            raise ValueError(f"{label} min and max must be coordinate lists of equal length.")
        if len(lower) not in (2, 3):
            raise ValueError(f"{label} must be a 2D or 3D bounding box.")
        minimum = [float(value) for value in lower]
        maximum = [float(value) for value in upper]
        if not all(math.isfinite(value) for value in minimum + maximum):
            raise ValueError(f"{label} coordinates must be finite.")
        if any(low > high for low, high in zip(minimum, maximum)):
            raise ValueError(f"{label} minimum coordinates must not exceed maximum coordinates.")
        unit = box["unit"]
        if not isinstance(unit, str) or not unit.strip():
            raise ValueError(f"{label}.unit must be a non-empty unit string.")
        return minimum, maximum, unit.strip()

    def _distance(self, inputs: dict[str, Any], operation: str) -> VerificationResult:
        first = inputs.get("first")
        second = inputs.get("second")
        if first is None or second is None:
            return VerificationResult(
                status="needs_information",
                missing_information=["first", "second"],
                explanation="Two geometry inputs are required; no measurements were inferred.",
            )
        if operation == "distance":
            first_values, first_unit = self._point(first, "first")
            second_values, second_unit = self._point(second, "second")
            if len(first_values) != len(second_values):
                raise ValueError("Points must use the same coordinate dimension.")
        else:
            first_min, first_max, first_unit = self._box(first, "first")
            second_min, second_max, second_unit = self._box(second, "second")
            if len(first_min) != len(second_min):
                raise ValueError("Bounding boxes must use the same coordinate dimension.")
            if operation == "distance":
                raise ValueError("Point distance requires coordinate inputs, not bounding boxes.")
            first_values = first_max
            second_values = second_min
            gaps = [
                max(first_min[i] - second_max[i], second_min[i] - first_max[i], 0.0)
                for i in range(len(first_min))
            ]
            if first_unit != second_unit:
                raise ValueError("Both bounding boxes must use the same coordinate unit.")
            distance = math.sqrt(sum(gap * gap for gap in gaps))
            return VerificationResult(
                status="calculated",
                result={"distance": distance, "unit": first_unit},
                explanation="Geometric separation calculated from the supplied bounding boxes only.",
            )
        if first_unit != second_unit:
            raise ValueError("Both points must use the same coordinate unit.")
        distance = math.sqrt(sum((a - b) ** 2 for a, b in zip(first_values, second_values)))
        return VerificationResult(
            status="calculated",
            result={"distance": distance, "unit": first_unit},
            explanation="Euclidean point distance calculated from the supplied coordinates only.",
        )

    def _measure(self, inputs: dict[str, Any], operation: str) -> VerificationResult:
        first = inputs.get("first")
        if first is None:
            return VerificationResult(
                status="needs_information",
                missing_information=["first.dimensions", "first.unit"],
                explanation="Explicit dimensions and units are required; no geometry was inferred.",
            )
        if not isinstance(first, dict) or "dimensions" not in first or "unit" not in first:
            raise ValueError("first must include dimensions and an explicit unit.")
        dimensions = first["dimensions"]
        expected_count = 2 if operation == "area" else 3
        if not isinstance(dimensions, list) or len(dimensions) != expected_count:
            raise ValueError(f"{operation} requires exactly {expected_count} dimensions.")
        values = [float(value) for value in dimensions]
        if not all(math.isfinite(value) and value > 0 for value in values):
            raise ValueError("Dimensions must be finite positive values.")
        unit = first["unit"]
        if not isinstance(unit, str) or not unit.strip():
            raise ValueError("first.unit must be a non-empty unit string.")
        result_value = math.prod(values)
        exponent = 2 if operation == "area" else 3
        return VerificationResult(
            status="calculated",
            result={"value": result_value, "unit": f"{unit.strip()}^{exponent}"},
            explanation=f"Rectangular {operation} calculated from supplied dimensions only.",
        )
