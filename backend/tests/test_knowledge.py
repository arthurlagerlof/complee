import uuid

from sqlalchemy import text

from app.ai.schemas import ExtractionResult  # noqa: F401 - imported so the schema module loads like in the app
from app.core.config import settings
from app.db.database import get_db
from app.main import app
from app.services import ai, knowledge
from tests.test_ai_api import _create_revision


def _session():
    return next(app.dependency_overrides[get_db]())


def _add_solas_definition(session, clause_key: str, body: str) -> None:
    instrument = session.execute(text("SELECT id FROM public.instruments WHERE code = 'SOLAS'")).scalar()
    if instrument is None:
        instrument = uuid.uuid4().hex
        session.execute(
            text("INSERT INTO public.instruments (id, code, name, authority, availability, applies_to) VALUES (:id, 'SOLAS', 'SOLAS', 'IMO', 'summary', '[]')"),
            {"id": instrument},
        )
    session.execute(
        text("INSERT INTO public.provisions (id, instrument_id, clause_key, heading_path, body, availability) VALUES (:id, :inst, :clause, 'Definitions', :body, 'summary')"),
        {"id": uuid.uuid4().hex, "inst": instrument, "clause": clause_key, "body": body},
    )
    session.commit()


def test_catalogue_is_consistent_and_holds_no_limit_values():
    c = knowledge.catalogue()
    assert c.version == "ship-engineering-knowledge.v1"
    assert len(c.component_types) >= 20
    for t in c.component_types:
        assert any(p.required for p in t.properties), t.id
        assert t.relationships, t.id
        # Expected properties describe what to look for; limits belong to rules and the regulation database.
        assert not any(key in p.model_dump() for p in t.properties for key in ("limit", "min", "max", "value"))
    ambiguous = {a.abbr for a in c.abbreviations if a.ambiguous}
    assert {"BW", "DB", "FD", "MCR", "P"} <= ambiguous


def test_component_matching_abbreviations_and_tags():
    first = knowledge.match_component_types("FO SERVICE TK 3 (P)")[0]
    assert first["id"] == "fuel_tank" and "FO + TK" in first["matched"]
    assert [m["id"] for m in knowledge.match_component_types("corridor deck 2 escape route")] == ["corridor"]
    assert knowledge.match_component_types("STEELQUICK ACTING WATERTIGHT HATCH - FLUSH")[0]["id"] == "hatch"
    assert knowledge.match_component_types("no ship words here") == []
    found = {a["abbr"]: a for a in knowledge.find_abbreviations("BW TK 2 (S) next to ER")}
    assert found["BW"]["ambiguous"] and found["BW"]["meanings"] == ["ballast water", "black water (sewage)"]
    assert found["S"]["meanings"] == ["starboard side"] and "ER" in found
    assert knowledge.parse_tag("FO-P-001")["parts"] == {"system": "FO", "equipment": "P", "number": "001"}
    assert knowledge.parse_tag("FO SERVICE TK 3 (P)")["parts"] == {"name": "FO SERVICE TK", "number": "3", "side": "P"}
    assert knowledge.parse_tag("random words") is None


def test_unit_conversion_is_exact_or_refused():
    assert knowledge.convert(32, "in") == {"value": 812.8, "unit": "mm", "quantity": "length"}
    assert knowledge.convert(7, "bar") == {"value": 700, "unit": "kPa", "quantity": "pressure"}
    assert knowledge.convert(140, "°F") == {"value": 60.0, "unit": "degC", "quantity": "temperature"}
    assert knowledge.convert(250, "l") == {"value": 0.25, "unit": "m3", "quantity": "volume"}
    assert knowledge.convert(1, "furlong") is None


