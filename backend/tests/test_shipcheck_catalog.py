import json

from app.services.shipcheck_catalog import CatalogSource, import_catalog_sources
from app.db.models.shipcheck import (
    ShipCheckActiveDataset,
    ShipCheckDatasetRecord,
    ShipCheckDatasetVersion,
)


def test_catalog_import_is_idempotent_and_versions_are_retained(api_client, tmp_path):
    source_path = tmp_path / "scenarios.json"
    source_path.write_text(
        json.dumps({"scenarios": [{"id": "first"}], "description": "test data"}),
        encoding="utf-8",
    )
    sources = {"scenarios": CatalogSource("scenarios.json", "scenarios")}

    with api_client.TestSession.begin() as session:
        first = import_catalog_sources(session, tmp_path, sources)
        again = import_catalog_sources(session, tmp_path, sources)
        assert first == again

    response = api_client.get("/api/v1/shipcheck/catalog/scenarios")
    assert response.status_code == 200
    assert response.json() == {"description": "test data", "scenarios": [{"id": "first"}]}

    source_path.write_text(
        json.dumps({"scenarios": [{"id": "first"}, {"id": "second"}], "description": "updated"}),
        encoding="utf-8",
    )
    with api_client.TestSession.begin() as session:
        import_catalog_sources(session, tmp_path, sources)

    response = api_client.get("/api/v1/shipcheck/catalog/scenarios")
    assert response.status_code == 200
    assert response.json() == {
        "description": "updated",
        "scenarios": [{"id": "first"}, {"id": "second"}],
    }
    with api_client.TestSession() as session:
        assert session.query(ShipCheckDatasetVersion).filter_by(source_key="scenarios").count() == 2
        assert session.query(ShipCheckDatasetRecord).count() == 3
        assert session.query(ShipCheckActiveDataset).count() == 1


def test_catalog_api_reports_missing_and_unknown_sources(api_client):
    missing = api_client.get("/api/v1/shipcheck/catalog/rules")
    unknown = api_client.get("/api/v1/shipcheck/catalog/not-a-source")

    assert missing.status_code == 503
    assert "has not been imported" in missing.json()["error"]["message"]
    assert unknown.status_code == 404


def test_catalog_json_is_cached_per_version_and_refreshed_on_a_new_version(api_client, tmp_path):
    from app.services import shipcheck_catalog

    source_path = tmp_path / "rules.json"
    sources = {"rules": CatalogSource("rules.json", "rules")}
    source_path.write_text(json.dumps({"rules": [{"id": "R1"}]}), encoding="utf-8")
    with api_client.TestSession.begin() as session:
        import_catalog_sources(session, tmp_path, sources)
    assert api_client.get("/api/v1/shipcheck/catalog/rules").json() == {"rules": [{"id": "R1"}]}
    cached = list(shipcheck_catalog.CACHE_DIR.glob("rules-*.json"))
    assert len(cached) == 1

    calls = []
    original = shipcheck_catalog.read_active_catalog
    shipcheck_catalog.read_active_catalog = lambda *a, **k: calls.append(1) or original(*a, **k)
    try:
        assert api_client.get("/api/v1/shipcheck/catalog/rules").json() == {"rules": [{"id": "R1"}]}
        assert calls == [], "a cached version is served without reading the records again"
        source_path.write_text(json.dumps({"rules": [{"id": "R1"}, {"id": "R2"}]}), encoding="utf-8")
        with api_client.TestSession.begin() as session:
            import_catalog_sources(session, tmp_path, sources)
        response = api_client.get("/api/v1/shipcheck/catalog/rules")
        assert response.json() == {"rules": [{"id": "R1"}, {"id": "R2"}]}
        assert response.headers["cache-control"] == "no-store"
        assert calls == [1], "a newly activated version is read from the database"
    finally:
        shipcheck_catalog.read_active_catalog = original
