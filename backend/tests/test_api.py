def create_design(client):
    project_response = client.post("/api/v1/projects", json={"name": "Fire safety concept"})
    assert project_response.status_code == 201
    project = project_response.json()

    vessel_response = client.post(
        "/api/v1/vessels",
        json={"project_id": project["id"], "name": "Demo vessel", "vessel_type": "research"},
    )
    assert vessel_response.status_code == 201
    vessel = vessel_response.json()

    revision_response = client.post(
        "/api/v1/design-revisions",
        json={
            "vessel_id": vessel["id"],
            "revision_name": "Concept",
            "revision_number": 1,
        },
    )
    assert revision_response.status_code == 201
    return project, vessel, revision_response.json()


def test_database_health_and_project_creation(api_client):
    health = api_client.get("/health/database")
    assert health.status_code == 200
    assert health.json() == {"status": "ok", "database": "connected"}

    project = api_client.post("/api/v1/projects", json={"name": "Project"})
    assert project.status_code == 201
    assert project.json()["name"] == "Project"
    assert api_client.get("/api/v1/projects").json()[0]["id"] == project.json()["id"]


def test_vessel_revision_component_crud_and_relationships(api_client):
    _, vessel, revision = create_design(api_client)
    assert api_client.get(f"/api/v1/vessels/{vessel['id']}").status_code == 200
    assert api_client.get(f"/api/v1/design-revisions?vessel_id={vessel['id']}").json()[0]["id"] == revision["id"]

    component_response = api_client.post(
        "/api/v1/components",
        json={
            "revision_id": revision["id"],
            "component_type": "fuel_tank",
            "name": "Fuel Tank 01",
            "properties": {
                "fuel_type": "LNG",
                "capacity": {"value": 12, "unit": "m3"},
            },
            "source_reference": {"source": "manual input"},
            "confidence": 0.8,
        },
    )
    assert component_response.status_code == 201
    first = component_response.json()
    assert first["properties"]["capacity"] == {"value": 12, "unit": "m3"}
    assert api_client.get(f"/api/v1/components/{first['id']}").json()["id"] == first["id"]

    second_response = api_client.post(
        "/api/v1/components",
        json={
            "revision_id": revision["id"],
            "component_type": "pipe",
            "name": "Fuel line",
            "properties": {},
        },
    )
    assert second_response.status_code == 201
    second = second_response.json()
    relationship = api_client.post(
        "/api/v1/relationships",
        json={
            "revision_id": revision["id"],
            "source_component_id": first["id"],
            "target_component_id": second["id"],
            "relationship_type": "feeds",
            "properties": {"medium": "LNG"},
        },
    )
    assert relationship.status_code == 201
    relationships = api_client.get(f"/api/v1/design-revisions/{revision['id']}/relationships")
    assert relationships.status_code == 200
    assert relationships.json()[0]["relationship_type"] == "feeds"

    updated = api_client.patch(
        f"/api/v1/components/{first['id']}",
        json={"review_status": "reviewed", "properties": {"capacity": {"value": 14, "unit": "m3"}}},
    )
    assert updated.status_code == 200
    assert updated.json()["properties"]["capacity"]["value"] == 14
    assert len(api_client.get(f"/api/v1/design-revisions/{revision['id']}/components").json()) == 2
    assert api_client.delete(f"/api/v1/components/{first['id']}").status_code == 204
    assert len(api_client.get(f"/api/v1/design-revisions/{revision['id']}/components").json()) == 1


