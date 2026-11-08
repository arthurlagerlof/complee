import uuid

from sqlalchemy import text

from app.services.assessment.checks import CHECKS
from app.services.calculations.registry import registry

PROVISION_TEXT = {
    "ADA 404.2.3": "Clear Width. Door openings shall provide a clear width of 32 inches (815 mm) minimum.",
    "ADA 403.5.1": "Clear Width. Except as provided in 403.5.2 and 403.5.3, the clear width of walking surfaces shall be 36 inches (915 mm) minimum.",
    "ADA 405.2": "Slope. Ramp runs shall have a running slope not steeper than 1:12.",
    "SOLAS II-2/13/3.3.4": "No dead-end corridors having a length of more than 7 m shall be accepted.",
}


def _seed_check_provisions(client, skip=()):
    with client.TestSession() as session:
        instruments = {}
        for check in CHECKS:
            if check.clause in skip:
                continue
            code, clause = check.clause.split(" ", 1)
            if code not in instruments:
                instruments[code] = uuid.uuid4().hex
                session.execute(text("INSERT INTO public.instruments (id, code, name, authority, availability, applies_to) "
                                     "VALUES (:id, :code, :code, 'test', 'full', '[]')"), {"id": instruments[code], "code": code})
            session.execute(text("INSERT INTO public.provisions (id, instrument_id, clause_key, heading_path, body, language, edition, availability, applicability, search_tsv) "
                                 "VALUES (:id, :inst, :clause, 'Test', :body, 'en', 'Edition 2010', 'full', '[]', '')"),
                            {"id": check.provision_id.hex, "inst": instruments[code], "clause": clause,
                             "body": PROVISION_TEXT.get(check.clause, check.source_quote)})
        session.commit()


def _revision(client, vessel_type="cargo"):
    project = client.post("/api/v1/projects", json={"name": "Checks"}).json()
    vessel = client.post("/api/v1/vessels", json={"project_id": project["id"], "name": "Test vessel", "vessel_type": vessel_type}).json()
    return client.post("/api/v1/design-revisions", json={"vessel_id": vessel["id"], "revision_name": "R1", "revision_number": 1}).json()["id"]


def _component(client, revision, ctype, name, properties=None, source="ga-drawing.dxf", confidence=0.9, review="approved"):
    response = client.post("/api/v1/components", json={
        "revision_id": revision, "component_type": ctype, "name": name, "properties": properties or {},
        "source_reference": {"source_type": "drawing", "source_name": source}, "confidence": confidence, "review_status": review})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _fact(client, revision, component, prop, value, unit, source):
    response = client.post("/api/v1/design-facts", json={
        "revision_id": revision, "component_id": component, "fact_type": f"component_property:{prop}",
        "statement": f"{prop}: {value} {unit}", "value": {"value": value, "unit": unit},
        "source_reference": {"source_type": "document", "source_name": source}, "confidence": 0.8, "review_status": "approved"})
    assert response.status_code == 201, response.text


def test_comparison_tool_is_deterministic_and_unit_aware():
    run = lambda **kw: registry.execute("requirement_comparison", kw)
    ok = run(measured=32.5, unit="in", comparison="min", required=815, required_unit="mm")
    assert ok.status == "calculated" and ok.result["satisfied"] and ok.result["margin"] == 10.5
    low = run(measured="700 mm", comparison="min", required=815, required_unit="mm")
    assert not low.result["satisfied"] and low.result["margin"] == -115
    assert run(measured="1:10", comparison="max", required="1:12", required_unit="ratio").result["satisfied"] is False
    assert run(measured="8 %", comparison="max", required="1:12", required_unit="ratio").result["satisfied"] is True
    assert run(measured=5, unit="kPa", comparison="max", required=7, required_unit="m").status == "needs_information"
    assert run(measured=None, comparison="min", required=1, required_unit="mm").status == "missing_information"
    assert run(measured="Stainless steel", comparison="in_set", required="steel", allowed=["steel"]).result["satisfied"]
    assert run(measured="GRP", comparison="in_set", required="steel", allowed=["steel"]).status == "needs_review"


