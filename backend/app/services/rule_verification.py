"""Rule verification (phase 1): official sources, immutable rule versions with quoted evidence, level 1 and level 2
verification, and the derived status of every rule.

Status of a rule = status of its latest version:
  0 draft         no approved verification (a paraphrase until checked)
  1 text_checked  level 1 approved: every required field is backed by a verbatim quote found in an official source
  2 reviewed      level 2 approved by an engineer who is not the author or the level 1 checker
A new version (any change of the logic) starts again at draft. Internal data-quality checks have no official source:
their status is "internal".
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models.rule_verification import RegAudit, RegEvidence, RegRule, RegRuleVersion, RegSource, RegVerification
from app.services.extractions.adapters import SourceProcessingError, parse_source

LICENCES = ("public", "licensed_internal", "paraphrase_only")
STATUS_LABEL = {0: "draft", 1: "text_checked", 2: "reviewed"}
NUMERIC_CHECKS = {"min", "max", "count_min", "distance_min_hull"}
MIN_QUOTE_CHARS = 12


class VerificationError(ValueError):
    """A request the verification rules do not allow; the message is for the engineer."""


# ------------------------------------------------------------------ helpers

def _plain_numbers(value: Any) -> Any:
    """1.0 -> 1, so the hash matches the viewer's (JavaScript has one number type and writes 1)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _plain_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain_numbers(v) for v in value]
    return value


