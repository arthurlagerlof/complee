"""End-to-end assessment workflow: structured checks + retrieval + AI interpretation + scores, provisional runs,
supersede/change tracking, finalize, retry, and the automatic run after a candidate import."""

import uuid

from sqlalchemy import text

from app.core.config import settings
from app.services import ai
from app.services.assessment import workflow
from app.services.retrieval.service import EmbeddingProviderError, get_requirement
from tests.test_engineering_checks import _component, _fact, _revision, _seed_check_provisions

VAGUE_ID = uuid.UUID("11111111-2222-4333-8444-555555555555")
VAGUE_TEXT = ("Escape routes shall be adequately lit and arranged to the satisfaction of the Administration, "
              "except where special consideration is given in accordance with regulation 13.")
DOOR_CHECK = "engineering_check:ADA-404.2.3-DOOR-CLEAR-WIDTH"


def _seed_vague_provision(client):
    with client.TestSession() as session:
        inst = session.execute(text("SELECT id FROM public.instruments WHERE code = 'SOLAS'")).scalar()
        session.execute(text("INSERT INTO public.provisions (id, instrument_id, clause_key, heading_path, body, language, edition, "
                             "availability, applicability, search_tsv) VALUES (:id, :inst, 'II-2/13/2.1', 'Test', :body, 'en', "
                             "NULL, 'summary', '[]', '')"), {"id": VAGUE_ID.hex, "inst": inst, "body": VAGUE_TEXT})
        session.commit()


def _fake_retrieval(monkeypatch, ids, fail_hybrid=True):
    calls = []

    def fake_search(session, query, limit, filters, mode="hybrid"):
        calls.append(mode)
        if mode in ("hybrid", "vector") and fail_hybrid:
            raise EmbeddingProviderError("BGE-M3 is not installed in this test")
        return [get_requirement(session, i) for i in ids][:limit], False

    monkeypatch.setattr(workflow, "search_regulations", fake_search)
    return calls


def _run(client, revision, **options):
    response = client.post(f"/api/v1/design-revisions/{revision}/assessment-runs?wait=true", json=options)
    assert response.status_code == 202, response.text
    return response.json()


def _findings(client, assessment_id):
    response = client.get(f"/api/v1/assessments/{assessment_id}/findings")
    assert response.status_code == 200, response.text
    return response.json()


def test_document_only_run_scores_every_finding_and_stays_provisional(api_client, monkeypatch):
    _seed_check_provisions(api_client)
    _seed_vague_provision(api_client)
    calls = _fake_retrieval(monkeypatch, [VAGUE_ID])
    revision = _revision(api_client, vessel_type="cargo ship")
    door = _component(api_client, revision, "door", "Cabin door D-12", {"clear_width": {"value": 760, "unit": "mm"}}, source="spec.docx")
    _component(api_client, revision, "corridor", "Corridor C-1", {}, source="spec.docx")

    run = _run(api_client, revision, ai_interpretation="off")
    assert run["status"] == "provisional"
    assert run["stages"]["retrieval"]["mode_used"] == "full_text"
    assert "BGE-M3" in run["stages"]["retrieval"]["fallback_reason"]
    assert run["stages"]["ai_interpretation"]["status"] == "skipped"
    assert "hybrid" in calls and "full_text" in calls

    findings = _findings(api_client, run["assessment_id"])
    assert findings and all(f["rule_ambiguity"] and f["compliance_likelihood"] for f in findings)
    door_finding = next(f for f in findings if f["verification_method"] == DOOR_CHECK)
    assert door_finding["assessment_status"] == "potential_issue"
    assert door_finding["compliance_likelihood"]["label"] == "likely_not_satisfied"
    assert door_finding["compliance_likelihood"]["calibration"] == "not_calibrated"
    assert door_finding["rule_ambiguity"]["band"] in {"clear", "mostly_clear"}
    assert door_finding["calculation_results"]["comparison"]["method"] == "properties.numeric_comparison"
    assert door_finding["provision_reference"]["clause"] == "404.2.3"
    assert door_finding["component_ids"] == [door]
    assert door_finding["review_status"] == "pending"

    # Missing information (Scenario E): the corridor has no width or dead-end length.
    corridor = [f for f in findings if f["verification_method"].startswith("engineering_check:") and f["assessment_status"] == "missing_information"]
    assert corridor and all(f["compliance_likelihood"]["label"] == "not_estimable" for f in corridor)
    assert all(f["compliance_likelihood"]["information_needed"] for f in corridor)

    # Retrieved but uninterpreted provision (Scenario D): high ambiguity, not estimable, engineering review.
    vague = next(f for f in findings if f["requirement_id"] == str(VAGUE_ID))
    assert vague["verification_method"] == "retrieval_candidate"
    assert vague["assessment_status"] == "needs_engineering_review"
    assert vague["rule_ambiguity"]["score"] >= 61
    assert {"summary_text_only", "vague_qualifier", "no_measurable_condition"} <= {f["factor"] for f in vague["rule_ambiguity"]["factors"]}
    assert vague["compliance_likelihood"]["score"] is None

    # Provisional runs do not lock the revision.
    assert _component(api_client, revision, "door", "Second door", {"clear_width": {"value": 900, "unit": "mm"}})