def test_engineering_checks_cover_completeness_consistency_and_calculation(api_client):
    _seed_check_provisions(api_client, skip={"ADA 405.2"})
    revision = _revision(api_client, vessel_type="cargo")
    narrow = _component(api_client, revision, "door", "D-101 cabin door", {"clear_width": {"value": 700, "unit": "mm"}})
    wide = _component(api_client, revision, "Watertight door", "WTD 3", {"clear_width": {"value": 34, "unit": "in"}})
    unknown = _component(api_client, revision, "door", "D-102", {})
    corridor = _component(api_client, revision, "corridor", "Corridor deck 2", {"clear_width": {"value": 1200, "unit": "mm"}, "dead_end_length": {"value": 6.5, "unit": "m"}})
    _fact(api_client, revision, corridor, "clear_width", 1.0, "m", "spec.docx")  # the specification disagrees with the drawing
    pipe = _component(api_client, revision, "pipe", "FO supply line", {"system": {"value": "fuel oil", "unit": None}, "material": {"value": "GRP", "unit": None}}, review="unreviewed", confidence=None)
    _component(api_client, revision, "pipe", "SW cooling line", {"system": {"value": "sea water", "unit": None}, "material": {"value": "GRP", "unit": None}})

    checks = api_client.get("/api/v1/engineering-checks").json()
    assert {c["id"] for c in checks} == {c.id for c in CHECKS}
    response = api_client.post("/api/v1/engineering-checks/run", json={"revision_id": revision})
    assert response.status_code == 201, response.text
    body = response.json()
    by_component = {(f["evidence"]["check_id"], f["component_ids"][0]): f for f in body["findings"]}

    fail = by_component[("ADA-404.2.3-DOOR-CLEAR-WIDTH", narrow)]
    assert fail["finding_type"] == "potential_issue" and fail["status"] == "open"
    assert fail["calculation_results"]["result"] == {"measured": 700.0, "required": 815.0, "unit": "mm", "comparison": "min", "margin": -115.0, "satisfied": False}
    assert fail["requirement_snapshot"]["clause_key"] == "404.2.3" and fail["requirement_snapshot"]["edition"] == "Edition 2010"
    assert fail["evidence"]["values"][0]["source"] == {"source_type": "drawing", "source_name": "ga-drawing.dxf"}
    assert fail["assumptions"]["compliance_decision_made"] is False and fail["assumptions"]["confidence"] == 0.9
    assert "accessible route" in fail["assumptions"]["scope"]

    ok = by_component[("ADA-404.2.3-DOOR-CLEAR-WIDTH", wide)]  # "Watertight door" resolves to the catalogue door type
    assert ok["finding_type"] == "evidence_found" and ok["calculation_results"]["result"]["measured"] == 863.6

    missing = by_component[("ADA-404.2.3-DOOR-CLEAR-WIDTH", unknown)]
    assert missing["finding_type"] == "missing_information" and missing["evidence"]["capability"] == "completeness"
    assert missing["assumptions"]["missing_information"] == ["clear_width"]

    conflict = by_component[("ADA-403.5.1-WALKING-SURFACE-WIDTH", corridor)]
    assert conflict["evidence"]["capability"] == "consistency" and conflict["finding_type"] == "potential_issue"
    assert sorted(v for d in conflict["evidence"]["disagreement"] for v in d["as_written"]) == ["1.0 m", "1200 mm"]

    dead_end = by_component[("SOLAS-II-2-13.3.3.4-DEAD-END-CORRIDOR", corridor)]
    assert dead_end["calculation_results"]["result"]["satisfied"] is True and dead_end["calculation_results"]["result"]["measured"] == 6500
    assert dead_end["assumptions"]["applicability_to_vessel_type"] == "confirmed"

    material = by_component[("SOLAS-II-2-4.2.2.5.1-FO-PIPE-MATERIAL", pipe)]
    assert material["finding_type"] == "needs_engineering_review"
    assert material["assumptions"]["confidence"] == 0.25  # no confidence (0.5) x not engineer-approved (0.5)
    assert not any(f["evidence"]["check_id"].endswith("FO-PIPE-MATERIAL") and f["component_ids"][0] != pipe for f in body["findings"]), "sea water pipe is not an oil fuel pipe"

    assert {"check_id": "ADA-405.2-RAMP-SLOPE", "reason": "provision ADA 405.2 not found in the regulation database"} in body["skipped_checks"]
    assert body["summary"]["engineering_check:potential_issue"] == 1