def test_assessment_finding_and_engineer_review(api_client):
    _, _, revision = create_design(api_client)
    component = api_client.post(
        "/api/v1/components",
        json={
            "revision_id": revision["id"],
            "component_type": "compartment",
            "name": "Machinery space",
            "properties": {"deck": "lower"},
        },
    ).json()
    assessment_response = api_client.post(
        "/api/v1/assessments",
        json={"revision_id": revision["id"]},
    )
    assert assessment_response.status_code == 201
    assessment = assessment_response.json()
    assert assessment["findings"] == []

    finding_response = api_client.post(
        f"/api/v1/assessments/{assessment['id']}/findings",
        json={
            "assessment_id": assessment["id"],
            "requirement_id": str(api_client.requirement_id),
            "component_ids": [component["id"]],
            "finding_type": "needs_review",
            "description": "Review compartment fire separation evidence.",
            "evidence": {"source": "design review"},
            "assumptions": {},
        },
    )
    assert finding_response.status_code == 201
    finding = finding_response.json()
    assert finding["component_ids"] == [component["id"]]

    reviewed = api_client.patch(
        f"/api/v1/findings/{finding['id']}",
        json={
            "status": "accepted",
            "finding_type": "verified_by_engineer",
            "reviewed_by": "Reviewer A",
            "review_notes": "Evidence checked by engineer.",
        },
    )
    assert reviewed.status_code == 200
    assert reviewed.json()["finding_type"] == "verified_by_engineer"
    assert reviewed.json()["reviewed_at"] is not None
    nested = api_client.get(f"/api/v1/assessments/{assessment['id']}")
    assert nested.status_code == 200
    assert nested.json()["findings"][0]["status"] == "accepted"
    assert api_client.get("/api/v1/assessments").json()[0]["id"] == assessment["id"]


