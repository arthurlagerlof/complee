import math
import json
import uuid
from functools import lru_cache
from typing import Any, Protocol

from sqlalchemy import Uuid, bindparam, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import validate_sql_identifier
from app.schemas.regulation import (
    InstrumentOut,
    LegacyDesignFactOut,
    RequirementOut,
    RetrievalFindingOut,
)


class EmbeddingProviderError(RuntimeError):
    pass


class VectorSearchUnavailable(RuntimeError):
    pass


class QueryEmbedder(Protocol):
    def embed(self, query: str) -> list[float]: ...


class BgeM3Embedder:
    def __init__(self) -> None:
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise EmbeddingProviderError(
                "Local semantic search requires sentence-transformers==6.2.0 and its PyTorch dependency. "
                "Install the optional retrieval dependencies and cache the configured BGE-M3 snapshot."
            ) from exc
        try:
            self._model = SentenceTransformer(
                settings.embedding_model,
                revision=settings.embedding_model_revision,
                device=settings.embedding_device,
                cache_folder=settings.embedding_cache_folder,
            )
        except (OSError, ValueError, RuntimeError) as exc:
            raise EmbeddingProviderError(
                "The configured BGE-M3 model snapshot could not be loaded. "
                "Check the local model cache, revision, and embedding device."
            ) from exc

    def embed(self, query: str) -> list[float]:
        try:
            encoded = self._model.encode(
                query,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            values = [float(value) for value in encoded.tolist()]
        except (ValueError, TypeError, RuntimeError) as exc:
            raise EmbeddingProviderError("The local BGE-M3 encoder could not embed the query.") from exc
        _validate_embedding(values)
        return values


def _validate_embedding(values: list[float]) -> None:
    if len(values) != settings.regulatory_vector_dimension:
        raise EmbeddingProviderError(
            f"The configured BGE-M3 encoder must return {settings.regulatory_vector_dimension} dimensions."
        )
    if not all(math.isfinite(value) for value in values):
        raise EmbeddingProviderError("The BGE-M3 encoder returned non-finite vector values.")
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isclose(norm, 1.0, rel_tol=1e-3, abs_tol=1e-3):
        raise EmbeddingProviderError("The BGE-M3 query embedding is not L2-normalized.")


@lru_cache(maxsize=1)
def _local_embedder() -> QueryEmbedder:
    return BgeM3Embedder()


def _embed_query(query: str, embedder: QueryEmbedder | None = None) -> list[float]:
    return (embedder or _local_embedder()).embed(query)


def _relation(table: str) -> str:
    return f'"{validate_sql_identifier("public")}"."{validate_sql_identifier(table)}"'


def _select_columns() -> str:
    return """
        SELECT p.id AS id,
               p.instrument_id AS instrument_id,
               p.body AS text,
               i.name AS regulatory_document,
               i.code AS document_code,
               p.edition AS edition,
               p.heading_path AS chapter,
               p.clause_key AS clause_reference,
               p.language AS language,
               p.applicability AS applicability,
               i.applies_to AS instrument_applicability,
               i.source_url AS source_url,
               i.authority AS authority,
               i.availability AS source_availability,
               i.note AS document_note,
               p.availability AS provision_availability
    """


def _base_from() -> str:
    return (
        f"FROM {_relation('provisions')} AS p "
        f"JOIN {_relation('instruments')} AS i ON i.id = p.instrument_id"
    )


def _filter_clause(filters: dict[str, Any], params: dict[str, Any]) -> str:
    clauses: list[str] = []
    if filters.get("document"):
        clauses.append("(i.code = :document OR i.name ILIKE :document_like)")
        params["document"] = filters["document"]
        params["document_like"] = f"%{filters['document']}%"
    for key, column in (
        ("edition", "p.edition"),
        ("chapter", "p.heading_path"),
        ("clause", "p.clause_key"),
    ):
        if filters.get(key):
            parameter = f"{key}_like"
            clauses.append(f"{column} ILIKE :{parameter}")
            params[parameter] = f"%{filters[key]}%"
    if filters.get("ship_type"):
        clauses.append("(cardinality(i.applies_to) = 0 OR :ship_type = ANY(i.applies_to))")
        params["ship_type"] = filters["ship_type"]
    if filters.get("topics"):
        clauses.append(
            "(cardinality(p.applicability) = 0 OR p.applicability && CAST(:topics AS text[]))"
        )
        params["topics"] = filters["topics"]
    return " AND ".join(clauses) if clauses else "TRUE"


def _to_requirement(
    row: dict[str, Any],
    *,
    meaning_distance: float | None = None,
    word_search_score: float | None = None,
    combined_score: float | None = None,
    method: str | None = None,
) -> RequirementOut:
    applicability = _text_array(row.get("applicability"))
    instrument_applicability = _text_array(row.get("instrument_applicability"))
    metadata = {
        key: row.get(key)
        for key in ("authority", "document_note")
        if row.get(key) is not None
    }
    if meaning_distance is not None:
        metadata["meaning_distance"] = meaning_distance
    if word_search_score is not None:
        metadata["word_search_score"] = word_search_score
    explanation = None
    if combined_score is not None:
        explanation = (
            "Candidate ranked by the existing weighted score "
            "(0.7 × cosine distance − 0.3 × English full-text rank); lower scores rank higher. "
            "This is relevance, not a determination of regulatory applicability or compliance."
        )
    elif method == "full_text":
        explanation = (
            "Candidate matched English PostgreSQL full-text search. "
            "This is relevance, not a determination of regulatory applicability or compliance."
        )
    elif method == "vector":
        explanation = (
            "Candidate ranked by exact cosine distance. "
            "This is relevance, not a determination of regulatory applicability or compliance."
        )
    return RequirementOut(
        id=row["id"],
        instrument_id=row["instrument_id"],
        text=row["text"],
        regulatory_document=row.get("regulatory_document"),
        document_code=row.get("document_code"),
        edition=row.get("edition"),
        chapter=row.get("chapter"),
        clause_reference=row.get("clause_reference"),
        language=row.get("language"),
        applicability=applicability,
        instrument_applicability=instrument_applicability,
        source_availability=row.get("source_availability"),
        provision_availability=row.get("provision_availability"),
        source_url=row.get("source_url"),
        similarity_score=(
            round(1.0 - meaning_distance, 6) if meaning_distance is not None else None
        ),
        meaning_distance=(
            round(meaning_distance, 6) if meaning_distance is not None else None
        ),
        word_search_score=(
            round(word_search_score, 6) if word_search_score is not None else None
        ),
        combined_score=round(combined_score, 6) if combined_score is not None else None,
        ranking_score=round(combined_score, 6) if combined_score is not None else None,
        retrieval_method=method,
        retrieval_explanation=explanation,
        metadata=metadata,
    )


def _text_array(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("A legacy PostgreSQL text[] value was not returned as a valid array.") from exc
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("A legacy PostgreSQL text[] column contained an unexpected value.")
    return value


def _rows(session: Session, statement: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(row) for row in session.execute(text(statement), params).mappings()]


def get_requirement(session: Session, requirement_id: uuid.UUID) -> RequirementOut | None:
    statement = text(
        f"{_select_columns()} {_base_from()} WHERE p.id = :requirement_id"
    ).bindparams(bindparam("requirement_id", type_=Uuid(as_uuid=True)))
    row = session.execute(statement, {"requirement_id": requirement_id}).mappings().first()
    return _to_requirement(dict(row), method="lookup") if row else None


def get_instrument(session: Session, instrument_id: uuid.UUID) -> InstrumentOut | None:
    statement = text(
        f"""
        SELECT id, code, name, authority, availability, source_url, note, applies_to
        FROM {_relation('instruments')}
        WHERE id = :instrument_id
        """
    ).bindparams(bindparam("instrument_id", type_=Uuid(as_uuid=True)))
    row = session.execute(statement, {"instrument_id": instrument_id}).mappings().first()
    if row is None:
        return None
    data = dict(row)
    data["applies_to"] = _text_array(data["applies_to"])
    return InstrumentOut(**data)


def get_retrieval_finding(
    session: Session, finding_id: uuid.UUID
) -> RetrievalFindingOut | None:
    statement = text(
        f"""
        SELECT id, design_fact_id, provision_id, why, clause_key, heading_path, body, availability
        FROM {_relation('findings')}
        WHERE id = :finding_id
        """
    ).bindparams(bindparam("finding_id", type_=Uuid(as_uuid=True)))
    row = session.execute(statement, {"finding_id": finding_id}).mappings().first()
    return RetrievalFindingOut(**dict(row)) if row else None


def get_legacy_design_fact(
    session: Session, fact_id: uuid.UUID
) -> LegacyDesignFactOut | None:
    statement = text(
        f"""
        SELECT id, kind, name, deck, value, source_file
        FROM {_relation('design_facts')}
        WHERE id = :fact_id
        """
    ).bindparams(bindparam("fact_id", type_=Uuid(as_uuid=True)))
    row = session.execute(statement, {"fact_id": fact_id}).mappings().first()
    return LegacyDesignFactOut(**dict(row)) if row else None


def list_legacy_design_facts(session: Session, limit: int) -> list[LegacyDesignFactOut]:
    statement = f"""
        SELECT id, kind, name, deck, value, source_file
        FROM {_relation('design_facts')}
        ORDER BY id
        LIMIT :limit
    """
    return [LegacyDesignFactOut(**row) for row in _rows(session, statement, {"limit": limit})]


def list_retrieval_findings(
    session: Session, design_fact_id: uuid.UUID | None, limit: int
) -> list[RetrievalFindingOut]:
    params: dict[str, Any] = {"limit": limit}
    where = ""
    if design_fact_id is not None:
        where = "WHERE design_fact_id = :design_fact_id"
        params["design_fact_id"] = design_fact_id
    statement = f"""
        SELECT id, design_fact_id, provision_id, why, clause_key, heading_path, body, availability
        FROM {_relation('findings')}
        {where}
        ORDER BY id
        LIMIT :limit
    """
    return [RetrievalFindingOut(**row) for row in _rows(session, statement, params)]


def _check_vector_permissions(session: Session) -> None:
    schema = validate_sql_identifier(settings.pgvector_schema)
    row = session.execute(
        text(
            """
            SELECT current_user AS role_name,
                   has_schema_privilege(current_user, :schema, 'USAGE') AS schema_usage,
                   has_column_privilege(current_user, 'public.provisions', 'embedding', 'SELECT')
                       AS embedding_select,
                   format('GRANT USAGE ON SCHEMA %I TO %I;', :schema, current_user) AS schema_grant
            """
        ),
        {"schema": schema},
    ).mappings().one()
    missing: list[str] = []
    if not row["schema_usage"]:
        missing.append(row["schema_grant"])
    if not row["embedding_select"]:
        missing.append(
            f"GRANT SELECT (embedding) ON TABLE public.provisions TO "
            f'"{str(row["role_name"]).replace(chr(34), chr(34) * 2)}";'
        )
    if missing:
        grants = " ".join(missing)
        raise VectorSearchUnavailable(
            f"Vector search is unavailable to database role {row['role_name']!r}; required administrator grant(s): "
            f"{grants}"
        )


def _vector_text(query: str) -> str:
    vector = _embed_query(query)
    return "[" + ",".join(format(value, ".9g") for value in vector) + "]"


def _vector_cast() -> str:
    schema = validate_sql_identifier(settings.pgvector_schema)
    dimension = settings.regulatory_vector_dimension
    if not 1 <= dimension <= 65535:
        raise ValueError("The configured regulatory vector dimension is invalid.")
    return f"{schema}.vector({dimension})"


def search_full_text(
    session: Session, query: str, limit: int, filters: dict[str, Any]
) -> list[RequirementOut]:
    query = query.strip()
    if not query:
        return []
    params: dict[str, Any] = {"query": query, "limit": limit}
    clause = _filter_clause(filters, params)
    statement = f"""
        {_select_columns()},
        ts_rank(p.search_tsv, plainto_tsquery('english', :query)) AS word_search_score
        {_base_from()}
        WHERE p.search_tsv @@ plainto_tsquery('english', :query)
          AND {clause}
        ORDER BY word_search_score DESC, p.id
        LIMIT :limit
    """
    return [
        _to_requirement(row, word_search_score=row["word_search_score"], method="full_text")
        for row in _rows(session, statement, params)
    ]


def search_vector(
    session: Session, query: str, limit: int, filters: dict[str, Any]
) -> list[RequirementOut]:
    query = query.strip()
    if not query:
        return []
    _check_vector_permissions(session)
    vector = _vector_text(query)
    params: dict[str, Any] = {"query_vector": vector, "limit": limit}
    clause = _filter_clause(filters, params)
    cast = _vector_cast()
    vector_schema = validate_sql_identifier(settings.pgvector_schema)
    statement = f"""
        {_select_columns()},
        p.embedding OPERATOR({vector_schema}.<=>)
            CAST(:query_vector AS {cast}) AS meaning_distance
        {_base_from()}
        WHERE p.embedding IS NOT NULL AND {clause}
        ORDER BY p.embedding OPERATOR({vector_schema}.<=>)
            CAST(:query_vector AS {cast}), p.id
        LIMIT :limit
    """
    try:
        rows = _rows(session, statement, params)
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) == "42501":
            raise VectorSearchUnavailable(
                "The database role cannot access the configured pgvector operator or embedding column. "
                f"An administrator must grant USAGE ON SCHEMA {settings.pgvector_schema} and SELECT on "
                "public.provisions.embedding."
            ) from exc
        raise
    return [
        _to_requirement(row, meaning_distance=row["meaning_distance"], method="vector") for row in rows
    ]


def search_hybrid(
    session: Session, query: str, limit: int, filters: dict[str, Any]
) -> list[RequirementOut]:
    query = query.strip()
    if not query:
        return []
    _check_vector_permissions(session)
    vector = _vector_text(query)
    params: dict[str, Any] = {"query": query, "query_vector": vector, "limit": limit}
    clause = _filter_clause(filters, params)
    vector_schema = validate_sql_identifier(settings.pgvector_schema)
    cast = _vector_cast()
    distance = (
        f"p.embedding OPERATOR({vector_schema}.<=>) "
        f"CAST(:query_vector AS {cast})"
    )
    word_rank = "ts_rank(p.search_tsv, plainto_tsquery('english', :query))"
    statement = f"""
        {_select_columns()},
        {distance} AS meaning_distance,
        {word_rank} AS word_search_score,
        0.7 * ({distance}) - 0.3 * ({word_rank}) AS combined_score
        {_base_from()}
        WHERE p.embedding IS NOT NULL AND {clause}
        ORDER BY combined_score ASC, p.id
        LIMIT :limit
    """
    try:
        rows = _rows(session, statement, params)
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) == "42501":
            raise VectorSearchUnavailable(
                "The database role cannot access the configured pgvector operator or embedding column. "
                f"An administrator must grant USAGE ON SCHEMA {settings.pgvector_schema} and SELECT on "
                "public.provisions.embedding."
            ) from exc
        raise
    return [
        _to_requirement(
            row,
            meaning_distance=row["meaning_distance"],
            word_search_score=row["word_search_score"],
            combined_score=row["combined_score"],
            method="hybrid",
        )
        for row in rows
    ]


def search_regulations(
    session: Session,
    query: str,
    limit: int,
    filters: dict[str, Any],
    mode: str = "hybrid",
) -> tuple[list[RequirementOut], bool]:
    searchers = {
        "hybrid": search_hybrid,
        "vector": search_vector,
        "full_text": search_full_text,
    }
    try:
        searcher = searchers[mode]
    except KeyError as exc:
        raise ValueError("Search mode must be 'hybrid', 'vector', or 'full_text'.") from exc
    return searcher(session, query, limit, filters), mode in {"hybrid", "vector"}
