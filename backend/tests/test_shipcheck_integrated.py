import base64
import io
import json
import uuid
import zipfile

from app.services import shipcheck_runtime as rt
from app.services.shipcheck_catalog import CatalogSource, import_catalog_sources


def test_inspection_health_and_static_ui(api_client):
    res = api_client.get("/inspection/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["catalog_source"] == "database"
    assert "version" in body

    index_res = api_client.get("/inspection/index.html")
    assert index_res.status_code == 200
    assert "text/html" in index_res.headers["content-type"]

    root_res = api_client.get("/inspection/")
    assert root_res.status_code == 200
    assert "text/html" in root_res.headers["content-type"]

    secret_res = api_client.get("/inspection/.env")
    assert secret_res.status_code == 404


def test_inspection_catalog_scenarios_rules_and_regulation_text(api_client, tmp_path, monkeypatch):
    prov_id = uuid.uuid4()
    monkeypatch.setattr(
        rt,
        "get_requirement",
        lambda _db, pid: (
            {
                "id": prov_id,
                "regulatory_document": "SOLAS",
                "document_code": "SOLAS",
                "edition": "2024",
                "chapter": "Chapter II-2 > Reg 13",
                "clause_reference": "II-2/13.3.4",
                "text": "Dead-end corridors shall not exceed 7 m.",
                "provision_availability": "summary",
                "metadata": {"document_note": None},
            }
            if pid == prov_id
            else None
        ),
    )

    (tmp_path / "rules.json").write_text(
        json.dumps({"rules": [{"id": "RULE-1"}, {"id": "RULE-2"}]}),
        encoding="utf-8",
    )
    (tmp_path / "scenarios.json").write_text(
        json.dumps({"scenarios": [{"id": "rcrv-3d", "name": "RCRV 3D"}]}),
        encoding="utf-8",
    )
    (tmp_path / "regulation-links.json").write_text(
        json.dumps(
            {
                "database": "test-db",
                "loaded_instruments": ["SOLAS"],
                "method": "curated",
                "rules": {
                    "RULE-2": {
                        "note": "Exact clause",
                        "links": [{"provision_id": str(prov_id), "clause": "II-2/13.3.4", "match": "direct"}],
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    sources = {
        "rules": CatalogSource("rules.json", "rules"),
        "scenarios": CatalogSource("scenarios.json", "scenarios"),
        "regulation-links": CatalogSource("regulation-links.json"),
    }
    with api_client.TestSession.begin() as session:
        import_catalog_sources(session, tmp_path, sources)

    sc_res = api_client.get("/inspection/api/scenarios")
    assert sc_res.status_code == 200
    assert sc_res.json() == [{"id": "rcrv-3d", "name": "RCRV 3D"}]

    rules_res = api_client.get("/inspection/api/rules")
    assert rules_res.status_code == 200
    assert rules_res.json() == {"rules": [{"id": "RULE-1"}, {"id": "RULE-2"}]}

    cat_res = api_client.get("/inspection/api/catalog/scenarios")
    assert cat_res.status_code == 200
    assert cat_res.json()["scenarios"] == [{"id": "rcrv-3d", "name": "RCRV 3D"}]

    unlinked = api_client.get("/inspection/api/regulations/text?rule=RULE-1")
    assert unlinked.status_code == 200
    assert unlinked.json()["linked"] is False

    linked = api_client.get("/inspection/api/regulations/text?rule=RULE-2")
    assert linked.status_code == 200
    linked_body = linked.json()
    assert linked_body["linked"] is True
    assert linked_body["reachable"] is True
    assert len(linked_body["provisions"]) == 1
    assert linked_body["provisions"][0]["clause"] == "II-2/13.3.4"
    assert "Dead-end corridors" in linked_body["provisions"][0]["text"]

    unknown = api_client.get("/inspection/api/regulations/text?rule=NOPE")
    assert unknown.status_code == 404


def test_inspection_model_config_and_range_serving(api_client, tmp_path, monkeypatch):
    model_dir = tmp_path / "model"
    stream_hp = model_dir / "stream-hp"
    stream_hp.mkdir(parents=True)
    (stream_hp / "manifest.json").write_text(json.dumps({"kind": "viewport-tiles"}), encoding="utf-8")
    (stream_hp / "audit.json").write_text(json.dumps({"pass": False}), encoding="utf-8")
    tile = stream_hp / "hull-0123456789ab.glb"
    tile.write_bytes(b"0123456789abcdef")

    monkeypatch.setenv("MODEL_DIR", str(model_dir))
    monkeypatch.delenv("MODEL_SOURCE", raising=False)
    monkeypatch.setattr(rt, "load_s3_config", lambda: None)

    # Unaudited stream-hp must be refused with 503
    unaudited = api_client.get("/inspection/api/model/config")
    assert unaudited.status_code == 503

    (stream_hp / "audit.json").write_text(json.dumps({"pass": True}), encoding="utf-8")
    monkeypatch.setenv("MODEL_BASE_URL", "https://models.example.com/")
    cfg_res = api_client.get("/inspection/api/model/config")
    assert cfg_res.status_code == 200
    assert cfg_res.json()["manifest"] == "stream-hp/manifest.json"
    assert cfg_res.json()["base_url"] == "https://models.example.com/"

    range_res = api_client.get(
        "/inspection/model/stream-hp/hull-0123456789ab.glb",
        headers={"Range": "bytes=4-7"},
    )
    assert range_res.status_code == 206
    assert range_res.headers["content-range"] == "bytes 4-7/16"
    assert range_res.content == b"4567"

    disallowed = api_client.get("/inspection/model/../secret.txt")
    assert disallowed.status_code == 404


def test_s3_key_allowlist_and_v4_signing():
    assert rt.is_servable_key("stream-hp/manifest.json") is True
    assert rt.is_servable_key("stream-hp/hull-0123456789ab.glb") is True
    assert rt.is_servable_key("stream/overview-hull-0123456789ab.glb") is True
    assert rt.is_servable_key("../.env") is False
    assert rt.is_servable_key("source.nwd") is False

    headers = rt._sign_v4(
        method="GET",
        host="ewr1.vultrobjects.com",
        uri_path="/bucket/stream-hp/manifest.json",
        access_key="AKIAEXAMPLE",
        secret_key="SECRETEXAMPLE",
        region="us-east-1",
        amz_date="20261117T000000Z",
    )
    assert headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261117/us-east-1/s3/aws4_request")


def test_inspection_aps_and_evidence_routes(api_client):
    aps_res = api_client.get("/inspection/api/aps/status")
    assert aps_res.status_code == 200
    assert "configured" in aps_res.json()

    ev_root = api_client.get("/api/evidence/provider")
    assert ev_root.status_code == 200
    assert ev_root.json()["id"] in {"sinceai", "none"}

    ev_insp = api_client.get("/inspection/api/evidence/provider")
    assert ev_insp.status_code == 200
    assert ev_insp.json() == ev_root.json()

    search_res = api_client.get("/inspection/api/evidence/search?q=fire")
    assert search_res.status_code == 200
    assert "results" in search_res.json()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>SOLAS II-2 fire containment</w:t></w:r></w:p></w:body></w:document>",
        )
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    review_res = api_client.post("/api/evidence/review", json={"filename": "brief.docx", "dataBase64": b64})
    assert review_res.status_code == 200
    assert review_res.json()["paragraphCount"] == 1
    assert "SOLAS II-2 fire containment" in review_res.json()["preview"]

    bad_review = api_client.post("/api/evidence/review", json={"filename": "brief.txt", "dataBase64": b64})
    assert bad_review.status_code == 422


def test_settings_debug_parser_and_rate_limiter():
    from app.core.config import Settings

    assert Settings._parse_debug("release") is False
    assert Settings._parse_debug("production") is False
    assert Settings._parse_debug("false") is False
    assert Settings._parse_debug("true") is True
    assert Settings._parse_debug("development") is True

    limiter = rt.SlidingWindowRateLimiter(window_s=60.0, max_requests=2, max_clients=10)
    assert limiter.check("1.2.3.4")[0] is True
    assert limiter.check("1.2.3.4")[0] is True
    allowed, retry_after = limiter.check("1.2.3.4")
    assert allowed is False
    assert retry_after >= 1
