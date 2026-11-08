import pytest

from app.services.assessment.scoring import ScoringContext, compliance_likelihood, rule_ambiguity, score_finding
from app.services.calculations import modules

CLEAR = "Door openings shall provide a clear width of 32 inches (815 mm) minimum."
VAGUE = (
    "Oil fuel pipes and their valves and fittings shall be of steel or other approved material, provided that restricted "
    "use of flexible pipes shall be permissible in positions where the Administration is satisfied that they are necessary."
)
NO_MEASURE = "Means of escape shall be provided to the satisfaction of the Administration, except as provided in regulation 13."


def approved_value(value=900, unit="mm", **extra):
    return {"value": value, "unit": unit, "review_status": "approved", "source": {"source_name": "ga.dxf"}, **extra}


def test_clear_measurable_rule_scores_low_and_lists_factors():
    result = rule_ambiguity(ScoringContext(provision_text=CLEAR, edition="2010", structured_condition=True,
                                           applicability_confirmed=True))
    assert result["score"] <= 20 and result["band"] == "clear"
    assert [f["factor"] for f in result["factors"]] == ["baseline"]


def test_vague_rule_with_exceptions_and_summary_text_scores_higher_and_quotes_the_words():
    result = rule_ambiguity(ScoringContext(provision_text=VAGUE, source_availability="summary", edition=None,
                                           structured_condition=True, applicability_confirmed=False))
    factors = {f["factor"] for f in result["factors"]}
    assert {"vague_qualifier", "exception_or_qualification", "summary_text_only", "edition_unknown",
            "applicability_not_confirmed"} <= factors
    vague = [f for f in result["factors"] if f["factor"] == "vague_qualifier"]
    assert any("other approved" in f["detail"] for f in vague)
    assert not any(f["detail"].startswith("Qualifier “approved”") for f in vague)  # counted once as "other approved"
    assert all("quote" in f for f in vague)
    assert result["score"] > 40


def test_no_measurable_condition_and_ai_alternatives_raise_ambiguity():
    plain = rule_ambiguity(ScoringContext(provision_text=NO_MEASURE, edition="2014"))
    assert any(f["factor"] == "no_measurable_condition" for f in plain["factors"])
    assert any(f["factor"] == "cross_reference" for f in plain["factors"])
    with_ai = rule_ambiguity(ScoringContext(provision_text=NO_MEASURE, edition="2014",
                                            alternative_interpretations=["applies only to accommodation"],
                                            undefined_terms=["main vertical zone"]))
    assert with_ai["score"] > plain["score"]
    assert with_ai["score"] >= 61


@pytest.mark.parametrize("ctx, needed_word", [
    (ScoringContext(provision_text=CLEAR, missing_information=["clear_width"], method="deterministic"), "clear_width"),
    (ScoringContext(provision_text=CLEAR, method="deterministic", conflicts=[{"as_written": ["900 mm"]}, {"as_written": ["760 mm"]}]),
     "confirmed value"),
    (ScoringContext(provision_text=CLEAR, method="ai_assisted"), "structured requirement"),
    (ScoringContext(provision_text=CLEAR, method="retrieval_only"), "structured requirement"),
    (ScoringContext(provision_text=VAGUE, method="deterministic", comparison={"comparison": "in_set", "satisfied": False}),
     "Approval status"),
])
def test_likelihood_is_not_estimable_without_an_executed_comparison_or_with_missing_or_conflicting_data(ctx, needed_word):
    result = compliance_likelihood(ctx, 10)
    assert result["score"] is None and result["label"] == "not_estimable"
    assert result["calibration"] == "not_calibrated"
    assert any(needed_word in item for item in result["information_needed"])


