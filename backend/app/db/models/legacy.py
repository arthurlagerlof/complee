import uuid

from pgvector.sqlalchemy import VECTOR
from sqlalchemy import ARRAY, ForeignKey, MetaData, Text, Uuid, event
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship


class LegacyBase(DeclarativeBase):
    metadata = MetaData()


class Instrument(LegacyBase):
    __tablename__ = "instruments"
    __table_args__ = {"schema": "public"}

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    authority: Mapped[str | None] = mapped_column(Text)
    availability: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    applies_to: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    provisions: Mapped[list["Provision"]] = relationship(back_populates="instrument", viewonly=True)


class Provision(LegacyBase):
    __tablename__ = "provisions"
    __table_args__ = {"schema": "public"}

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    instrument_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("public.instruments.id"), nullable=False
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("public.provisions.id")
    )
    clause_key: Mapped[str] = mapped_column(Text, nullable=False)
    heading_path: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(Text, nullable=False)
    edition: Mapped[str] = mapped_column(Text, nullable=False)
    availability: Mapped[str] = mapped_column(Text, nullable=False)
    applicability: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    search_tsv = mapped_column(TSVECTOR)
    embedding = mapped_column(VECTOR(1024))

    instrument: Mapped[Instrument] = relationship(back_populates="provisions", viewonly=True)


class LegacyDesignFact(LegacyBase):
    __tablename__ = "design_facts"
    __table_args__ = {"schema": "public"}

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    kind: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str | None] = mapped_column(Text)
    deck: Mapped[str | None] = mapped_column(Text)
    value: Mapped[str | None] = mapped_column(Text)
    source_file: Mapped[str | None] = mapped_column(Text)


class RetrievalFinding(LegacyBase):
    __tablename__ = "findings"
    __table_args__ = {"schema": "public"}

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    design_fact_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("public.design_facts.id")
    )
    provision_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("public.provisions.id")
    )
    why: Mapped[str | None] = mapped_column(Text)
    clause_key: Mapped[str | None] = mapped_column(Text)
    heading_path: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text)
    availability: Mapped[str | None] = mapped_column(Text)


@event.listens_for(Session, "before_flush")
def _reject_legacy_table_writes(session: Session, _flush_context, _instances) -> None:
    pending = (*session.new, *session.dirty, *session.deleted)
    if any(isinstance(instance, LegacyBase) for instance in pending):
        raise InvalidRequestError(
            "Legacy regulatory and retrieval models are read-only; use application-owned records."
        )
