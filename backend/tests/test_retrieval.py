import uuid
import sys
from types import SimpleNamespace

import pytest

from app.services.retrieval import service
from app.core.config import settings


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def one(self):
        return self.rows[0]

    def __iter__(self):
        return iter(self.rows)


class FakeSession:
    def __init__(self, *, vector_rows=(), full_text_rows=(), hybrid_rows=(), permissions=None):
        self.vector_rows = list(vector_rows)
        self.full_text_rows = list(full_text_rows)
        self.hybrid_rows = list(hybrid_rows)
        self.permissions = permissions or {
            "role_name": "shipdesign_app",
            "schema_usage": True,
            "embedding_select": True,
            "schema_grant": "GRANT USAGE ON SCHEMA extensions TO shipdesign_app;",
        }
        self.statements = []

    def execute(self, statement, params=None):
        query = str(statement)
        self.statements.append((query, params or {}))
        if "has_schema_privilege" in query:
            return FakeResult([self.permissions])
        if "combined_score" in query:
            return FakeResult(self.hybrid_rows)
        if "OPERATOR(extensions.<=>)" in query:
            return FakeResult(self.vector_rows)
        return FakeResult(self.full_text_rows)


def result_row(requirement_id, **extra):
    row = {
        "id": requirement_id,
        "instrument_id": uuid.uuid4(),
        "text": "Requirement evidence text",
        "regulatory_document": "SOLAS Chapter II-2",
        "document_code": "SOLAS_II2",
        "edition": "2002",
        "chapter": "Regulation 9",
        "clause_reference": "9.2.1",
        "language": "en",
        "applicability": ["fire"],
        "instrument_applicability": ["cruise", "research"],
        "source_url": None,
        "authority": "IMO",
        "source_availability": "summary",
        "document_note": "MCA publication and guidance",
        "provision_availability": "summary",
    }
    return {**row, **extra}


def test_full_text_search_uses_english_vector_and_pre_rank_filters():
    requirement_id = uuid.uuid4()
    session = FakeSession(full_text_rows=[result_row(requirement_id, word_search_score=0.25)])

    results = service.search_full_text(
        session,
        "fire containment",
        5,
        {
            "document": "SOLAS",
            "edition": "2002",
            "chapter": None,
            "clause": None,
            "ship_type": "research",
            "topics": ["fire"],
        },
    )

    assert results[0].id == requirement_id
    assert results[0].retrieval_method == "full_text"
    assert results[0].word_search_score == 0.25
    assert results[0].source_availability == "summary"
    assert results[0].provision_availability == "summary"
    statement, params = session.statements[0]
    assert "plainto_tsquery('english', :query)" in statement
    assert "i.code = :document" in statement
    assert "cardinality(i.applies_to) = 0 OR :ship_type = ANY(i.applies_to)" in statement
    assert "p.applicability && CAST(:topics AS text[])" in statement
    assert params["document"] == "SOLAS"
    assert params["topics"] == ["fire"]


def test_hybrid_ranking_uses_pinned_formula_and_lowers_score_for_word_rank(monkeypatch):
    requirement_id = uuid.uuid4()
    session = FakeSession(
        hybrid_rows=[
            result_row(
                requirement_id,
                meaning_distance=0.2,
                word_search_score=0.5,
                combined_score=-0.01,
            )
        ]
    )
    monkeypatch.setattr(service, "_embed_query", lambda _query: [1 / 32] * 1024)

    results = service.search_hybrid(
        session, "fire containment", 5, {"ship_type": "research", "topics": ["fire"]}
    )

    assert results[0].combined_score == -0.01
    assert results[0].ranking_score == -0.01
    assert results[0].meaning_distance == 0.2
    assert results[0].similarity_score == 0.8
    assert results[0].word_search_score == 0.5
    statement, params = session.statements[1]
    assert "0.7 * (p.embedding OPERATOR(extensions.<=>)" in statement
    assert "- 0.3 * (ts_rank(p.search_tsv, plainto_tsquery('english', :query)))" in statement
    assert statement.index("AND (cardinality(i.applies_to)") < statement.index("ORDER BY combined_score")
    assert "extensions.vector(1024)" in statement
    assert params["ship_type"] == "research"
    assert params["topics"] == ["fire"]


def test_vector_search_fails_with_exact_admin_grant_when_schema_usage_missing(monkeypatch):
    session = FakeSession(
        permissions={
            "role_name": "shipdesign_app",
            "schema_usage": False,
            "embedding_select": True,
            "schema_grant": 'GRANT USAGE ON SCHEMA extensions TO "shipdesign_app";',
        }
    )
    monkeypatch.setattr(service, "_embed_query", lambda _query: [1 / 32] * 1024)

    with pytest.raises(service.VectorSearchUnavailable, match="GRANT USAGE ON SCHEMA extensions"):
        service.search_vector(session, "fire", 5, {})

    assert len(session.statements) == 1


def test_embedder_interface_rejects_non_normalized_vectors():
    class FakeEmbedder:
        def embed(self, _query):
            return [0.0] * 1024

    with pytest.raises(service.EmbeddingProviderError, match="L2-normalized"):
        service._validate_embedding(FakeEmbedder().embed("query"))


def test_bge_embedder_loads_pinned_local_encoder_and_normalizes(monkeypatch):
    calls = {}

    class Encoded:
        def tolist(self):
            return [1 / 32] * 1024

    class FakeSentenceTransformer:
        def __init__(self, model, **kwargs):
            calls["model"] = model
            calls.update(kwargs)

        def encode(self, query, **kwargs):
            calls["query"] = query
            calls["encode"] = kwargs
            return Encoded()

    monkeypatch.setitem(
        sys.modules, "sentence_transformers", SimpleNamespace(SentenceTransformer=FakeSentenceTransformer)
    )
    embedding = service.BgeM3Embedder().embed("original-language engineering query")

    assert len(embedding) == 1024
    assert calls["model"] == "BAAI/bge-m3"
    assert calls["revision"] == "5617a9f61b028005a4858fdac845db406aefb181"
    assert calls["device"] == settings.embedding_device
    assert calls["encode"]["normalize_embeddings"] is True
    assert calls["query"] == "original-language engineering query"


def test_requirement_mapping_keeps_canonical_clause_and_availability():
    requirement_id = uuid.uuid4()
    row = result_row(requirement_id)
    session = FakeSession(full_text_rows=[row])
    requirement = service._to_requirement(row, method="lookup")

    assert requirement.id == requirement_id
    assert requirement.instrument_id == row["instrument_id"]
    assert requirement.text == "Requirement evidence text"
    assert requirement.clause_reference == "9.2.1"
    assert requirement.instrument_applicability == ["cruise", "research"]
    assert requirement.source_availability == "summary"