def test_rerun_is_deduplicated_then_supersedes_and_tracks_changes_and_finalize_locks(api_client, monkeypatch):
    _seed_check_provisions(api_client)
    _fake_retrieval(monkeypatch, [])
    revision = _revision(api_client)
    door = _component(api_client, revision, "door", "Door D-1", {"clear_width": {"value": 900, "unit": "mm"}})
    first = _run(api_client, revision, ai_interpretation="off")
    again = api_client.post(f"/api/v1/design-revisions/{revision}/assessment-runs?wait=true", json={"ai_interpretation": "off"}).json()
    assert again["created"] is False and again["assessment_id"] == first["assessment_id"]

    _fact(api_client, revision, door, "clear_width", 760, "mm", "door-schedule.dxf")  # a second source disagrees
    finalize_stale = api_client.post(f"/api/v1/assessment-runs/{first['assessment_id']}/finalize")
    assert finalize_stale.status_code == 409 and "changed" in finalize_stale.json()["error"]["message"]

    second = _run(api_client, revision, ai_interpretation="off")
    assert second["assessment_id"] != first["assessment_id"]
    assert second["previous_assessment_id"] == first["assessment_id"]
    assert second["changes_vs_previous"].get("changed") == 1
    runs = api_client.get(f"/api/v1/design-revisions/{revision}/assessment-runs").json()
    assert {r["assessment_id"]: r["status"] for r in runs} == {
        first["assessment_id"]: "superseded", second["assessment_id"]: "provisional"}
    changed = next(f for f in _findings(api_client, second["assessment_id"]) if f["verification_method"] == DOOR_CHECK)
    assert changed["evidence"]["workflow"]["change"] == "changed"
    assert changed["compliance_likelihood"]["label"] == "not_estimable"  # sources disagree
    assert changed["evidence"]["workflow"]["previous_finding"]["finding_type"] == "evidence_found"

    final = api_client.post(f"/api/v1/assessment-runs/{second['assessment_id']}/finalize")
    assert final.status_code == 200 and final.json()["status"] == "completed"
    locked = api_client.post("/api/v1/components", json={"revision_id": revision, "component_type": "door", "name": "Late door"})
    assert locked.status_code == 409


def test_ai_interpretation_is_scored_and_threshold_only_trusted_when_quoted(api_client, monkeypatch):
    _seed_check_provisions(api_client)
    _seed_vague_provision(api_client)
    ramp_id = next(c.provision_id for c in __import__("app.services.assessment.checks", fromlist=["CHECKS"]).CHECKS if c.clause == "ADA 405.2")
    _fake_retrieval(monkeypatch, [VAGUE_ID, ramp_id], fail_hybrid=False)
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "gemini_model", "gemini-test")
    revision = _revision(api_client)
    _component(api_client, revision, "space", "Lobby escape route", {"lighting": {"value": "LED", "unit": None}})

    def fake_generate(session, request, schema, **versions):
        vague = "Escape routes" in request.prompt
        parsed = {
            "requirement_summary": "Escape routes must be lit." if vague else "Ramp slope limit.",
            "condition_type": "presence_or_arrangement" if vague else "numeric_limit",
            "relevant_evidence": [{"component_name": "Lobby escape route", "property": "lighting"}],
            "missing_information": ["illumination level"] if vague else [],
            "applicability_questions": ["Is the lobby part of the escape route?"] if vague else [],
            "conditions": [], "observations": [],
            "exceptions": ["special consideration under regulation 13"] if vague else [],
            "alternative_interpretations": ["'adequately lit' may mean emergency lighting only"] if vague else [],
            "undefined_terms": ["adequately lit"] if vague else [],
            "confidence": 0.6,
        }
        return {"provider_id": uuid.uuid4(), "model_id": uuid.uuid4(), "execution_id": uuid.uuid4(), "duration_ms": 5,
                "token_usage": {}, "parsed": parsed, "validation_errors": []}

    monkeypatch.setattr(ai, "generate", fake_generate)
    run = _run(api_client, revision, max_ai_provisions=1)
    assert run["stages"]["ai_interpretation"]["status"] == "completed"
    assert run["stages"]["ai_interpretation"]["interpreted"] == 1
    findings = _findings(api_client, run["assessment_id"])
    interpreted = [f for f in findings if f["verification_method"] == "ai_assisted_review"]
    assert len(interpreted) == 1
    finding = interpreted[0]
    assert finding["rule_ambiguity"]["score"] >= 61
    assert {"alternative_interpretation", "undefined_term", "applicability_question"} <= {f["factor"] for f in finding["rule_ambiguity"]["factors"]}
    assert finding["compliance_likelihood"]["label"] == "not_estimable"
    assert finding["evidence"]["requirement_interpretation"]["interpretation_source"] == "ai_gateway"
    assert finding["evidence"]["requirement_interpretation"]["approval_status"] == "pending_engineer_review"
    assert any(f["verification_method"] == "retrieval_candidate" for f in findings)  # the second provision: not interpreted


