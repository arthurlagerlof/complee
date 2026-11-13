"""Rule verification: sources, quotes, immutable versions, level 1 and level 2 with four eyes, status for the viewer."""
import base64

from app.services import rule_verification as rv

SOLAS_TEXT = (
    "Regulation 13 - Means of escape\n"
    "3.1.1 Stairways and corridors used as means of escape shall be not less than 900 mm in clear width.\n"
    "3.1.2 Dead-end corridors shall not exceed 7 m in length.\n"
)
RULE = {
    "id": "FSS-13-CORRIDOR", "source": "SOLAS II-2/13", "clause": "Corridor clear width", "text": "Corridors 900 mm.",
    "check": "min", "parameter": "clear_width", "value": 900, "unit": "mm", "applies_to": {"types": ["corridor"]}, "verified": False,
}
DQ = {"id": "DQ-X", "source": "internal", "clause": "x", "text": "x", "check": "data_quality", "applies_to": {"types": ["plate"]}, "verified": False}


def _source(client, text=SOLAS_TEXT, name="solas.txt"):
    r = client.post("/api/v1/rule-verification/sources", json={
        "filename": name, "content_base64": base64.b64encode(text.encode()).decode(), "instrument": "SOLAS Chapter II-2",
        "edition": "Consolidated 2024", "licence": "licensed_internal", "actor": "Anna"})
    assert r.status_code == 200, r.text
    return r.json()["source"]["id"]


def _latest(client, rule_id="FSS-13-CORRIDOR"):
    return client.get(f"/api/v1/rule-verification/rules/{rule_id}").json()["versions"][0]


def test_quote_matching_ignores_case_spacing_and_dash_style_but_not_words():
    text = "Stairways and corridors\nshall be not less than 900 mm – clear width."
    hit = rv.find_quote(text, [[0, 1], [24, 2]], "STAIRWAYS and corridors shall be not less than 900 mm - clear")
    assert hit and hit["page"] == 1 and hit["text"].startswith("Stairways")
    assert rv.find_quote(text, [[0, 1]], "shall be not less than 800 mm") is None
    assert rv.find_quote(text, [[0, 1]], "900 mm") is None  # too short to prove anything


def test_flow_import_quote_version_level1_level2_and_status(api_client):
    c = api_client
    out = c.post("/api/v1/rule-verification/import", json={"rules": [RULE, DQ], "actor": "Anna"}).json()
    assert out["created"] == ["FSS-13-CORRIDOR", "DQ-X"]
    # Importing again never overwrites; a changed rule is reported, not stored.
    again = c.post("/api/v1/rule-verification/import", json={"rules": [{**RULE, "value": 1000}, DQ], "actor": "Anna"}).json()
    assert again == {"created": [], "unchanged": ["DQ-X"], "differs": ["FSS-13-CORRIDOR"]}

    st = c.get("/api/v1/rule-verification/status").json()["rules"]
    assert st["FSS-13-CORRIDOR"]["label"] == "draft" and st["DQ-X"]["label"] == "internal"
    assert st["FSS-13-CORRIDOR"]["logic_sha256"] == rv.logic_sha256(RULE)

    v1 = _latest(c)
    assert v1["required_fields"] == ["requirement", "value"] and v1["missing_fields"] == ["requirement", "value"]
    r = c.post(f"/api/v1/rule-verification/versions/{v1['id']}/verifications", json={"level": 1, "reviewer": "Anna", "decision": "approved"})
    assert r.status_code == 422 and "missing" in r.json()["error"]["message"]

    src = _source(c)
    # Same file again: stored once.
    assert c.post("/api/v1/rule-verification/sources", json={"filename": "copy.txt", "content_base64": base64.b64encode(SOLAS_TEXT.encode()).decode(),
                                                                "instrument": "x", "edition": "y", "licence": "public", "actor": "Anna"}).json()["created"] is False
    # A quote that is not in the source: nothing is saved.
    bad = c.post("/api/v1/rule-verification/rules/FSS-13-CORRIDOR/versions", json={
        "logic": RULE, "author": "Anna", "change_reason": "quotes",
        "evidence": [{"field": "value", "source_id": src, "quote": "shall be not less than 800 mm in clear width"}]})
    assert bad.status_code == 422 and "not found" in bad.json()["error"]["message"]
    assert _latest(c)["version"] == 1

    ok = c.post("/api/v1/rule-verification/rules/FSS-13-CORRIDOR/versions", json={
        "logic": RULE, "author": "Anna", "change_reason": "Quotes from SOLAS 2024",
        "evidence": [{"field": "requirement", "source_id": src, "quote": "stairways and corridors used as means of escape"},
                     {"field": "value", "source_id": src, "quote": "shall be not less than 900 mm in clear width"}]})
    assert ok.json()["version"] == 2
    v2 = _latest(c)
    assert v2["missing_fields"] == [] and v2["evidence"][0]["quote"] == "Stairways and corridors used as means of escape"
    assert v2["evidence"][1]["page"] == 1 and v2["warnings"] == []

    # Level 2 before level 1 is refused.
    assert c.post(f"/api/v1/rule-verification/versions/{v2['id']}/verifications", json={"level": 2, "reviewer": "Ben", "decision": "approved"}).status_code == 422
    assert c.post(f"/api/v1/rule-verification/versions/{v2['id']}/verifications", json={"level": 1, "reviewer": "Anna", "decision": "approved"}).status_code == 200
    assert c.get("/api/v1/rule-verification/status").json()["rules"]["FSS-13-CORRIDOR"]["label"] == "text_checked"
    # Four eyes: the author or the text checker cannot do the engineering review.
    four = c.post(f"/api/v1/rule-verification/versions/{v2['id']}/verifications", json={"level": 2, "reviewer": " anna ", "decision": "approved"})
    assert four.status_code == 422 and "Four eyes" in four.json()["error"]["message"]
    assert c.post(f"/api/v1/rule-verification/versions/{v2['id']}/verifications", json={"level": 2, "reviewer": "Ben", "decision": "approved",
                                                                                         "note": "No UI applies; clear width between handrails."}).status_code == 200
    s = c.get("/api/v1/rule-verification/status").json()["rules"]["FSS-13-CORRIDOR"]
    assert (s["label"], s["text_checked_by"], s["reviewed_by"], s["sources"]) == ("reviewed", "Anna", "Ben", ["SOLAS Chapter II-2, Consolidated 2024"])

    # A changed rule is a new version and starts again as a draft; the old version cannot be verified any more.
    changed = {**RULE, "value": 1000}
    c.post("/api/v1/rule-verification/rules/FSS-13-CORRIDOR/versions", json={"logic": changed, "author": "Anna", "change_reason": "test", "evidence": []})
    assert c.get("/api/v1/rule-verification/status").json()["rules"]["FSS-13-CORRIDOR"]["label"] == "draft"
    old = c.post(f"/api/v1/rule-verification/versions/{v2['id']}/verifications", json={"level": 1, "reviewer": "Anna", "decision": "rejected", "note": "x"})
    assert old.status_code == 422 and "superseded" in old.json()["error"]["message"]
    assert [r["value"] for r in c.get("/api/v1/rule-verification/catalog").json()["rules"] if r["id"] == "FSS-13-CORRIDOR"] == [1000]

    # Internal checks cannot be verified against a source; rejecting needs a reason.
    dq = _latest(c, "DQ-X")
    assert c.post(f"/api/v1/rule-verification/versions/{dq['id']}/verifications", json={"level": 1, "reviewer": "Anna", "decision": "approved"}).status_code == 422
    v3 = _latest(c)
    assert c.post(f"/api/v1/rule-verification/versions/{v3['id']}/verifications", json={"level": 1, "reviewer": "Anna", "decision": "rejected"}).status_code == 422


