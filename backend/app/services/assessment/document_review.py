"""Gemini-assisted comparison of document passages with TigerData provisions."""

from __future__ import annotations

import json
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator
from sqlalchemy.orm import Session

from app.ai.schemas import GenerationRequest
from app.ai.providers import AIProviderResponseError
from app.services import ai
from app.services.retrieval.service import search_regulations


class _ReviewSchema(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def null_lists_to_empty(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return {key: ([] if item is None and key in cls.model_fields and str(cls.model_fields[key].annotation).startswith("list") else item)
                    for key, item in value.items()}
        return value


class DocumentProvisionReview(_ReviewSchema):
    provision_id: str = Field(description="The exact TigerData provision UUID supplied in the prompt.")
    relevance: Literal["relevant", "uncertain", "unrelated"]
    topic: str
    summary: str
    document_quotes: list[str] = Field(default_factory=list)
    provision_quotes: list[str] = Field(default_factory=list)
    missing_information: list[str] = Field(default_factory=list)
    applicability_questions: list[str] = Field(default_factory=list)


class DocumentReviewOutput(_ReviewSchema):
    overall_summary: str
    reviews: list[DocumentProvisionReview] = Field(default_factory=list)


def _norm(value: str) -> str:
    return " ".join(value.lower().replace("“", '"').replace("”", '"').split())


def _verified_quotes(quotes: list[str], source: str) -> list[str]:
    return [quote.strip() for quote in quotes if quote.strip() and _norm(quote) in _norm(source)]


def _document_query(text: str) -> str:
    # Sample the beginning, middle, and end in one bounded query so each upload
    # performs only one full hybrid search while still representing long documents.
    size = 1800
    if len(text) <= size:
        return text
    excerpt_size = size // 3
    starts = (0, max(0, len(text) // 2 - excerpt_size // 2), max(0, len(text) - excerpt_size))
    return "\n".join(text[start:start + excerpt_size] for start in starts)


def review_document(
    session: Session,
    filename: str,
    content: str,
    extracted_characters: int,
) -> dict[str, Any]:
    provisions: dict[str, Any] = {}
    found, _ = search_regulations(session, _document_query(content), 6, {}, "hybrid")
    for item in found:
        provisions.setdefault(str(item.id), item)
    candidates = list(provisions.values())[:8]
    if not candidates:
        return {
            "filename": filename,
            "extracted_characters": extracted_characters,
            "message": "No TigerData provisions matched this document. Try a focused regulation search or check the document text.",
            "execution_id": None,
            "findings": [],
        }

    provider_id, model_id = ai._builtin_gemini_model(session)
    provision_payload = [{
        "id": str(item.id),
        "reference": item.clause_reference or item.document_code or str(item.id),
        "title": item.regulatory_document or item.document_code or "Regulatory provision",
        "edition": item.edition,
        "page": item.page_number,
        "text": item.text[:4000],
    } for item in candidates]
    generated = ai.generate(
        session,
        GenerationRequest(
            provider_id=provider_id,
            model_id=model_id,
            prompt=(
                "Compare the supplied engineering document with the TigerData regulatory provisions. "
                "For each provision, report whether it is relevant, uncertain, or unrelated; summarize the relationship; "
                "quote only exact text from the document and provision; list missing information and applicability questions. "
                "Do not decide compliance, infer facts absent from the sources, or create citations. Use the supplied provision UUIDs.\n\n"
                f"DOCUMENT ({filename}):\n{content[:18000]}\n\nTIGERDATA PROVISIONS:\n{json.dumps(provision_payload, ensure_ascii=False)}"
            ),
            system_prompt="You are a careful maritime compliance review assistant. Evidence and source fidelity take priority over completeness.",
            temperature=0,
            max_tokens=4096,
        ),
        schema=DocumentReviewOutput,
        prompt_template_version="document-tigerdata-review.v1",
        output_schema_version="document-tigerdata-review.v1",
    )
    parsed = generated.get("parsed") or {}
    if not isinstance(parsed, dict) or not isinstance(parsed.get("reviews"), list):
        raise AIProviderResponseError("Gemini did not return a valid structured document review.")
    result_by_id = {str(row.get("provision_id")): row for row in parsed.get("reviews", []) if isinstance(row, dict)}
    findings = []
    for item in candidates:
        key = str(item.id)
        review = result_by_id.get(key)
        if not review:
            continue
        doc_quotes = _verified_quotes(review.get("document_quotes") or [], content)
        provision_quotes = _verified_quotes(review.get("provision_quotes") or [], item.text)
        relevance = review.get("relevance", "uncertain")
        warnings = []
        if len(doc_quotes) != len(review.get("document_quotes") or []):
            warnings.append("One or more AI document quotations did not match the uploaded text and were omitted.")
            relevance = "uncertain"
        if len(provision_quotes) != len(review.get("provision_quotes") or []):
            warnings.append("One or more AI provision quotations did not match TigerData and were omitted.")
            relevance = "uncertain"
        findings.append({
            "topic": str(review.get("topic") or "Provision review"),
            "relevance": relevance,
            "summary": str(review.get("summary") or ""),
            "evidence": doc_quotes,
            "missing_information": review.get("missing_information") or [],
            "applicability_questions": review.get("applicability_questions") or [],
            "warnings": warnings,
            "candidates": [{
                "id": key,
                "provision_reference": item.clause_reference or item.document_code or key,
                "title": item.regulatory_document or item.document_code or "Regulatory provision",
                "text": item.text,
                "source": {"kind": "TigerData", "pages": [item.page_number] if item.page_number else [], "edition": item.edition},
                "relevance": relevance,
                "review_summary": str(review.get("summary") or ""),
                "provision_quotes": provision_quotes,
            }],
        })
    return {
        "filename": filename,
        "extracted_characters": extracted_characters,
        "message": str(parsed.get("overall_summary") or "AI-assisted source comparison complete. This is not a compliance decision."),
        "execution_id": str(generated["execution_id"]),
        "findings": findings,
    }
