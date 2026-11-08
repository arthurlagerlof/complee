import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.database import Base, get_db
from app.main import app


@pytest.fixture
def api_client(monkeypatch):
    test_engine = create_engine(
        "sqlite+pysqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(test_engine, "connect")
    def attach_public_schema(connection, _record):
        connection.execute("ATTACH DATABASE ':memory:' AS public")
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(test_engine)
    with test_engine.begin() as connection:
        connection.exec_driver_sql(
            """
            CREATE TABLE public.instruments (
                id CHAR(32) PRIMARY KEY,
                code TEXT,
                name TEXT,
                authority TEXT,
                availability TEXT,
                source_url TEXT,
                note TEXT,
                applies_to TEXT
            )
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TABLE public.provisions (
                id CHAR(32) PRIMARY KEY,
                instrument_id CHAR(32),
                clause_key TEXT,
                heading_path TEXT,
                body TEXT,
                language TEXT,
                edition TEXT,
                availability TEXT,
                applicability TEXT,
                search_tsv TEXT,
                embedding TEXT
            )
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TABLE public.design_facts (
                id CHAR(32) PRIMARY KEY,
                kind TEXT,
                name TEXT,
                deck TEXT,
                value TEXT,
                source_file TEXT
            )
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TABLE public.findings (
                id CHAR(32) PRIMARY KEY,
                design_fact_id CHAR(32),
                provision_id CHAR(32),
                why TEXT,
                clause_key TEXT,
                heading_path TEXT,
                body TEXT,
                availability TEXT
            )
            """
        )
        instrument_id = uuid.uuid4()
        requirement_id = uuid.uuid4()
        legacy_fact_id = uuid.uuid4()
        connection.exec_driver_sql(
            """
            INSERT INTO public.instruments
                (id, code, name, authority, availability, applies_to)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                instrument_id.hex,
                "SOLAS_II2",
                "SOLAS Chapter II-2",
                "IMO",
                "summary",
                '["cruise","research"]',
            ),
        )
        connection.exec_driver_sql(
            """
            INSERT INTO public.design_facts (id, kind, name, deck, value, source_file)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                legacy_fact_id.hex,
                "compartment",
                "Machinery space",
                "Deck 1",
                "Aft fire division",
                "layout.pdf",
            ),
        )
        connection.exec_driver_sql(
            """
            INSERT INTO public.provisions
                (id, instrument_id, clause_key, heading_path, body, language, edition, availability,
                 applicability, search_tsv)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                requirement_id.hex,
                instrument_id.hex,
                "9.2.1",
                "Regulation 9 / Containment",
                "Fire containment requirements for ship compartments.",
                "en",
                "2002",
                "summary",
                "[]",
                "fire containment requirements for ship compartments",
            ),
        )

    TestSession = sessionmaker(bind=test_engine, autoflush=False, expire_on_commit=False)

    def override_get_db():
        with TestSession() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    import app.main as main_module

    monkeypatch.setattr(main_module, "engine", test_engine)
    with TestClient(app) as client:
        client.requirement_id = requirement_id
        client.instrument_id = instrument_id
        client.legacy_fact_id = legacy_fact_id
        client.TestSession = TestSession
        yield client
    app.dependency_overrides.clear()
    test_engine.dispose()


@pytest.fixture(autouse=True)
def _isolated_catalog_cache(tmp_path, monkeypatch):
    """Tests never read or write the developer's catalog response cache."""
    from app.services import shipcheck_catalog

    monkeypatch.setattr(shipcheck_catalog, "CACHE_DIR", tmp_path / "catalog-cache")
    monkeypatch.setattr(shipcheck_catalog, "_json_cache", {})