def test_failed_run_is_recorded_and_can_be_retried(api_client, monkeypatch):
    _seed_check_provisions(api_client)
    _fake_retrieval(monkeypatch, [])
    revision = _revision(api_client)
    _component(api_client, revision, "door", "Door D-1", {"clear_width": {"value": 900, "unit": "mm"}})

    def broken(*_args, **_kwargs):
        raise RuntimeError("database went away")

    monkeypatch.setattr(workflow, "design_fingerprint", broken)
    with api_client.TestSession() as session:
        assessment = workflow.Assessment(revision_id=uuid.UUID(revision), status="queued")
        session.add(assessment)
        session.commit()
        run_id = assessment.id
    failed = workflow.execute_run(api_client.TestSession(), run_id, workflow.RunOptions(ai_interpretation="off"))
    assert failed["status"] == "failed" and "database went away" in failed["error"]
    monkeypatch.undo()
    _fake_retrieval(monkeypatch, [])
    retried = api_client.post(f"/api/v1/assessment-runs/{run_id}/retry?wait=true", json={"ai_interpretation": "off"})
    assert retried.status_code == 202, retried.text
    assert retried.json()["status"] == "provisional" and retried.json()["findings"] >= 1
    assert api_client.post(f"/api/v1/assessment-runs/{run_id}/retry").status_code == 409


def test_import_of_approved_candidates_queues_an_assessment_run(api_client, monkeypatch):
    from app.db.models import AIExecution, AIExtraction, AIModelConfig, AIProvider

    _seed_check_provisions(api_client)
    _fake_retrieval(monkeypatch, [])
    revision = _revision(api_client)
    with api_client.TestSession() as session:
        provider = AIProvider(name="Test", provider_type="ollama", base_url="http://127.0.0.1:11434")
        session.add(provider)
        session.flush()
        model = AIModelConfig(provider_id=provider.id, model_name="m")
        session.add(model)
        session.flush()
        execution = AIExecution(provider_id=provider.id, model_id=model.id, task_name="text_component_extraction",
                                processing_status="completed", execution_duration_ms=1, validation_outcome="valid")
        session.add(execution)
        session.flush()
        extraction = AIExtraction(
            revision_id=uuid.UUID(revision), provider_id=provider.id, model_id=model.id, execution_id=execution.id,
            task_name="text_component_extraction", prompt_template_version="v", output_schema_version="v",
            source_reference={"source_type": "document", "source_name": "spec.docx"},
            result={"components": [{"component_type": "door", "name": "Door D-7", "properties": {
                "clear_width": {"value": 700, "unit": "mm", "evidence": [], "review_status": "approved"}},
                "evidence": [{"text": "Door D-7 clear width 700 mm"}], "confidence": 0.9, "review_status": "approved"}],
                "facts": [], "relationships": [], "warnings": []},
            execution_duration_ms=1, validation_outcome="valid")
        session.add(extraction)
        session.commit()
        extraction_id = extraction.id
    imported = api_client.post(f"/api/v1/ai/extractions/{extraction_id}/import", json={"candidate_indexes": [0]})
    assert imported.status_code == 200, imported.text
    queued = imported.json()["assessment_run"]
    assert queued["created"] is True
    run = api_client.get(f"/api/v1/assessment-runs/{queued['assessment_id']}").json()  # the background task has run
    assert run["status"] == "provisional" and run["trigger"] == "candidate_import"
    door = next(f for f in _findings(api_client, run["assessment_id"]) if f["verification_method"] == DOOR_CHECK)
    assert door["compliance_likelihood"]["label"] == "likely_not_satisfied"
    assert any(fct["factor"] == "input_ai_extracted" for fct in door["compliance_likelihood"]["factors"])
    off = api_client.post(f"/api/v1/ai/extractions/{extraction_id}/import", json={"candidate_indexes": [0], "auto_assess": False})
    assert off.status_code == 200 and off.json()["assessment_run"] is None
