import uuid

import pytest
from sqlalchemy.exc import InvalidRequestError

from app.db.database import ApplicationBase
from app.db.models.legacy import Instrument, LegacyBase


def test_application_and_legacy_models_use_separate_metadata():
    application_tables = set(ApplicationBase.metadata.tables)
    legacy_tables = set(LegacyBase.metadata.tables)

    assert application_tables == {
        "sc_projects",
        "sc_vessels",
        "sc_design_revisions",
        "sc_design_components",
        "sc_component_relationships",
        "sc_design_facts",
        "sc_assessments",
        "sc_findings",
        "sc_finding_components",
        "sc_ai_providers",
        "sc_ai_model_configs",
        "sc_ai_task_configurations",
        "sc_ai_extractions",
        "sc_ai_executions",
        "sc_source_documents",
    }
    assert legacy_tables == {
        "public.instruments",
        "public.provisions",
        "public.design_facts",
        "public.findings",
    }
    assert application_tables.isdisjoint(legacy_tables)


def test_legacy_mapped_models_reject_writes(api_client):
    with api_client.TestSession() as session:
        session.add(
            Instrument(
                id=uuid.uuid4(),
                code="TEST",
                name="Read-only fixture",
                availability="summary",
                applies_to=[],
            )
        )
        with pytest.raises(InvalidRequestError, match="read-only"):
            session.flush()