def test_required_fields_follow_the_rule_and_value_hint():
    pax = {**RULE, "applies_to": {"types": ["corridor"], "ship": {"type_in": ["passenger"], "constructed": {"on_or_after": "2028-01-01"}}}}
    assert rv.required_fields(pax) == ["requirement", "value", "applies_to.ship", "constructed"]
    assert rv.required_fields({**RULE, "check": "manual"}) == ["requirement"]
    assert rv.value_warnings(RULE, [{"field": "value", "quote": "not less than 0.9 m in clear width"}])
    assert rv.value_warnings(RULE, [{"field": "value", "quote": "not less than 900 mm in clear width"}]) == []


def test_ai_proposal_keeps_only_quotes_found_in_the_source(api_client, monkeypatch):
    from app.services import ai_assist, ai_chain

    c = api_client
    c.post("/api/v1/rule-verification/import", json={"rules": [RULE], "actor": "Anna"})
    src = _source(c)
    monkeypatch.setattr(ai_chain, "active_steps", lambda: [object()])
    monkeypatch.setattr(ai_assist, "_run", lambda *a, **k: {"result": {"fields": [
        {"field": "value", "proposed": "900 mm", "quote": "shall be not less than 900 mm in clear width"},
        {"field": "requirement", "proposed": "x", "quote": "corridors shall always be at least one metre wide"},
    ], "differences": [], "notes": ["Dead ends limited to 7 m."]}, "model": "test", "duration_ms": 10, "cost_usd": 0.001})
    out = c.post("/api/v1/rule-verification/rules/FSS-13-CORRIDOR/propose", json={"source_id": src, "hint": "3.1.1"}).json()
    assert [(f["field"], f["found"]) for f in out["fields"]] == [("value", True), ("requirement", False)]
    assert out["fields"][0]["page"] == 1


def test_passage_finds_the_clause_in_a_long_source():
    lines = [f"filler line {i} about lifeboats" for i in range(2000)]
    lines[1500] = "13.3.1.5 Corridors shall have a clear width of not less than 900 mm."
    passage = rv._passage("\n".join(lines), RULE, "13.3.1.5", limit=3000)
    assert "13.3.1.5 Corridors" in passage and len(passage) <= 3000
