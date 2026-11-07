import math
import re
import uuid
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import validate_sql_identifier
from app.schemas.regulation import RequirementOut


class EmbeddingProviderError(Exception):
    pass


def _relation() -> str:
    schema = validate_sql_identifier(settings.regulatory_schema)
    table = validate_sql_identifier(settings.regulatory_table)
    return f'"{schema}"."{table}"'


def _column(value: str) -> str:
    return f'"{validate_sql_identifier(value)}"'


def _select_columns() -> str:
    relation = _relation()
    id_column = _column(settings.regulatory_id_column)
    body_column = _column(settings.regulatory_text_column)
    return f"""
        SELECT p.{id_column} AS id,
               p.{body_column} AS text,
               i.name AS regulatory_document,
               i.code AS document_code,
               p.edition AS edition,
               p.heading_path AS chapter,
               p.clause_key AS clause_reference,
               NULL::integer AS page_number,
               p.language AS language,
               p.applicability AS applicability,
               i.source_url AS source_url,
               i.authority AS authority,
               i.availability AS document_availability,
               i.note AS document_note,
               p.availability AS requirement_availability
    """


def _base_from() -> str:
    return f"FROM {_relation()} AS p LEFT JOIN public.instruments AS i ON i.id = p.instrument_id"


def _base_select() -> str:
    return f"{_select_columns()} {_base_from()}"


def _filter_clause() -> str:
    return """
        (:document IS NULL OR i.code = :document OR i.name ILIKE :document_like)
        AND (:edition IS NULL OR p.edition ILIKE :edition_like)
        AND (:chapter IS NULL OR p.heading_path ILIKE :chapter_like)
        AND (:clause IS NULL OR p.clause_key ILIKE :clause_like)
    """


def _filter_params(filters: dict[str, str | None]) -> dict[str, Any]:
    return {
        "document": filters.get("document"),
        "document_like": f"%{filters['document']}%" if filters.get("document") else None,
        "edition": filters.get("edition"),
        "edition_like": f"%{filters['edition']}%" if filters.get("edition") else None,
        "chapter": filters.get("chapter"),
        "chapter_like": f"%{filters['chapter']}%" if filters.get("chapter") else None,
        "clause": filters.get("clause"),
        "clause_like": f"%{filters['clause']}%" if filters.get("clause") else None,
    }


def get_requirement(session: Session, requirement_id: uuid.UUID) -> RequirementOut | None:
    statement = text(f"{_base_select()} WHERE p.{_column(settings.regulatory_id_column)} = :requirement_id")
    row = session.execute(statement, {"requirement_id": requirement_id}).mappings().first()
    return _to_requirement(dict(row), None, None) if row else None


def _embed_query(query: str) -> list[float]:
    if not settings.embedding_api_url:
        raise EmbeddingProviderError("Semantic retrieval is not configured.")
    headers = {"Authorization": f"Bearer {settings.embedding_api_key}"} if settings.embedding_api_key else {}
    try:
        response = httpx.post(
            settings.embedding_api_url,
            headers=headers,
            json={"model": settings.embedding_model, "input": query},
            timeout=30,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise EmbeddingProviderError("The configured embedding provider could not process the query.") from exc
    try:
        payload = response.json()
        vector = payload["data"][0]["embedding"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise EmbeddingProviderError("The embedding provider returned an invalid response.") from exc
    if not isinstance(vector, list) or len(vector) != settings.regulatory_vector_dimension:
        raise EmbeddingProviderError(
            f"The embedding provider must return {settings.regulatory_vector_dimension} dimensions."
        )
    try:
        values = [float(value) for value in vector]
    except (TypeError, ValueError) as exc:
        raise EmbeddingProviderError("The embedding provider returned non-numeric vector values.") from exc
    if not all(math.isfinite(value) for value in values):
        raise EmbeddingProviderError("The embedding provider returned non-finite vector values.")
    return values


def _to_requirement(
    row: dict[str, Any], ranking_score: float | None, method: str | None
) -> RequirementOut:
    metadata = {
        key: row.get(key)
        for key in ("authority", "document_availability", "document_note", "requirement_availability")
        if row.get(key) is not None
    }
    return RequirementOut(
        id=row["id"],
        text=row["text"],
        regulatory_document=row.get("regulatory_document"),
        document_code=row.get("document_code"),
        edition=row.get("edition"),
        chapter=row.get("chapter"),
        clause_reference=row.get("clause_reference"),
        page_number=row.get("page_number"),
        language=row.get("language"),
        applicability=row.get("applicability"),
        source_url=row.get("source_url"),
        ranking_score=ranking_score,
        retrieval_method=method,
        metadata=metadata,
    )


def merge_ranked_results(
    semantic_rows: list[dict[str, Any]], full_text_rows: list[dict[str, Any]], limit: int
) -> list[RequirementOut]:
    ranked: dict[str, dict[str, Any]] = {}
    for method, rows in (("semantic", semantic_rows), ("full_text", full_text_rows)):
        for rank, row in enumerate(rows, start=1):
            requirement_id = str(row["id"])
            item = ranked.setdefault(requirement_id, {"row": row, "score": 0.0, "methods": []})
            item["score"] += 1 / (60 + rank)
            item["methods"].append(method)
            if method == "semantic":
                item["row"] = row
    ordered = sorted(ranked.values(), key=lambda item: item["score"], reverse=True)[:limit]
    return [
        _to_requirement(
            item["row"],
            round(item["score"], 6),
            "+".join(item["methods"]),
        )
        for item in ordered
    ]


def search_regulations(
    session: Session,
    query: str,
    limit: int,
    filters: dict[str, str | None],
) -> tuple[list[RequirementOut], bool]:
    query = query.strip()
    if not query:
        return [], bool(settings.embedding_api_url)
    base = _base_select()
    params = _filter_params(filters)
    params["query"] = query
    params["limit"] = limit
    full_text_statement = text(
        f"""
        {base}
        WHERE p.search_tsv @@ plainto_tsquery('simple', :query)
          AND {_filter_clause()}
        ORDER BY ts_rank(p.search_tsv, plainto_tsquery('simple', :query)) DESC,
                 p.{_column(settings.regulatory_id_column)}
        LIMIT :limit
        """
    )
    full_text_rows = [dict(row) for row in session.execute(full_text_statement, params).mappings()]

    semantic_rows: list[dict[str, Any]] = []
    if settings.embedding_api_url:
        vector = _embed_query(query)
        vector_text = "[" + ",".join(format(value, ".9g") for value in vector) + "]"
        vector_column = _column(settings.regulatory_embedding_column)
        vector_schema = validate_sql_identifier(settings.pgvector_schema)
        semantic_statement = text(
            f"""
            {_select_columns()},
                   1 - (p.{vector_column} OPERATOR({vector_schema}.<=>)
                       CAST(:query_vector AS {vector_schema}.vector({settings.regulatory_vector_dimension})))
                       AS vector_similarity
            {_base_from()}
            WHERE p.{vector_column} IS NOT NULL
              AND {_filter_clause()}
            ORDER BY p.{vector_column} OPERATOR({vector_schema}.<=>)
                     CAST(:query_vector AS {vector_schema}.vector({settings.regulatory_vector_dimension}))
            LIMIT :limit
            """
        )
        semantic_params = {**params, "query_vector": vector_text}
        semantic_rows = [
            dict(row) for row in session.execute(semantic_statement, semantic_params).mappings()
        ]
    return merge_ranked_results(semantic_rows, full_text_rows, limit), bool(settings.embedding_api_url)