def test_validation_and_conflict_responses(api_client):
    _, vessel, _ = create_design(api_client)
    duplicate = api_client.post(
        "/api/v1/design-revisions",
        json={"vessel_id": vessel["id"], "revision_name": "Duplicate", "revision_number": 1},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "conflict"

    invalid_project = api_client.post(
        "/api/v1/vessels",
        json={"project_id": "bd3748d5-3370-4b9d-9e40-e1a5d4188a11", "name": "Vessel"},
    )
    assert invalid_project.status_code == 404, invalid_project.text
    assert invalid_project.json()["error"]["code"] == "not_found"

    invalid_verified_finding = api_client.post(
        "/api/v1/findings",
        json={
            "assessment_id": "bd3748d5-3370-4b9d-9e40-e1a5d4188a1",
            "requirement_id": str(api_client.requirement_id),
            "finding_type": "verified_by_engineer",
            "description": "Must be reviewed first.",
        },
    )
    assert invalid_verified_finding.status_code == 422


def test_design_facts_context_and_same_revision_validation(api_client):
    _, vessel, revision = create_design(api_client)
    component = api_client.post(
        "/api/v1/components",
        json={
            "revision_id": revision["id"],
            "component_type": "fuel_tank",
            "name": "Tank 1",
            "properties": {"capacity": {"value": 20, "unit": "m3"}},
            "source_reference": {"source_type": "cad", "object_id": "CAD-TANK-1"},
        },
    ).json()
    fact_response = api_client.post(
        "/api/v1/design-facts",
        json={
            "revision_id": revision["id"],
            "component_id": component["id"],
            "fact_type": "capacity",
            "statement": "Tank 1 capacity is 20 m3.",
            "value": {"value": 20, "unit": "m3"},
            "source_reference": {"source_type": "manual", "document": "design note"},
        },
    )
    assert fact_response.status_code == 201
    fact = fact_response.json()
    assert fact["source_reference"]["source_type"] == "manual"
    assert api_client.get(f"/api/v1/design-revisions/{revision['id']}/facts").json()[0]["id"] == fact["id"]

    detail = api_client.get(f"/api/v1/design-revisions/{revision['id']}/understand").json()
    assert detail["components"][0]["properties"]["capacity"]["unit"] == "m3"
    assert detail["facts"][0]["statement"] == "Tank 1 capacity is 20 m3."
    retrieval_context = api_client.get(
        f"/api/v1/design-revisions/{revision['id']}/retrieval-context"
    ).json()["description"]
    assert "Tank 1" in retrieval_context
    assert "Tank 1 capacity is 20 m3." in retrieval_context

    other_revision = api_client.post(
        "/api/v1/design-revisions",
        json={"vessel_id": vessel["id"], "revision_name": "Next", "revision_number": 2},
    ).json()
    invalid_fact = api_client.post(
        "/api/v1/design-facts",
        json={
            "revision_id": other_revision["id"],
            "component_id": component["id"],
            "fact_type": "capacity",
            "statement": "Cross-revision reference",
            "source_reference": {"source_type": "manual"},
        },
    )
    assert invalid_fact.status_code == 422


def test_assessment_orchestrator_persists_snapshot_and_freezes_revision(api_client):
    _, _, revision = create_design(api_client)
    component = api_client.post(
        "/api/v1/components",
        json={
            "revision_id": revision["id"],
            "component_type": "fuel_tank",
            "name": "Tank 1",
            "properties": {},
            "source_reference": {"source_type": "drawing", "drawing": "DWG-1"},
        },
    ).json()
    run = api_client.post(
        "/api/v1/assessments/run",
        json={
            "revision_id": revision["id"],
            "candidates": [
                {
                    "requirement_id": str(api_client.requirement_id),
                    "component_ids": [component["id"]],
                    "required_information": [f"component:{component['id']}:capacity.value"],
                }
            ],
        },
    )
    assert run.status_code == 201, run.text
    assessment = run.json()
    assert assessment["status"] == "completed"
    finding = assessment["findings"][0]
    assert finding["finding_type"] == "missing_information"
    assert finding["component_ids"] == [component["id"]]
    assert finding["requirement_snapshot"]["text"] == (
        "Fire containment requirements for ship compartments."
    )
    assert finding["requirement_snapshot"]["edition"] == "2002"
    assert finding["assumptions"]["compliance_decision_made"] is False
    assert api_client.get(f"/api/v1/assessments/{assessment['id']}/findings").status_code == 200

    updated = api_client.patch(
        f"/api/v1/components/{component['id']}",
        json={"name": "Changed after assessment"},
    )
    assert updated.status_code == 409
    assert updated.json()["error"]["code"] == "conflict"


def test_calculation_tools_are_independently_callable(api_client):
    assert {"geometry", "documents", "fluid", "structural"} <= set(
        api_client.get("/api/v1/calculations/tools").json()
    )
    geometry = api_client.post(
        "/api/v1/calculations/geometry",
        json={
            "inputs": {
                "operation": "distance",
                "first": {"coordinates": [0, 0, 0], "unit": "m"},
                "second": {"coordinates": [3, 4, 0], "unit": "m"},
            }
        },
    )
    assert geometry.status_code == 200
    assert geometry.json()["status"] == "calculated"
    assert geometry.json()["result"] == {"distance": 5.0, "unit": "m"}

    missing_geometry = api_client.post(
        "/api/v1/calculations/geometry",
        json={"inputs": {"operation": "volume"}},
    )
    assert missing_geometry.status_code == 200
    assert missing_geometry.json()["status"] == "needs_information"

    fluid = api_client.post("/api/v1/calculations/fluid", json={"inputs": {}})
    assert fluid.status_code == 200
    assert fluid.json()["status"] == "needs_information"


def test_legacy_regulatory_and_design_context_remain_read_only(api_client):
    fact = api_client.get(f"/api/v1/legacy-design-facts/{api_client.legacy_fact_id}")
    assert fact.status_code == 200
    assert fact.json()["name"] == "Machinery space"
    assert fact.json()["source_file"] == "layout.pdf"

    instrument = api_client.get(f"/api/v1/instruments/{api_client.instrument_id}")
    assert instrument.status_code == 200
    assert instrument.json()["availability"] == "summary"
    assert instrument.json()["applies_to"] == ["cruise", "research"]

    requirement = api_client.get(f"/api/v1/regulations/{api_client.requirement_id}")
    assert requirement.status_code == 200
    assert requirement.json()["text"] == "Fire containment requirements for ship compartments."

    from app.services.retrieval.adapters import design_query_adapter

    with api_client.TestSession() as session:
        context = design_query_adapter.build_query(
            session, legacy_fact_id=api_client.legacy_fact_id
        )
    assert "Machinery space" in context
    assert "Aft fire division" in context
    assert "layout.pdf" in context
