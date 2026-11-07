"""Ship engineering knowledge layer.

A structured catalogue (catalogue.json) of component types with expected properties and relationships, maritime
abbreviations (ambiguous ones flagged), tag conventions, unit conversions and regulatory terminology. It gives the
AI the engineering context it needs to interpret a source instead of guessing from a name or a shape, and it links
component types to the regulatory provision retrieval (official definitions and clauses come from the regulation
database by clause key; the catalogue itself holds no regulatory limit values and no project data).
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session

CATALOGUE_PATH = Path(__file__).with_name("catalogue.json")
NON_CONVERTIBLE_UNITS = {"degC", "ratio", "count", "persons", "rpm", "V", "A"}


class PropertySpec(BaseModel):
    name: str
    quantity: str
    unit: str | None = None
    required: bool = False
    examples: list[str] = Field(default_factory=list)
    description: str | None = None


class ClauseRef(BaseModel):
    document: str
    clause_prefix: str


class RegulatoryLink(BaseModel):
    topics: list[str] = Field(default_factory=list)
    terms: list[str] = Field(default_factory=list)
    documents: list[str] = Field(default_factory=list)
    clauses: list[ClauseRef] = Field(default_factory=list)
    definitions: list[str] = Field(default_factory=list)


class ComponentType(BaseModel):
    id: str
    name: str
    category: str
    parent: str | None = None
    synonyms: list[str] = Field(default_factory=list)
    abbreviations: list[str] = Field(default_factory=list)
    # Tokens that together indicate the type anywhere in a name, e.g. ["FO", "TK"] in "FO SERVICE TK 3 (P)".
    token_sets: list[list[str]] = Field(default_factory=list)
    properties: list[PropertySpec]
    relationships: list[str] = Field(default_factory=list)
    regulatory: RegulatoryLink = Field(default_factory=RegulatoryLink)


class Abbreviation(BaseModel):
    abbr: str
    meanings: list[str]
    ambiguous: bool = False


class Catalogue(BaseModel):
    version: str
    scope_note: str
    categories: list[dict[str, Any]]
    relationship_types: list[dict[str, Any]]
    component_types: list[ComponentType]
    abbreviations: list[Abbreviation]
    regulatory_terms: list[dict[str, str]]
    units: dict[str, Any]
    tag_conventions: list[dict[str, str]]

    @model_validator(mode="after")
    def _consistent(self) -> "Catalogue":
        type_ids = [t.id for t in self.component_types]
        if len(type_ids) != len(set(type_ids)):
            raise ValueError("duplicate component type id")
        categories = {c["id"] for c in self.categories}
        relationship_ids = {r["id"] for r in self.relationship_types} | {r["inverse"] for r in self.relationship_types}
        units = set(self.units["factors"]) | NON_CONVERTIBLE_UNITS | set(self.units["canonical"].values())
        for t in self.component_types:
            if t.category not in categories:
                raise ValueError(f"{t.id}: unknown category {t.category}")
            if t.parent and t.parent not in type_ids:
                raise ValueError(f"{t.id}: unknown parent {t.parent}")
            for r in t.relationships:
                if r not in relationship_ids:
                    raise ValueError(f"{t.id}: unknown relationship {r}")
            for p in t.properties:
                if p.unit and p.unit not in units:
                    raise ValueError(f"{t.id}.{p.name}: unknown unit {p.unit}")
            for ref in t.regulatory.definitions:
                _split_ref(ref)
        abbrs = [a.abbr for a in self.abbreviations]
        if len(abbrs) != len(set(abbrs)):
            raise ValueError("duplicate abbreviation")
        for c in self.tag_conventions:
            re.compile(c["pattern"])
        return self


def _split_ref(ref: str) -> tuple[str, str]:
    """'SOLAS II-2/3/31' -> ('SOLAS', 'II-2/3/31')."""
    code, _, clause = ref.partition(" ")
    if not code or not clause:
        raise ValueError(f"invalid clause reference {ref!r}")
    return code, clause


@lru_cache(maxsize=1)
def catalogue() -> Catalogue:
    return Catalogue.model_validate(json.loads(CATALOGUE_PATH.read_text(encoding="utf-8")))


def component_type(type_id: str) -> ComponentType | None:
    return next((t for t in catalogue().component_types if t.id == type_id), None)


def _phrase_in(phrase: str, haystack: str) -> bool:
    # Word-boundary match that tolerates "-", "_", "/" and digits next to the phrase (e.g. "TK3", "FO-TK").
    return re.search(r"(?<![A-Za-z])" + re.escape(phrase.lower()) + r"(?![A-Za-z])", haystack) is not None


def match_component_types(source: str, limit: int = 8) -> list[dict[str, Any]]:
    """Component types a text appears to mention, by synonym (score 3) and abbreviation (score 2) matches.
    A hint for interpretation only, never a classification."""
    haystack = source.lower()
    tokens = set(re.findall(r"[A-Z0-9]+(?:-[0-9]+)?", source.upper()))
    out = []
    for t in catalogue().component_types:
        matched, score = [], 0
        for s in t.synonyms:
            if _phrase_in(s, haystack):
                matched.append(s)
                score += 3
        for a in t.abbreviations:
            hit = _phrase_in(a, haystack) if " " in a else a.upper() in tokens
            if hit and len(a) > 1:  # single letters (P, V, L) are too ambiguous on their own
                matched.append(a)
                score += 2
        for token_set in t.token_sets:
            if all(tok in tokens for tok in token_set) and " ".join(token_set).lower() not in {x.lower() for x in matched}:
                matched.append(" + ".join(token_set))
                score += 3
        if score:
            out.append({"id": t.id, "name": t.name, "score": score, "matched": matched})
    out.sort(key=lambda m: (-m["score"], m["id"]))
    # Prefer the specific type when it and its parent both match (fuel tank over tank).
    ids = {m["id"] for m in out}
    for m in out:
        child = next((t for t in catalogue().component_types if t.parent == m["id"] and t.id in ids), None)
        if child:
            m["more_specific"] = child.id
    return out[:limit]


def find_abbreviations(source: str) -> list[dict[str, Any]]:
    tokens = set(re.findall(r"[A-Z][A-Z0-9-]*", source))
    found = []
    for a in catalogue().abbreviations:
        if a.abbr in tokens and (len(a.abbr) > 1 or re.search(r"\(" + re.escape(a.abbr) + r"\)", source)):
            found.append(a.model_dump())
    return found


def parse_tag(tag: str) -> dict[str, Any] | None:
    for c in catalogue().tag_conventions:
        m = re.match(c["pattern"], tag.strip())
        if m:
            return {"convention": c["id"], "parts": {k: v for k, v in m.groupdict().items() if v}, "note": c["note"]}
    return None


def convert(value: float, unit: str) -> dict[str, Any] | None:
    """Converts a value to the canonical unit of its quantity (mm, m2, m3, kPa, degC, kg, kW, m3/h, deg).
    Returns None for an unknown unit; never guesses."""
    units = catalogue().units
    key = units["aliases"].get(unit.strip().lower(), unit.strip())
    if key == "degC":
        return {"value": value, "unit": "degC", "quantity": "temperature"}
    if key == "degF":
        return {"value": round((value - 32) * 5 / 9, 6), "unit": "degC", "quantity": "temperature"}
    if key not in units["factors"]:
        return None
    quantity, factor = units["factors"][key]
    return {"value": round(value * factor, 9), "unit": units["canonical"][quantity], "quantity": quantity}


def definitions(session: Session | None, refs: list[str]) -> dict[str, str]:
    """Official definition texts from the regulation database by clause reference ('SOLAS II-2/3/31').
    Read-only; returns {} when the database or the tables are not available."""
    if session is None or not refs:
        return {}
    wanted: dict[str, set[str]] = {}
    for ref in refs:
        code, clause = _split_ref(ref)
        wanted.setdefault(code, set()).add(clause)
    out: dict[str, str] = {}
    try:
        with session.begin_nested():
            for code, clauses in wanted.items():
                rows = session.execute(
                    text(
                        "SELECT p.clause_key, p.body FROM public.provisions p "
                        "JOIN public.instruments i ON i.id = p.instrument_id "
                        "WHERE i.code = :code AND p.clause_key IN :clauses"
                    ).bindparams(bindparam("clauses", expanding=True)),
                    {"code": code, "clauses": sorted(clauses)},
                ).all()
                for clause_key, body in rows:
                    out[f"{code} {clause_key}"] = body
    except Exception:  # noqa: BLE001 - the context is optional; a missing database must not block extraction
        return {}
    return out


def context_for_source(source: str, session: Session | None = None, max_chars: int = 6000) -> str:
    """Engineering reference context for an AI interpretation prompt: the component types the source appears to
    mention with their expected properties and relationships, the abbreviations it uses (ambiguous ones flagged),
    the relationship vocabulary, unit conventions and official definitions of the regulatory terms involved."""
    cat = catalogue()
    matches = match_component_types(source)
    lines = [
        "ENGINEERING REFERENCE CONTEXT (background knowledge from the ship engineering catalogue "
        f"{cat.version}; it is not evidence from the source and must never be used as a source value)."
    ]
    if matches:
        lines.append("Component types the source may mention (hints, not classifications):")
        for m in matches:
            t = component_type(m["id"])
            props = ", ".join(f"{p.name}{f' [{p.unit}]' if p.unit else ''}{' (key)' if p.required else ''}" for p in t.properties)
            lines.append(f"- {t.name} (type id {t.id}; matched {', '.join(m['matched'])}): expected properties {props}; "
                         f"typical relationships {', '.join(t.relationships)}.")
    abbreviations = find_abbreviations(source)
    if abbreviations:
        lines.append("Abbreviations found in the source:")
        for a in abbreviations:
            meaning = " OR ".join(a["meanings"])
            lines.append(f"- {a['abbr']} = {meaning}" + (" (ambiguous: decide only from explicit evidence, otherwise keep it uncertain)" if a["ambiguous"] else ""))
    lines.append("Relationship vocabulary: " + "; ".join(f"{r['id']} ({r['description']})" for r in cat.relationship_types))
    lines.append("Units: keep the source value and unit as written; canonical units are "
                 + ", ".join(f"{q} {u}" for q, u in cat.units["canonical"].items()) + ".")
    refs = sorted({ref for m in matches for ref in component_type(m["id"]).regulatory.definitions})
    defs = definitions(session, refs)
    if defs:
        lines.append("Official definitions from the regulation database:")
        for ref, body in defs.items():
            lines.append(f"- {ref}: {body[:400]}")
    context = "\n".join(lines)
    return context if len(context) <= max_chars else context[: max_chars - 15] + "\n[truncated]"


def regulations_for_type(session: Session, type_id: str, limit: int = 10) -> dict[str, Any]:
    """Regulatory provisions for a component type: the clauses the catalogue links (by clause-key prefix) and
    full-text matches for its regulatory terms. Candidates for review, not applicability decisions."""
    from app.services.retrieval.service import search_regulations  # local import: retrieval needs the DB stack

    t = component_type(type_id)
    if t is None:
        raise KeyError(type_id)
    linked: list[dict[str, Any]] = []
    with session.begin_nested():
        for ref in t.regulatory.clauses:
            rows = session.execute(
                text(
                    "SELECT p.id, i.code, p.clause_key, p.heading_path, p.body FROM public.provisions p "
                    "JOIN public.instruments i ON i.id = p.instrument_id "
                    "WHERE i.code = :code AND p.clause_key LIKE :prefix ORDER BY p.clause_key LIMIT :limit"
                ),
                {"code": ref.document, "prefix": f"{ref.clause_prefix}%", "limit": limit},
            ).all()
            linked += [{"provision_id": str(r[0]), "document_code": r[1], "clause": r[2], "heading": r[3], "text": r[4]} for r in rows]
    searched: dict[str, Any] = {}
    for term in t.regulatory.terms[:4]:
        try:
            with session.begin_nested():  # a failed search must not abort the surrounding transaction
                results, _ = search_regulations(session, term, limit, {"topics": t.regulatory.topics or None}, "full_text")
        except Exception:  # noqa: BLE001 - full-text search needs PostgreSQL; report linked clauses regardless
            break
        for r in results:
            searched.setdefault(str(r.id), {"provision_id": str(r.id), "document_code": r.document_code, "clause": r.clause_reference, "text": r.text, "matched_term": term})
    return {
        "component_type": t.id,
        "terms": t.regulatory.terms,
        "topics": t.regulatory.topics,
        "linked_clauses": linked[: limit * 2],
        "term_matches": list(searched.values())[:limit],
        "note": "Candidate provisions for engineer review; retrieval does not decide applicability or compliance.",
    }
