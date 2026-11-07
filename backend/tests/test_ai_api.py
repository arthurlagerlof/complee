import uuid

from cryptography.fernet import Fernet

from app.core.config import settings
from app.services import ai


def _create_revision(client):
    project = client.post("/api/v1/projects", json={"name": "AI project"}).json()
    vessel = client.post(
        "/api/v1/vessels",
        json={"project_id": project["id"], "name": "AI vessel"},
    ).json()
    return client.post(
        "/api/v1/design-revisions",
        json={"vessel_id": vessel["id"], "revision_name": "Draft", "revision_number": 1},
    ).json()


def test_provider_crud_secret_masking_discovery_and_task_configuration(api_client, monkeypatch):
    monkeypatch.setattr(settings, "ai_encryption_key", Fernet.generate_key().decode("ascii"))
    monkeypatch.setattr(settings, "ai_allowed_hosts", "ollama.example.test:11434")

    class Adapter:
        def __init__(self, _provider, _key, _timeout):
            pass

        def close(self):
            pass

        def test_connection(self):
            return {"connected": True, "model_count": 1}

        def list_models(self):
            return [{"name": "gemma4:e4b", "display_name": "Gemma 4 E4B"}]

        def generate(self, model_name, prompt, _system, _temperature, _max_tokens, _schema=None):
            return type("Response", (), {"text": f"{model_name}:{prompt}", "parsed": None,
                                         "validation_errors": [], "token_usage": {}})()

    monkeypatch.setattr(ai, "adapter_for", Adapter)
    response = api_client.post(
        "/api/v1/ai/providers",
        json={
            "name": "Remote Ollama",
            "provider_type": "ollama",
            "base_url": "https://ollama.example.test:11434",
            "api_key": "do-not-return",
        },
    )
    assert response.status_code == 201, response.text
    provider = response.json()
    assert provider["has_api_key"] is True
    assert "do-not-return" not in response.text
    assert api_client.get(f"/api/v1/ai/providers/{provider['id']}").json()["has_api_key"] is True
    assert api_client.post(f"/api/v1/ai/providers/{provider['id']}/test").json()["connected"] is True
    status = api_client.get(f"/api/v1/ai/providers/{provider['id']}").json()
    assert status["last_test_success"] is True
    assert status["last_tested_at"] is not None

    discovered = api_client.post(f"/api/v1/ai/providers/{provider['id']}/refresh-models")
    assert discovered.status_code == 200
    assert discovered.json()[0]["model_name"] == "gemma4:e4b"
    model_id = discovered.json()[0]["id"]
    task = api_client.put(
        "/api/v1/ai/task-configurations/text_component_extraction",
        json={"provider_id": provider["id"], "model_id": model_id, "generation_settings": {"temperature": 0}},
    )
    assert task.status_code == 200
    api_client.patch(f"/api/v1/ai/providers/{provider['id']}", json={"enabled": False})
    disabled = api_client.post(
        "/api/v1/ai/generate",
        json={"task_name": "text_component_extraction", "prompt": "technical text"},
    )
    assert disabled.status_code == 422
    assert "disabled" in disabled.json()["error"]["message"]
    api_client.patch(f"/api/v1/ai/providers/{provider['id']}", json={"enabled": True})
    generated = api_client.post(
        "/api/v1/ai/generate",
        json={"task_name": "text_component_extraction", "prompt": "technical text"},
    )
    assert generated.status_code == 200, generated.text
    assert generated.json()["text"] == "gemma4:e4b:technical text"
    assert generated.json()["execution_id"]
    history = api_client.get("/api/v1/ai/executions").json()
    assert history[0]["processing_status"] == "completed"
    assert history[0]["task_name"] == "text_component_extraction"
    assert "prompt" not in history[0]

    from app.ai.providers import AIProviderUnavailable

    def fail_generation(*_args, **_kwargs):
        raise AIProviderUnavailable("The AI provider request timed out.")

    monkeypatch.setattr(Adapter, "generate", fail_generation)
    failed = api_client.post(
        "/api/v1/ai/generate",
        json={"task_name": "text_component_extraction", "prompt": "technical text"},
    )
    assert failed.status_code == 502
    failed_history = api_client.get("/api/v1/ai/executions").json()
    failed_execution = next(item for item in failed_history if item["processing_status"] == "failed")
    assert failed_execution["validation_outcome"] == "error"
    with api_client.TestSession() as session:
        stored = session.get(ai.AIProvider, uuid.UUID(provider["id"]))
        assert stored.encrypted_api_key != "do-not-return"