def test_verified_deterministic_pass_is_likely_but_never_certain_and_reductions_are_listed():
    strong = compliance_likelihood(ScoringContext(provision_text=CLEAR, method="deterministic", applicability_confirmed=True,
                                                  comparison={"satisfied": True, "margin": 85, "required": 815},
                                                  input_values=[approved_value(), approved_value(source={"source_name": "spec.docx"})]), 10)
    assert strong["label"] == "likely_satisfied" and 85 <= strong["score"] <= 95
    weak = compliance_likelihood(ScoringContext(provision_text=CLEAR, method="deterministic", applicability_confirmed=False,
                                                threshold_from_ai=True,
                                                comparison={"satisfied": True, "margin": 5, "required": 815},
                                                input_values=[{**approved_value(905), "review_status": "unreviewed"}]), 55)
    assert weak["score"] < strong["score"]
    assert weak["label"] == "uncertain"
    # Reductions stop at the midpoint; factors with no remaining effect are not listed.
    assert {"input_not_verified", "applicability_not_confirmed", "threshold_identified_by_ai"} <= {
        f["factor"] for f in weak["factors"]}
    assert weak["score"] == 50


def test_deterministic_failure_is_unlikely_to_comply_and_scores_stay_separate():
    scores = score_finding(ScoringContext(provision_text=CLEAR, edition="2010", method="deterministic", structured_condition=True,
                                          applicability_confirmed=True, finding_type="potential_issue",
                                          comparison={"satisfied": False, "margin": -55, "required": 815},
                                          input_values=[approved_value(760)]))
    assert scores["compliance_likelihood"]["label"] == "likely_not_satisfied"
    assert scores["compliance_likelihood"]["score"] <= 15
    assert scores["rule_ambiguity"]["score"] <= 20
    assert set(scores) == {"version", "rule_ambiguity", "compliance_likelihood"}


BOX_A = {"min": [0, 0, 0], "max": [10, 4, 3], "unit": "m"}
BOX_B = {"min": [2, 1, 0.5], "max": [4, 2, 2], "unit": "m"}
BOX_C = {"min": [12, 0, 0], "max": [14, 2, 2], "unit": "m"}


def test_geometry_modules_intersection_containment_clearance():
    assert modules.execute("geometry.intersection", {"first": BOX_A, "second": BOX_B}).result["intersects"] is True
    separate = modules.execute("geometry.intersection", {"first": BOX_A, "second": BOX_C})
    assert separate.result["intersects"] is False and separate.result["touching"] is False
    assert modules.execute("geometry.containment", {"first": BOX_A, "second": BOX_B}).result["contained"] is True
    assert modules.execute("geometry.containment", {"first": BOX_A, "second": BOX_C}).result["contained"] is False
    assert modules.execute("geometry.clearance", {"first": BOX_A, "second": BOX_C}).result["distance"] == pytest.approx(2.0)
    assert modules.execute("geometry.volume", {"first": {"dimensions": [2, 3, 4], "unit": "m"}}).result["value"] == 24
    with pytest.raises(ValueError):
        modules.execute("geometry.intersection", {"first": BOX_A, "second": {**BOX_B, "unit": "mm"}})


def test_property_modules_and_catalogue():
    complete = modules.execute("properties.completeness", {"properties": {"clear_width": {"value": 900}}, "required": ["clear_width", "fire_rating"]})
    assert complete.status == "missing_information" and complete.result["missing"] == ["fire_rating"]
    numeric = modules.execute("properties.numeric_comparison", {"measured": "0.9 m", "unit": None, "comparison": "min", "required": 815, "required_unit": "mm"})
    assert numeric.result["satisfied"] is True
    with pytest.raises(ValueError):
        modules.execute("evidence.document_comparison", {})
    names = {m["name"] for m in modules.describe()}
    assert {"geometry.distance", "geometry.clearance", "geometry.intersection", "geometry.containment", "geometry.volume",
            "properties.numeric_comparison", "properties.completeness", "evidence.document_comparison"} == names
    assert all(m["version"] and m["limitations"] for m in modules.describe())


def test_module_routes(api_client):
    listed = api_client.get("/api/v1/calculations/modules")
    assert listed.status_code == 200 and len(listed.json()) == 8
    run = api_client.post("/api/v1/calculations/modules/geometry.containment", json={"inputs": {"first": BOX_A, "second": BOX_B}})
    assert run.status_code == 200 and run.json()["result"]["contained"] is True
    assert api_client.post("/api/v1/calculations/modules/geometry.nothing", json={"inputs": {}}).status_code == 404
    old = api_client.post("/api/v1/calculations/geometry", json={"inputs": {"operation": "intersection", "first": BOX_A, "second": BOX_B, "tolerance": 0.1}})
    assert old.status_code == 200 and old.json()["result"]["intersects"] is True