def test_context_cites_official_definitions_from_the_regulation_database(api_client):
    session = _session()
    body = "Control stations are those spaces in which the ship's radio or main navigating equipment is located."
    _add_solas_definition(session, "II-2/3/18", body)
    context = knowledge.context_for_source("Main switchboard MSB in the ECR", session)
    assert context.startswith("ENGINEERING REFERENCE CONTEXT")
    assert "Switchboard / electrical panel (type id switchboard" in context
    assert f"SOLAS II-2/3/18: {body}" in context
    assert "Official definitions" not in knowledge.context_for_source("Main switchboard MSB", None)
    assert knowledge.context_for_source("FO SERVICE TK 3 (P) " * 50, None, max_chars=500).endswith("[truncated]")


def test_knowledge_api(api_client):
    assert api_client.get("/api/v1/knowledge/catalogue").json()["units"]["pressure"] == "kPa"
    types = api_client.get("/api/v1/knowledge/component-types?category=spaces").json()
    assert {t["id"] for t in types} == {"corridor", "space"}
    tank = api_client.get("/api/v1/knowledge/component-types/fuel_tank").json()
    assert tank["parent"] == "tank" and "capacity" in [p["name"] for p in tank["properties"]]
    assert api_client.get("/api/v1/knowledge/component-types/nope").status_code == 404
    assert any(a["abbr"] == "MCR" for a in api_client.get("/api/v1/knowledge/abbreviations").json())
    hints = api_client.post("/api/v1/knowledge/interpret", json={"text": "FO SERVICE TK 3 (P)", "include_context": True}).json()
    assert hints["component_types"][0]["id"] == "fuel_tank"
    assert hints["tag"]["convention"] == "name_number_side"
    assert "ENGINEERING REFERENCE CONTEXT" in hints["context"]
    assert api_client.post("/api/v1/knowledge/convert", json={"value": 3, "unit": "ft"}).json()["value"] == 914.4
    assert api_client.post("/api/v1/knowledge/convert", json={"value": 3, "unit": "cubit"}).status_code == 422
    terms = api_client.get("/api/v1/knowledge/terms").json()
    assert next(t for t in terms if t["term"] == "control station")["definition_text"] is None

    _add_solas_definition(_session(), "II-2/13/3.3.4", "No dead-end corridors having a length of more than 7 m shall be accepted.")
    regs = api_client.get("/api/v1/knowledge/component-types/corridor/regulations").json()
    assert [p["clause"] for p in regs["linked_clauses"]] == ["II-2/13/3.3.4"]
    assert "does not decide applicability" in regs["note"]


def test_extraction_prompt_carries_the_engineering_context(api_client, monkeypatch):
    revision = _create_revision(api_client)
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "gemini_model", "gemini-test")
    seen = {}

    def fake_generate(session, request, _schema, **versions):
        from app.db.models import AIExecution

        seen["prompt"], seen["versions"] = request.prompt, versions
        execution_id = uuid.uuid4()
        session.add(AIExecution(id=execution_id, provider_id=request.provider_id, model_id=request.model_id,
                                task_name="text_component_extraction", processing_status="completed",
                                execution_duration_ms=1, token_usage={}, validation_outcome="valid"))
        session.commit()
        return {"provider_id": request.provider_id, "model_id": request.model_id, "execution_id": execution_id,
                "duration_ms": 1, "token_usage": {}, "parsed": {"components": [], "relationships": [], "facts": [], "warnings": []},
                "validation_errors": []}

    monkeypatch.setattr(ai, "generate", fake_generate)
    uploaded = api_client.post(
        "/api/v1/ai/extractions/upload",
        data={"revision_id": revision["id"]},
        files=[("files", ("tanks.txt", b"FO SERVICE TK 3 (P) capacity 12.5 m3\n", "text/plain"))],
    )
    assert uploaded.status_code == 201, uploaded.text
    prompt = seen["prompt"]
    assert "ENGINEERING REFERENCE CONTEXT" in prompt and "type id fuel_tank" in prompt
    assert prompt.index("ENGINEERING REFERENCE CONTEXT") < prompt.index("SOURCE TEXT:")
    assert "every value must come from the source" in prompt
    assert seen["versions"]["prompt_template_version"] == "text-component-extraction.v2"
    assert uploaded.json()[0]["extraction"]["prompt_template_version"] == "text-component-extraction.v2"
