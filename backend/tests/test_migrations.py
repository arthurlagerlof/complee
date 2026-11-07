import os

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.core.config import BACKEND_DIR


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
                    name: (
                        connection.execute(text(f"SELECT count(*), min(payload) FROM public.{name}")).one(),
                        tuple(
                            connection.execute(
                                text(
                                    "SELECT column_name, data_type FROM information_schema.columns "
                                    "WHERE table_schema='public' AND table_name=:name ORDER BY ordinal_position"
                                ),
                                {"name": name},
                            ).all()
                        ),
                    )
                    for name in legacy_names
                }

        before = legacy_snapshot()
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
                assert len(app_tables) == 9
            assert legacy_snapshot() == before
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
    finally:
        engine.dispose()
