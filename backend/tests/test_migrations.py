import json
import os
import uuid

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.engine import make_url

from app.core.config import BACKEND_DIR


APPLICATION_TABLES = {
    "sc_projects",
    "sc_vessels",
    "sc_design_revisions",
    "sc_design_components",
    "sc_component_relationships",
    "sc_design_facts",
    "sc_assessments",
    "sc_findings",
    "sc_finding_components",
}


def test_upgrade_and_downgrade_preserve_legacy_tables(monkeypatch):
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_DATABASE_URL to a disposable local PostgreSQL database to run migration tests.")

    url = make_url(database_url)
    if url.host not in {"localhost", "127.0.0.1", "::1"} or "test" not in (url.database or "").lower():
        pytest.fail("Migration tests require a loopback PostgreSQL database with 'test' in its name.")

    from app.core.config import settings

    monkeypatch.setattr(settings, "database_url", database_url)
    engine = create_engine(database_url)
    legacy_names = ("instruments", "provisions", "design_facts", "findings")
    try:
        with engine.begin() as connection:
            existing_app_tables = connection.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_name LIKE 'sc_%'"
                )
            ).scalars().all()
            if existing_app_tables:
                pytest.fail("Migration tests require an empty application schema.")
            for name in legacy_names:
                exists = connection.execute(
                    text("SELECT to_regclass(:table_name)"), {"table_name": f"public.{name}"}
                ).scalar_one()
                if exists is None:
                    connection.execute(text(f"CREATE TABLE public.{name} (id integer PRIMARY KEY, payload text)"))
                    connection.execute(
                        text(f"INSERT INTO public.{name} (id, payload) VALUES (1, :payload)"),
                        {"payload": f"{name}-sentinel"},
                    )

        def legacy_snapshot():
            with engine.connect() as connection:
                return {
                    name: {
                        "columns": tuple(
                            connection.execute(
                                text(
                                    "SELECT column_name, data_type, udt_name, is_nullable, column_default "
                                    "FROM information_schema.columns "
                                    "WHERE table_schema='public' AND table_name=:name "
                                    "ORDER BY ordinal_position"
                                ),
                                {"name": name},
                            ).all()
                        ),
                        "rows": tuple(
                            connection.execute(
                                text(
                                    f"SELECT to_jsonb(t)::text FROM public.{name} AS t "
                                    "ORDER BY to_jsonb(t)::text"
                                )
                            ).scalars().all()
                        ),
                    }
                    for name in legacy_names
                }

        def extension_snapshot():
            with engine.connect() as connection:
                return tuple(
                    connection.execute(
                        text(
                            "SELECT e.extname, e.extversion, n.nspname "
                            "FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace "
                            "ORDER BY e.extname"
                        )
                    ).all()
                )

        before = legacy_snapshot()
        extensions_before = extension_snapshot()
        config = Config(str(BACKEND_DIR / "alembic.ini"))
        upgraded = False
        try:
            command.upgrade(config, "head")
            upgraded = True
            with engine.connect() as connection:
                app_tables = connection.execute(
                    text(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema='public' AND table_name LIKE 'sc_%' ORDER BY table_name"
                    )
                ).scalars().all()
                assert set(app_tables) == APPLICATION_TABLES
            assert legacy_snapshot() == before
            assert extension_snapshot() == extensions_before
            command.check(config)

            (
                project_id,
                vessel_id,
                revision_a,
                revision_b,
                component_a,
                component_a_target,
                component_b,
            ) = (uuid.uuid4() for _ in range(7))
            with engine.begin() as connection:
                connection.execute(
                    text("INSERT INTO sc_projects (id, name) VALUES (:id, 'Migration test')"),
                    {"id": project_id},
                )
                connection.execute(
                    text(
                        "INSERT INTO sc_vessels (id, project_id, name) "
                        "VALUES (:id, :project_id, 'Sentinel vessel')"
                    ),
                    {"id": vessel_id, "project_id": project_id},
                )
                for revision_id, number in ((revision_a, 1), (revision_b, 2)):
                    connection.execute(
                        text(
                            "INSERT INTO sc_design_revisions "
                            "(id, vessel_id, revision_name, revision_number, schema_version, status) "
                            "VALUES (:id, :vessel_id, :name, :number, '1.0', 'draft')"
                        ),
                        {
                            "id": revision_id,
                            "vessel_id": vessel_id,
                            "name": f"Revision {number}",
                            "number": number,
                        },
                    )
                for component_id, revision_id, name in (
                    (component_a, revision_a, "Revision A component"),
                    (component_a_target, revision_a, "Revision A target"),
                    (component_b, revision_b, "Revision B component"),
                ):
                    connection.execute(
                        text(
                            "INSERT INTO sc_design_components "
                            "(id, revision_id, component_type, name, properties, review_status) "
                            "VALUES (:id, :revision_id, 'equipment', :name, CAST('{}' AS jsonb), 'unreviewed')"
                        ),
                        {"id": component_id, "revision_id": revision_id, "name": name},
                    )
                connection.execute(
                    text(
                        "INSERT INTO sc_component_relationships "
                        "(id, revision_id, source_component_id, target_component_id, "
                        "relationship_type, properties) "
                        "VALUES (:id, :revision_id, :source_id, :target_id, 'connected_to', CAST('{}' AS jsonb))"
                    ),
                    {
                        "id": uuid.uuid4(),
                        "revision_id": revision_a,
                        "source_id": component_a,
                        "target_id": component_a_target,
                    },
                )
                assessment_id = uuid.uuid4()
                finding_id = uuid.uuid4()
                requirement_id = uuid.uuid4()
                snapshot = {
                    "text": "Historical provision text",
                    "edition": "test-edition",
                    "source_document": "Sentinel regulation",
                    "clause_reference": "TEST/1.1",
                }
                connection.execute(
                    text(
                        "INSERT INTO sc_assessments (id, revision_id, status) "
                        "VALUES (:id, :revision_id, 'completed')"
                    ),
                    {"id": assessment_id, "revision_id": revision_a},
                )
                connection.execute(
                    text(
                        "INSERT INTO sc_findings "
                        "(id, assessment_id, revision_id, requirement_id, requirement_snapshot, "
                        "verification_method, finding_type, status, description, evidence, "
                        "calculation_results, assumptions) "
                        "VALUES (:id, :assessment_id, :revision_id, :requirement_id, "
                        "CAST(:snapshot AS jsonb), 'engineering_review', 'needs_engineering_review', "
                        "'open', 'Migration snapshot check', CAST('{}' AS jsonb), "
                        "CAST('{}' AS jsonb), CAST('{}' AS jsonb))"
                    ),
                    {
                        "id": finding_id,
                        "assessment_id": assessment_id,
                        "revision_id": revision_a,
                        "requirement_id": requirement_id,
                        "snapshot": json.dumps(snapshot),
                    },
                )
                connection.execute(
                    text(
                        "INSERT INTO sc_finding_components (finding_id, component_id, revision_id) "
                        "VALUES (:finding_id, :component_id, :revision_id)"
                    ),
                    {
                        "finding_id": finding_id,
                        "component_id": component_a,
                        "revision_id": revision_a,
                    },
                )
                stored_snapshot = connection.execute(
                    text(
                        "SELECT requirement_snapshot FROM sc_findings WHERE id=:finding_id"
                    ),
                    {"finding_id": finding_id},
                ).scalar_one()
                assert stored_snapshot == snapshot

            with pytest.raises(IntegrityError):
                with engine.begin() as connection:
                    connection.execute(
                        text(
                            "INSERT INTO sc_component_relationships "
                            "(id, revision_id, source_component_id, target_component_id, "
                            "relationship_type, properties) "
                            "VALUES (:id, :revision_id, :source_id, :target_id, "
                            "'cross_revision', CAST('{}' AS jsonb))"
                        ),
                        {
                            "id": uuid.uuid4(),
                            "revision_id": revision_a,
                            "source_id": component_a,
                            "target_id": component_b,
                        },
                    )

            with pytest.raises(IntegrityError):
                with engine.begin() as connection:
                    connection.execute(
                        text(
                            "INSERT INTO sc_finding_components (finding_id, component_id, revision_id) "
                            "VALUES (:finding_id, :component_id, :revision_id)"
                        ),
                        {
                            "finding_id": finding_id,
                            "component_id": component_b,
                            "revision_id": revision_a,
                        },
                    )
        finally:
            if upgraded:
                command.downgrade(config, "base")
        with engine.connect() as connection:
            app_tables = connection.execute(
                text(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_name LIKE 'sc_%'"
                )
            ).scalars().all()
            assert app_tables == []
        assert legacy_snapshot() == before
        assert extension_snapshot() == extensions_before
    finally:
        engine.dispose()