def test_applicability_and_completeness_report(api_client):
    _seed_check_provisions(api_client)
    revision = _revision(api_client, vessel_type="research")
    corridor = _component(api_client, revision, "corridor", "Corridor A", {"dead_end_length": {"value": 9000, "unit": "mm"}})
    _component(api_client, revision, "Fuel Oil Service Tank", "FO SERVICE TK 3 (P)", {"capacity": {"value": 12.5, "unit": "m3"}})
    _component(api_client, revision, "widget", "Unknown thing", {})
    body = api_client.post("/api/v1/engineering-checks/run", json={"revision_id": revision, "check_ids": ["SOLAS-II-2-13.3.3.4-DEAD-END-CORRIDOR"]}).json()
    finding = body["findings"][0]
    assert finding["finding_type"] == "potential_issue" and finding["component_ids"] == [corridor]
    assert finding["assumptions"]["applicability_to_vessel_type"] == "not confirmed for vessel type 'research'"
    assert finding["assumptions"]["confidence"] == 0.63  # 0.9 x 0.7
    assert api_client.post("/api/v1/engineering-checks/run", json={"revision_id": revision, "check_ids": ["NOPE"]}).status_code == 404

    report = api_client.get(f"/api/v1/design-revisions/{revision}/completeness").json()
    tank = next(r for r in report["components"] if r["name"] == "FO SERVICE TK 3 (P)")
    assert tank["catalogue_type"] == "fuel_tank" and tank["present"] == ["capacity"]
    assert tank["missing_key_properties"] == ["tank_id", "fuel_type", "location"] and tank["complete"] is False
    assert report["unclassified_components"][0]["name"] == "Unknown thing"
    assert report["summary"]["classified"] == 2


def test_ai_review_calculates_only_verbatim_quoted_conditions_with_design_values(api_client, monkeypatch):
    from app.core.config import settings
    from app.services import ai

    _seed_check_provisions(api_client)
    revision = _revision(api_client)
    door = _component(api_client, revision, "door", "D-7", {"clear_width": {"value": 30, "unit": "in"}})
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "gemini_model", "gemini-test")
    seen = {}

    def fake_generate(session, request, _schema, **versions):
        from app.db.models import AIExecution

        seen["prompt"], seen["versions"] = request.prompt, versions
        execution_id = uuid.uuid4()
        session.add(AIExecution(id=execution_id, provider_id=request.provider_id, model_id=request.model_id, task_name="engineering_assistance",
                                processing_status="completed", execution_duration_ms=1, token_usage={}, validation_outcome="valid"))
        session.commit()
        parsed = {
            "requirement_summary": "Door openings need 815 mm clear width.", "condition_type": "numeric_limit",
            "relevant_evidence": [{"component_name": "D-7", "property": "clear_width"}],
            "missing_information": [], "applicability_questions": ["Is D-7 on an accessible route?"],
            "conditions": [
                {"component_name": "D-7", "property": "clear_width", "comparison": "min", "required_value": "815", "required_unit": "mm",
                 "required_value_quote": "Door openings shall provide a clear width of 32 inches (815 mm) minimum."},
                {"component_name": "D-7", "property": "clear_width", "comparison": "min", "required_value": "900", "required_unit": "mm",
                 "required_value_quote": "doors must be at least 900 mm wide"},
            ],
            "observations": ["Width from the GA drawing only."], "confidence": 0.8,
        }
        return {"provider_id": request.provider_id, "model_id": request.model_id, "execution_id": execution_id, "duration_ms": 1,
                "token_usage": {}, "parsed": parsed, "validation_errors": []}

    monkeypatch.setattr(ai, "generate", fake_generate)
    provision = next(c.provision_id for c in CHECKS if c.clause == "ADA 404.2.3")
    response = api_client.post("/api/v1/engineering-checks/ai-review", json={"revision_id": revision, "requirement_ids": [str(provision)]})
    assert response.status_code == 201, response.text
    finding = response.json()["findings"][0]
    assert "PROVISION (ADA 404.2.3" in seen["prompt"] and '"D-7"' in seen["prompt"] and "ENGINEERING REFERENCE CONTEXT" in seen["prompt"]
    assert seen["versions"]["prompt_template_version"] == "requirement-design-review.v2"
    assert finding["finding_type"] == "needs_engineering_review" and finding["status"] == "open" and finding["component_ids"] == [door]
    calc = finding["calculation_results"]["calculations"]
    assert len(calc) == 1 and calc[0]["result"]["measured"] == 762.0 and calc[0]["result"]["satisfied"] is False
    assert calc[0]["design_value"]["value"] == 30, "design value comes from the database, not the AI"
    assert "not verbatim" in finding["calculation_results"]["conditions_not_calculated"][0]["skipped"]
    assert finding["assumptions"]["applicability_questions"] == ["Is D-7 on an accessible route?"]
    assert finding["assumptions"]["compliance_decision_made"] is False


def test_missing_information_confidence_rests_on_the_component_record(api_client):
    _seed_check_provisions(api_client)
    revision = _revision(api_client)
    door = _component(api_client, revision, "door", "D-9", {}, confidence=0.9, review="approved")
    finding = api_client.post("/api/v1/engineering-checks/run", json={"revision_id": revision, "check_ids": ["ADA-404.2.3-DOOR-CLEAR-WIDTH"]}).json()["findings"][0]
    assert finding["component_ids"] == [door] and finding["finding_type"] == "missing_information"
    assert finding["assumptions"]["confidence"] == 0.9