def test_provider_url_and_configuration_reject_credentials():
    from app.ai.schemas import ProviderCreate
    from pydantic import ValidationError

    for payload in (
        {
            "name": "bad",
            "provider_type": "ollama",
            "base_url": "http://user:password@localhost:11434",
        },
        {
            "name": "bad",
            "provider_type": "ollama",
            "base_url": "http://localhost:11434",
            "configuration": {"nested": {"api_key": "secret"}},
        },
    ):
        try:
            ProviderCreate.model_validate(payload)
        except ValidationError:
            continue
        raise AssertionError("Expected invalid provider configuration.")


def test_extraction_review_and_import_is_gated_on_approval(api_client, monkeypatch):
    monkeypatch.setattr(settings, "ai_encryption_key", Fernet.generate_key().decode("ascii"))
    revision = _create_revision(api_client)
    provider = api_client.post(
        "/api/v1/ai/providers",
        json={
            "name": "Local Ollama",
            "provider_type": "ollama",
            "base_url": "http://127.0.0.1:11434",
        },
    ).json()
    model = api_client.post(
        "/api/v1/ai/models",
        json={"provider_id": provider["id"], "model_name": "gemma4:e4b"},
    ).json()
    api_client.put(
        "/api/v1/ai/task-configurations/text_component_extraction",
        json={"provider_id": provider["id"], "model_id": model["id"]},
    )
    result = {
        "components": [
            {
                "component_type": "fuel_tank",
                "name": "Fuel Tank 01",
                "tag": "TK-001",
                "properties": {"capacity": {"value": 12, "unit": "m3"}},
                "evidence": [{"text": "The tank has a nominal capacity of 12 m3.", "section": "Fuel storage"}],
                "confidence": 0.95,
                "uncertainty": [],
                "missing_information": ["design pressure"],
                "review_status": "pending",
            }
        ],
        "relationships": [],
        "warnings": [],
    }

    def fake_generate(session, _request, _schema, **_versions):
        from app.db.models import AIExecution

        execution_id = uuid.uuid4()
        session.add(
            AIExecution(
                id=execution_id,
                provider_id=uuid.UUID(provider["id"]),
                model_id=uuid.UUID(model["id"]),
                task_name="text_component_extraction",
                prompt_template_version="text-component-extraction.v1",
                output_schema_version="component-extraction.v1",
                processing_status="completed",
                execution_duration_ms=10,
                token_usage={"input_tokens": 20, "output_tokens": 40},
                validation_outcome="valid",
            )
        )
        session.commit()
        return {
            "provider_id": uuid.UUID(provider["id"]),
            "model_id": uuid.UUID(model["id"]),
            "execution_id": execution_id,
            "duration_ms": 10,
            "token_usage": {"input_tokens": 20, "output_tokens": 40},
            "parsed": result,
            "validation_errors": [],
        }

    monkeypatch.setattr(ai, "generate", fake_generate)
    extraction = api_client.post(
        "/api/v1/ai/extractions",
        json={
            "revision_id": revision["id"],
            "source_name": "tank-spec.txt",
            "source_text": "The tank has a nominal capacity of 12 m3.",
        },
    )
    assert extraction.status_code == 201, extraction.text
    assert extraction.json()["execution_id"]
    extraction_id = extraction.json()["id"]

    blocked = api_client.post(
        f"/api/v1/ai/extractions/{extraction_id}/import",
        json={"candidate_indexes": [0]},
    )
    assert blocked.status_code == 422
    reviewed = api_client.patch(
        f"/api/v1/ai/extractions/{extraction_id}/components/0",
        json={
            "name": "Fuel Tank 01 reviewed",
            "review_status": "approved",
            "properties": {
                "capacity": {
                    "value": 12,
                    "unit": "m3",
                    "review_status": "approved",
                }
            },
        },
    )
    assert reviewed.status_code == 200
    imported = api_client.post(
        f"/api/v1/ai/extractions/{extraction_id}/import",
        json={"candidate_indexes": [0]},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["imported_count"] == 1
    components = api_client.get(f"/api/v1/design-revisions/{revision['id']}/components").json()
    assert components[0]["name"] == "Fuel Tank 01 reviewed"
    facts = api_client.get(f"/api/v1/design-revisions/{revision['id']}/facts").json()
    assert facts[0]["value"] == {"value": 12, "unit": "m3"}
    repeated = api_client.post(
        f"/api/v1/ai/extractions/{extraction_id}/import",
        json={"candidate_indexes": [0]},
    )
    assert repeated.status_code == 200
    assert len(api_client.get(f"/api/v1/design-revisions/{revision['id']}/components").json()) == 1
    assert len(api_client.get(f"/api/v1/design-revisions/{revision['id']}/facts").json()) == 1

    from app.db.models import Assessment

    with api_client.TestSession() as session:
        session.add(Assessment(revision_id=uuid.UUID(revision["id"]), status="completed"))
        session.commit()
    locked = api_client.post(
        f"/api/v1/ai/extractions/{extraction_id}/import",
        json={"candidate_indexes": [0]},
    )
    assert locked.status_code == 409
    assert "immutable" in locked.json()["error"]["message"]


def test_source_upload_uses_parser_candidates_and_individual_fact_review(api_client, monkeypatch):
    revision = _create_revision(api_client)
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")
    monkeypatch.setattr(settings, "gemini_model", "gemini-test")
    candidate_result = {
        "components": [],
        "relationships": [],
        "facts": [
            {
                "fact_type": "operating_limit",
                "statement": "Maximum operating temperature is 80 C.",
                "value": {"value": 80, "unit": "C"},
                "evidence": [
                    {"text": "Maximum operating temperature is 80 C.", "source_id": "line:1"}
                ],
                "confidence": 0.9,
                "review_status": "approved",
            }
        ],
        "warnings": [],
    }

    def fake_generate(session, request, _schema, **_versions):
        from app.db.models import AIExecution

        execution_id = uuid.uuid4()
        session.add(
            AIExecution(
                id=execution_id,
                provider_id=request.provider_id,
                model_id=request.model_id,
                task_name="text_component_extraction",
                processing_status="completed",
                execution_duration_ms=15,
                token_usage={"input_tokens": 12, "output_tokens": 8},
                validation_outcome="valid",
            )
        )
        session.commit()
        return {
            "provider_id": request.provider_id,
            "model_id": request.model_id,
            "execution_id": execution_id,
            "duration_ms": 15,
            "token_usage": {"input_tokens": 12, "output_tokens": 8},
            "parsed": candidate_result,
            "validation_errors": [],
        }

    monkeypatch.setattr(ai, "generate", fake_generate)
    uploaded = api_client.post(
        "/api/v1/ai/extractions/upload",
        data={"revision_id": revision["id"]},
        files=[
            ("files", ("limits.txt", b"Maximum operating temperature is 80 C.\n", "text/plain")),
            ("files", ("unsupported.step", b"ISO-10303-21;", "application/step")),
        ],
    )
    assert uploaded.status_code == 201, uploaded.text
    result = uploaded.json()
    parsed = next(item for item in result if item["source_document"]["filename"] == "limits.txt")
    failed = next(item for item in result if item["source_document"]["filename"] == "unsupported.step")
    assert parsed["source_document"]["processing_status"] == "completed"
    assert parsed["source_document"]["provider_id"]
    assert parsed["source_document"]["model_id"]
    assert parsed["extraction"]["source_document_id"] == parsed["source_document"]["id"]
    assert parsed["extraction"]["result"]["facts"][0]["evidence"][0]["source_id"] == "line:1"
    assert parsed["extraction"]["result"]["facts"][0]["evidence"][0]["text"] == "Maximum operating temperature is 80 C."
    assert parsed["extraction"]["result"]["facts"][0]["review_status"] == "pending"
    assert failed["source_document"]["processing_status"] == "failed"
    assert "Unsupported file format" in failed["source_document"]["error_message"]

    original = api_client.get(
        f"/api/v1/ai/source-documents/{parsed['source_document']['id']}/file"
    )
    assert original.content == b"Maximum operating temperature is 80 C.\n"
    parsed_data = api_client.get(
        f"/api/v1/ai/source-documents/{parsed['source_document']['id']}/parsed-data"
    )
    assert parsed_data.json()["parsed_data"]["blocks"][0]["source_id"] == "line:1"

    extraction_id = parsed["extraction"]["id"]
    approved = api_client.patch(
        f"/api/v1/ai/extractions/{extraction_id}/facts/0",
        json={"statement": "Reviewed maximum temperature: 80 C.", "review_status": "approved"},
    )
    assert approved.status_code == 200, approved.text
    imported = api_client.post(
        f"/api/v1/ai/extractions/{extraction_id}/import",
        json={"fact_indexes": [0]},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()["imported_fact_count"] == 1
    facts = api_client.get(f"/api/v1/design-revisions/{revision['id']}/facts").json()
    assert facts[0]["statement"] == "Reviewed maximum temperature: 80 C."
    assert facts[0]["source_reference"]["source_file_id"] == parsed["source_document"]["id"]