def canonical_json(value: Any) -> str:
    """Sorted keys, no spaces, UTF-8: the same text the viewer computes (public/verify-status.js)."""
    return json.dumps(_plain_numbers(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def logic_sha256(logic: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(logic).encode("utf-8")).hexdigest()


def _same_person(a: str, b: str) -> bool:
    return " ".join(a.lower().split()) == " ".join(b.lower().split())


def _audit(db: Session, actor: str, action: str, entity: str, key: str, detail: dict[str, Any] | None = None) -> None:
    db.add(RegAudit(actor=actor, action=action, entity=entity, entity_key=key, detail=detail, ok=True))


def _need(value: str | None, what: str) -> str:
    v = (value or "").strip()
    if not v:
        raise VerificationError(f"{what} is required.")
    return v


# ------------------------------------------------------------------ quotes

_DASHES = dict.fromkeys(map(ord, "‐‑‒–—−"), "-")
_QUOTES = {**dict.fromkeys(map(ord, "‘’‚′"), "'"), **dict.fromkeys(map(ord, "“”„″"), '"')}


def _normalize_with_map(text: str) -> tuple[str, list[int]]:
    """Lower case, one kind of dash and quote, runs of white space as one space. Returns the normalized text and,
    for every normalized character, its index in the original text."""
    out: list[str] = []
    index: list[int] = []
    space = False
    for i, ch in enumerate(text.translate(_DASHES).translate(_QUOTES)):
        if ch.isspace() or ch == " ":
            if out and not space:
                out.append(" ")
                index.append(i)
            space = True
            continue
        space = False
        out.append(ch.lower())
        index.append(i)
    return "".join(out).strip(), index


def page_of(page_index: list[list[int]], offset: int) -> int | None:
    page = None
    for start, p in page_index:
        if start > offset:
            break
        page = p
    return page


def find_quote(source_text: str, page_index: list[list[int]], quote: str) -> dict[str, Any] | None:
    """Where a quote stands in the source, ignoring case, white space and the kind of dash or quote mark. A quote
    shorter than MIN_QUOTE_CHARS proves nothing (a bare "900" is everywhere) and is not accepted."""
    q, _ = _normalize_with_map(quote or "")
    if len(q) < MIN_QUOTE_CHARS:
        return None
    norm, index = _normalize_with_map(source_text)
    at = norm.find(q)
    if at < 0:
        return None
    start = index[at]
    end = index[at + len(q) - 1] + 1
    return {"start": start, "end": end, "page": page_of(page_index, start), "text": source_text[start:end]}


# ------------------------------------------------------------------ sources

_LINE = re.compile(r"^\[(?:page:(\d+):)?[^\]]*\] ?(.*)$")


def source_text_from_file(filename: str, data: bytes) -> tuple[str, list[list[int]]]:
    """Plain text of an official document and the character offset where each page starts (PDF; one page else)."""
    try:
        parsed = parse_source(filename, data)
    except SourceProcessingError as exc:
        raise VerificationError(str(exc)) from exc
    lines, page_index, offset, last_page = [], [], 0, None
    for raw in parsed.content.split("\n"):
        m = _LINE.match(raw)
        page = int(m.group(1)) if m and m.group(1) else 1
        text = m.group(2) if m else raw
        if page != last_page:
            page_index.append([offset, page])
            last_page = page
        lines.append(text)
        offset += len(text) + 1
    text = "\n".join(lines)
    if not text.strip():
        raise VerificationError("No text was found in the document.")
    return text, page_index or [[0, 1]]


def add_source(db: Session, *, filename: str, data: bytes, instrument: str, edition: str, licence: str, actor: str,
               published: str | None = None, effective: str | None = None, publisher: str | None = None) -> tuple[RegSource, bool]:
    """Stores an official document once (by its SHA-256). Returns (source, created)."""
    actor = _need(actor, "Your name")
    if licence not in LICENCES:
        raise VerificationError(f"Licence must be one of {', '.join(LICENCES)}.")
    sha = hashlib.sha256(data).hexdigest()
    existing = db.scalar(select(RegSource).where(RegSource.file_sha256 == sha))
    if existing:
        return existing, False
    text, page_index = source_text_from_file(filename, data)
    src = RegSource(
        instrument=_need(instrument, "Instrument"), edition=_need(edition, "Edition"), licence=licence,
        published=(published or None), effective=(effective or None), publisher=(publisher or None),
        filename=filename[:300], file_sha256=sha, text=text, text_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        page_index=page_index, acquired_by=actor,
    )
    db.add(src)
    db.flush()
    _audit(db, actor, "add_source", "source", str(src.id), {"instrument": src.instrument, "edition": src.edition, "file_sha256": sha, "licence": licence})
    db.commit()
    return src, True


def source_out(src: RegSource) -> dict[str, Any]:
    return {
        "id": str(src.id), "instrument": src.instrument, "edition": src.edition, "published": src.published,
        "effective": src.effective, "publisher": src.publisher, "licence": src.licence, "filename": src.filename,
        "file_sha256": src.file_sha256, "characters": len(src.text), "pages": len(src.page_index),
        "acquired_by": src.acquired_by, "created_at": src.created_at.isoformat() if src.created_at else None,
    }


def list_sources(db: Session) -> list[dict[str, Any]]:
    return [source_out(s) for s in db.scalars(select(RegSource).order_by(RegSource.instrument, RegSource.edition))]


def _source(db: Session, source_id: str) -> RegSource:
    try:
        src = db.get(RegSource, uuid.UUID(str(source_id)))
    except ValueError:
        src = None
    if not src:
        raise VerificationError("Unknown source document.")
    return src


def check_quote(db: Session, source_id: str, quote: str) -> dict[str, Any]:
    src = _source(db, source_id)
    hit = find_quote(src.text, src.page_index, quote)
    return {"found": bool(hit), **({"page": hit["page"], "start": hit["start"], "end": hit["end"], "text": hit["text"]} if hit else {}),
            **({} if hit else {"reason": "The quote is shorter than 12 characters." if len(_normalize_with_map(quote or "")[0]) < MIN_QUOTE_CHARS
                               else "The quote does not appear in this source (verbatim, ignoring case and spacing)."})}


# ------------------------------------------------------------------ rules and versions

def is_internal(logic: dict[str, Any]) -> bool:
    """Data-quality checks are Complee's own: there is no official text to verify them against."""
    return logic.get("check") == "data_quality"


def required_fields(logic: dict[str, Any]) -> list[str]:
    """Fields that need a quote from an official source before level 1 can be approved."""
    if is_internal(logic):
        return []
    fields = ["requirement"]
    check = logic.get("check")
    if check in NUMERIC_CHECKS:
        fields.append("value")
    if check == "in_set":
        fields.append("values")
    if check == "table_lookup":
        fields.append("rows")
    ship = (logic.get("applies_to") or {}).get("ship") or {}
    if any(k != "constructed" for k in ship):
        fields.append("applies_to.ship")
    if "constructed" in ship:
        fields.append("constructed")
    if (logic.get("applies_to") or {}).get("where"):
        fields.append("applies_to.where")
    return fields


def value_warnings(logic: dict[str, Any], evidence: list[dict[str, Any]]) -> list[str]:
    """Plausibility hints for the level 1 checker; they do not block (the text may write 0.9 m for 900 mm)."""
    out = []
    value = logic.get("value")
    if logic.get("check") in NUMERIC_CHECKS and isinstance(value, (int, float)):
        number = f"{value:g}"
        quotes = [e["quote"] for e in evidence if e["field"] == "value"]
        if quotes and not any(re.search(rf"(?<![\d.]){re.escape(number)}(?![\d])", q) for q in quotes):
            out.append(f"The value {number} {logic.get('unit', '')} does not appear in the value quote: check the unit conversion.")
    return out


def _latest(db: Session, rule_id: str) -> RegRuleVersion | None:
    return db.scalar(select(RegRuleVersion).where(RegRuleVersion.rule_id == rule_id).order_by(RegRuleVersion.version.desc()).limit(1))


def import_rules(db: Session, rules: list[dict[str, Any]], actor: str) -> dict[str, Any]:
    """Takes the rules of the bundled catalog in as version 1 (draft). A rule already in the database is never
    overwritten: if its logic differs it is reported, and the engineer decides by saving a new version."""
    actor = _need(actor, "Your name")
    created, unchanged, differs = [], [], []
    for logic in rules:
        rid = str(logic.get("id") or "").strip()
        if not rid or not logic.get("check"):
            continue
        latest = _latest(db, rid)
        if latest:
            (unchanged if latest.logic_sha256 == logic_sha256(logic) else differs).append(rid)
            continue
        if not db.get(RegRule, rid):
            db.add(RegRule(rule_id=rid, instrument=str(logic.get("source") or "")[:300]))
            db.flush()
        v = RegRuleVersion(rule_id=rid, version=1, logic=logic, logic_sha256=logic_sha256(logic), origin="catalog_import",
                           author=actor, change_reason="Imported from the bundled rule catalog (paraphrase, not verified).")
        db.add(v)
        created.append(rid)
    if created:
        _audit(db, actor, "import_rules", "rule", ",".join(created)[:200], {"created": created, "differs": differs})
    db.commit()
    return {"created": created, "unchanged": unchanged, "differs": differs}


def create_version(db: Session, rule_id: str, logic: dict[str, Any], evidence: list[dict[str, Any]], author: str, change_reason: str) -> RegRuleVersion:
    """A new, immutable version with its evidence. Every quote must be found in its source, otherwise nothing is saved."""
    author = _need(author, "Your name")
    change_reason = _need(change_reason, "The reason for the change")
    if not isinstance(logic, dict) or str(logic.get("id")) != rule_id or not logic.get("check"):
        raise VerificationError('The rule logic must be an object with "id" equal to the rule id and a "check".')
    resolved, problems = [], []
    for e in evidence or []:
        field = str(e.get("field") or "").strip()
        if not field:
            problems.append("Evidence without a field name.")
            continue
        src = _source(db, e.get("source_id"))
        hit = find_quote(src.text, src.page_index, e.get("quote") or "")
        if not hit:
            problems.append(f"{field}: quote not found in {src.instrument} {src.edition}.")
            continue
        resolved.append((field, src, hit))
    if problems:
        raise VerificationError("Not saved. " + " ".join(problems))
    latest = _latest(db, rule_id)
    if not db.get(RegRule, rule_id):
        db.add(RegRule(rule_id=rule_id, instrument=str(logic.get("source") or "")[:300]))
        db.flush()
    v = RegRuleVersion(rule_id=rule_id, version=(latest.version + 1) if latest else 1, logic=logic, logic_sha256=logic_sha256(logic),
                       origin="edited", author=author, change_reason=change_reason)
    db.add(v)
    db.flush()
    for field, src, hit in resolved:
        # The stored quote is the exact text of the source at that place, not what was typed.
        db.add(RegEvidence(rule_version_id=v.id, field=field[:80], source_id=src.id, quote=hit["text"], start=hit["start"], end=hit["end"], page=hit["page"]))
    _audit(db, author, "create_version", "rule_version", f"{rule_id}@{v.version}",
           {"logic_sha256": v.logic_sha256, "evidence": [f for f, _, _ in resolved], "reason": change_reason})
    db.commit()
    return v


def _evidence(db: Session, version_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = db.execute(select(RegEvidence, RegSource).join(RegSource, RegSource.id == RegEvidence.source_id)
                      .where(RegEvidence.rule_version_id == version_id).order_by(RegEvidence.created_at)).all()
    return [{"field": e.field, "source_id": str(s.id), "source": f"{s.instrument}, {s.edition}", "licence": s.licence,
             "quote": e.quote, "page": e.page, "start": e.start, "end": e.end} for e, s in rows]


def _verifications(db: Session, version_id: uuid.UUID) -> list[RegVerification]:
    return list(db.scalars(select(RegVerification).where(RegVerification.rule_version_id == version_id).order_by(RegVerification.created_at)))


def _latest_decision(vs: list[RegVerification], level: int) -> RegVerification | None:
    of_level = [v for v in vs if v.level == level]
    return of_level[-1] if of_level else None


def version_level(vs: list[RegVerification]) -> int:
    l1, l2 = _latest_decision(vs, 1), _latest_decision(vs, 2)
    if l1 and l1.decision == "approved":
        return 2 if l2 and l2.decision == "approved" and l2.created_at >= l1.created_at else 1
    return 0


def verify(db: Session, version_id: str, *, level: int, reviewer: str, decision: str, note: str = "", checklist: dict[str, Any] | None = None) -> RegVerification:
    reviewer = _need(reviewer, "Your name")
    if level not in (1, 2):
        raise VerificationError("Level must be 1 (text check) or 2 (engineering review).")
    if decision not in ("approved", "rejected"):
        raise VerificationError('Decision must be "approved" or "rejected".')
    if decision == "rejected" and not (note or "").strip():
        raise VerificationError("Write why the rule is rejected.")
    try:
        v = db.get(RegRuleVersion, uuid.UUID(str(version_id)))
    except ValueError:
        v = None
    if not v:
        raise VerificationError("Unknown rule version.")
    latest = _latest(db, v.rule_id)
    if latest.id != v.id:
        raise VerificationError(f"Version {v.version} is superseded by version {latest.version}: verify the latest version.")
    if is_internal(v.logic):
        raise VerificationError("Internal data-quality checks have no official source to verify against.")
    vs = _verifications(db, v.id)
    if decision == "approved" and level == 1:
        if v.logic.get("draft") or (v.logic.get("check") in NUMERIC_CHECKS and not isinstance(v.logic.get("value"), (int, float))):
            raise VerificationError("A draft rule without a value cannot be approved.")
        have = {e["field"] for e in _evidence(db, v.id)}
        missing = [f for f in required_fields(v.logic) if f not in have]
        if missing:
            raise VerificationError(f"Quotes from an official source are missing for: {', '.join(missing)}.")
    if level == 2:
        l1 = _latest_decision(vs, 1)
        if not l1 or l1.decision != "approved":
            raise VerificationError("The engineering review needs an approved text check (level 1) first.")
        if _same_person(reviewer, v.author) or _same_person(reviewer, l1.reviewer):
            raise VerificationError("Four eyes: the engineering review must be done by someone other than the author and the text checker.")
    rec = RegVerification(rule_version_id=v.id, level=level, reviewer=reviewer, decision=decision, note=(note or "").strip(), checklist=checklist)
    db.add(rec)
    _audit(db, reviewer, f"verify_level_{level}", "rule_version", f"{v.rule_id}@{v.version}", {"decision": decision, "note": (note or "").strip()[:500]})
    db.commit()
    return rec


def rule_detail(db: Session, rule_id: str) -> dict[str, Any]:
    rule = db.get(RegRule, rule_id)
    if not rule:
        raise VerificationError("Unknown rule.")
    versions = list(db.scalars(select(RegRuleVersion).where(RegRuleVersion.rule_id == rule_id).order_by(RegRuleVersion.version.desc())))
    out = []
    for v in versions:
        vs = _verifications(db, v.id)
        ev = _evidence(db, v.id)
        out.append({
            "id": str(v.id), "version": v.version, "logic": v.logic, "logic_sha256": v.logic_sha256, "origin": v.origin,
            "author": v.author, "change_reason": v.change_reason, "created_at": v.created_at.isoformat() if v.created_at else None,
            "evidence": ev, "required_fields": required_fields(v.logic), "missing_fields": [f for f in required_fields(v.logic) if f not in {e["field"] for e in ev}],
            "warnings": value_warnings(v.logic, ev), "internal": is_internal(v.logic),
            "level": version_level(vs),
            "verifications": [{"level": x.level, "reviewer": x.reviewer, "decision": x.decision, "note": x.note, "checklist": x.checklist,
                               "created_at": x.created_at.isoformat() if x.created_at else None} for x in vs],
        })
    return {"rule_id": rule.rule_id, "instrument": rule.instrument, "versions": out}


def status(db: Session) -> dict[str, Any]:
    """Status of every rule (its latest version), for the viewer and the report."""
    latest_v = select(RegRuleVersion.rule_id, func.max(RegRuleVersion.version).label("v")).group_by(RegRuleVersion.rule_id).subquery()
    versions = db.scalars(select(RegRuleVersion).join(latest_v, (RegRuleVersion.rule_id == latest_v.c.rule_id) & (RegRuleVersion.version == latest_v.c.v)))
    out = {}
    for v in versions:
        vs = _verifications(db, v.id)
        level = version_level(vs)
        l1, l2 = _latest_decision(vs, 1), _latest_decision(vs, 2)
        editions = sorted({s for (s,) in db.execute(select(RegSource.instrument + ", " + RegSource.edition).join(RegEvidence, RegEvidence.source_id == RegSource.id)
                                                    .where(RegEvidence.rule_version_id == v.id))})
        out[v.rule_id] = {
            "version": v.version, "logic_sha256": v.logic_sha256, "level": level,
            "label": "internal" if is_internal(v.logic) else STATUS_LABEL[level],
            "text_checked_by": l1.reviewer if level >= 1 else None, "text_checked_at": l1.created_at.isoformat() if level >= 1 and l1.created_at else None,
            "reviewed_by": l2.reviewer if level == 2 else None, "reviewed_at": l2.created_at.isoformat() if level == 2 and l2.created_at else None,
            "sources": editions,
        }
    return {"rules": out}


def catalog(db: Session) -> list[dict[str, Any]]:
    """The latest version of every rule, as the viewer's rule catalog reads it."""
    latest_v = select(RegRuleVersion.rule_id, func.max(RegRuleVersion.version).label("v")).group_by(RegRuleVersion.rule_id).subquery()
    return [v.logic for v in db.scalars(select(RegRuleVersion).join(latest_v, (RegRuleVersion.rule_id == latest_v.c.rule_id) & (RegRuleVersion.version == latest_v.c.v)).order_by(RegRuleVersion.rule_id))]


# ------------------------------------------------------------------ AI proposal

class ProposedField(BaseModel):
    field: str = Field(description="One of: requirement, value, unit, values, rows, applies_to.ship, applies_to.where, constructed, exception")
    proposed: str = Field(description="What the official text says for this field, short (for value: the number with its unit)")
    quote: str = Field(description="Verbatim quote from the passage that states it, copied character for character, 12 to 300 characters")


class RuleProposal(BaseModel):
    fields: list[ProposedField] = Field(default_factory=list, description="At most 8 fields")
    differences: list[str] = Field(default_factory=list, description="At most 4 differences between the tool's rule and the official text, each at most 25 words")
    notes: list[str] = Field(default_factory=list, description="At most 3 points the checker should look at, e.g. exceptions or interpretations, each at most 25 words")


PROPOSE_SYSTEM = (
    "You help verify a rule of a ship compliance tool against the official regulation text. The passage below is the "
    "official text. For each field of the rule, find the sentence of the passage that states it and copy it VERBATIM "
    "as the quote: the tool checks every quote character for character against the source and drops any that does not "
    "match, so never paraphrase, shorten inside, or fix typos in a quote. If the passage does not state a field, leave "
    "that field out and say so in notes. Report every difference between the tool's rule and the text (value, unit, "
    "scope, exceptions). A person checks your proposal; you decide nothing. Return JSON only."
)


def _passage(text: str, logic: dict[str, Any], hint: str, limit: int = 14000) -> str:
    """The part of a long source most likely to hold the rule: lines scored by clause numbers and words of the rule."""
    lines = text.split("\n")
    words = {w.lower() for w in re.findall(r"[A-Za-z]{5,}", f"{logic.get('text', '')} {logic.get('clause', '')} {hint}")}
    numbers = set(re.findall(r"\d+(?:\.\d+)+", f"{logic.get('clause', '')} {hint}"))
    scores = []
    for i, line in enumerate(lines):
        low = line.lower()
        s = sum(1 for w in words if w in low) + sum(5 for n in numbers if n in line)
        scores.append(s)
    window = 40
    best = max(range(len(lines)), key=lambda i: sum(scores[max(0, i - window // 2): i + window]), default=0)
    start = max(0, best - window // 2)
    out, size = [], 0
    for line in lines[start:]:
        if size + len(line) > limit:
            break
        out.append(line)
        size += len(line) + 1
    return "\n".join(out)


def propose(db: Session, rule_id: str, source_id: str, hint: str = "") -> dict[str, Any]:
    from app.services import ai_assist, ai_chain  # the AI is optional: imported only when asked

    src = _source(db, source_id)
    latest = _latest(db, rule_id)
    if not latest:
        raise VerificationError("Unknown rule.")
    if not ai_chain.active_steps():
        raise VerificationError("No AI model is configured.")
    passage = _passage(src.text, latest.logic, hint or "")
    prompt = (
        "Rule in the tool (JSON):\n" + ai_assist._compact(latest.logic, 4000)
        + f"\n\nOfficial source: {src.instrument}, {src.edition}\nEngineer's hint: {hint or '-'}"
        + "\n\nPassage of the official text:\n" + passage
        + "\n\nJSON schema:\n" + json.dumps(RuleProposal.model_json_schema())
    )
    out = ai_assist._run(prompt, PROPOSE_SYSTEM, RuleProposal, 2500)
    fields = []
    for f in (out["result"] or {}).get("fields", [])[:8]:
        hit = find_quote(src.text, src.page_index, f.get("quote") or "")
        fields.append({**f, "found": bool(hit), **({"quote": hit["text"], "page": hit["page"]} if hit else {})})
    _audit(db, "AI", "propose", "rule", rule_id, {"source": str(src.id), "model": out["model"], "found": sum(1 for f in fields if f["found"]), "fields": len(fields)})
    db.commit()
    return {"fields": fields, "differences": (out["result"] or {}).get("differences", [])[:4], "notes": (out["result"] or {}).get("notes", [])[:3],
            "model": out["model"], "duration_ms": out["duration_ms"], "cost_usd": out.get("cost_usd"), "source_id": str(src.id)}
