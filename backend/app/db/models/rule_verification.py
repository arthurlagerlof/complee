"""Rule verification: official sources, immutable rule versions, quoted evidence and verification records.

Nothing here is ever updated or deleted (PostgreSQL triggers enforce it, see migration 20261113_0006): a change is a
new rule version, a decision is a new verification record. The status of a rule is derived from these records.
"""
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base

JSON_DOCUMENT = JSON().with_variant(JSONB(), "postgresql")
# SQLite (tests) only autoincrements INTEGER primary keys.
AUDIT_ID = BigInteger().with_variant(Integer(), "sqlite")


def _now() -> datetime:
    """Microsecond time stamp set by the application: decisions are ordered by it."""
    return datetime.now(timezone.utc)


class RegSource(Base):
    """An official text of one edition of an instrument (SOLAS consolidated edition, DNV rules July 2026, ...)."""

    __tablename__ = "sc_reg_sources"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    instrument: Mapped[str] = mapped_column(String(200), nullable=False)
    edition: Mapped[str] = mapped_column(String(120), nullable=False)
    published: Mapped[str | None] = mapped_column(String(20))
    effective: Mapped[str | None] = mapped_column(String(20))
    publisher: Mapped[str | None] = mapped_column(String(200))
    # public | licensed_internal | paraphrase_only: licensed text stays inside the company, never in a customer view.
    licence: Mapped[str] = mapped_column(String(40), nullable=False)
    filename: Mapped[str] = mapped_column(String(300), nullable=False)
    file_sha256: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    text_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    page_index: Mapped[Any] = mapped_column(JSON_DOCUMENT, nullable=False)  # [[char offset, page], ...]
    acquired_by: Mapped[str] = mapped_column(String(120), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())


class RegRule(Base):
    """The stable identity of a rule; its content lives in RegRuleVersion."""

    __tablename__ = "sc_reg_rules"

    rule_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    instrument: Mapped[str] = mapped_column(String(300), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())


class RegRuleVersion(Base):
    __tablename__ = "sc_reg_rule_versions"
    __table_args__ = (UniqueConstraint("rule_id", "version", name="uq_sc_reg_rule_versions_rule_version"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[str] = mapped_column(String(120), ForeignKey("sc_reg_rules.rule_id", ondelete="RESTRICT"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    logic: Mapped[Any] = mapped_column(JSON_DOCUMENT, nullable=False)
    logic_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    origin: Mapped[str] = mapped_column(String(40), nullable=False)  # catalog_import | edited
    author: Mapped[str] = mapped_column(String(120), nullable=False)
    change_reason: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())


class RegEvidence(Base):
    """A verbatim quote from a source that supports one field of a rule version (value, unit, scope, ...)."""

    __tablename__ = "sc_reg_evidence"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_version_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("sc_reg_rule_versions.id", ondelete="RESTRICT"), nullable=False, index=True)
    field: Mapped[str] = mapped_column(String(80), nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("sc_reg_sources.id", ondelete="RESTRICT"), nullable=False)
    quote: Mapped[str] = mapped_column(Text, nullable=False)
    start: Mapped[int] = mapped_column(Integer, nullable=False)
    end: Mapped[int] = mapped_column(Integer, nullable=False)
    page: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())


class RegVerification(Base):
    """Level 1: the rule's fields match the quoted official text. Level 2: engineering review of the interpretation."""

    __tablename__ = "sc_reg_verifications"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_version_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("sc_reg_rule_versions.id", ondelete="RESTRICT"), nullable=False, index=True)
    level: Mapped[int] = mapped_column(Integer, nullable=False)
    reviewer: Mapped[str] = mapped_column(String(120), nullable=False)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)  # approved | rejected
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    checklist: Mapped[Any] = mapped_column(JSON_DOCUMENT, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())


class RegAudit(Base):
    """Append-only log of every write in rule verification."""

    __tablename__ = "sc_reg_audit"

    id: Mapped[int] = mapped_column(AUDIT_ID, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, server_default=func.now())
    actor: Mapped[str] = mapped_column(String(120), nullable=False)
    action: Mapped[str] = mapped_column(String(60), nullable=False)
    entity: Mapped[str] = mapped_column(String(60), nullable=False)
    entity_key: Mapped[str] = mapped_column(String(200), nullable=False)
    detail: Mapped[Any] = mapped_column(JSON_DOCUMENT, nullable=True)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
