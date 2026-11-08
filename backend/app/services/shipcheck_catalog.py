import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from app.db.models.shipcheck import ShipCheckActiveDataset, ShipCheckDatasetRecord, ShipCheckDatasetVersion


@dataclass(frozen=True)
class CatalogSource:
    source_path: str
    collection_key: str | None = None


CATALOG_SOURCES = {
    "rules": CatalogSource("shipcheck/rules.json", "rules"),
    "scenarios": CatalogSource("shipcheck/scenarios.json", "scenarios"),
    "regulation-links": CatalogSource("shipcheck/regulation-links.json"),
    "model-rcrv-parts": CatalogSource("shipcheck/ships/rcrv/parts.json", "parts"),
    "model-rcrv-meta": CatalogSource("shipcheck/ships/rcrv/rcrv-3d.meta.json"),
    "model-rcrv-precomputed": CatalogSource("shipcheck/ships/rcrv/results-3d.json"),
    "model-rcrv-inside": CatalogSource("shipcheck/ships/rcrv/inside.json"),
    "model-cruise-deck": CatalogSource("shipcheck/ships/cruise/deck.json"),
    "model-rcrv-layout": CatalogSource("shipcheck/ships/rcrv/layout.json"),
    "expected-rcrv-3d": CatalogSource("shipcheck/tests/expected/rcrv-3d.json"),
    "expected-rcrv-inside": CatalogSource("shipcheck/tests/expected/rcrv-inside.json"),
    "expected-cruise": CatalogSource("shipcheck/tests/expected/cruise.json"),
    "expected-rcrv-layout": CatalogSource("shipcheck/tests/expected/rcrv-layout.json"),
}


def _records(source_key: str, definition: CatalogSource, source_root: Path) -> tuple[bytes, dict[str, Any] | None, list[tuple[str, Any]]]:
    path = (source_root / definition.source_path).resolve()
    if not path.is_relative_to(source_root.resolve()):
        raise ValueError(f"Catalog source escapes the configured source root: {source_key}")
    if not path.is_file():
        raise FileNotFoundError(
            f"Missing external ShipCheck catalog input for {source_key}: {path}. "
            "The database is canonical; provide an import source directory with this file."
        )
    raw = path.read_bytes()
    document = json.loads(raw)
    if definition.collection_key is None:
        return raw, None, [("document", document)]
    if not isinstance(document, dict) or not isinstance(document.get(definition.collection_key), list):
        raise ValueError(f"Catalog source {source_key} must contain a {definition.collection_key!r} array.")
    records = document[definition.collection_key]
    metadata = {key: value for key, value in document.items() if key != definition.collection_key}
    keyed_records = [(f"ordinal:{ordinal:08d}", record) for ordinal, record in enumerate(records)]
    return raw, metadata, keyed_records


def import_catalog_sources(
    session: Session,
    source_root: Path,
    sources: dict[str, CatalogSource] = CATALOG_SOURCES,
) -> dict[str, tuple[str, int]]:
    """Import immutable dataset versions and atomically point each source at its current version."""
    imported: dict[str, tuple[str, int]] = {}
    for source_key, definition in sources.items():
        raw, metadata, records = _records(source_key, definition, source_root)
        content_sha256 = hashlib.sha256(raw).hexdigest()
        version = session.scalar(
            select(ShipCheckDatasetVersion).where(
                ShipCheckDatasetVersion.source_key == source_key,
                ShipCheckDatasetVersion.content_sha256 == content_sha256,
            )
        )
        if version is None:
            version = ShipCheckDatasetVersion(
                source_key=source_key,
                source_path=definition.source_path,
                content_sha256=content_sha256,
                collection_key=definition.collection_key,
                document_metadata=metadata,
                record_count=len(records),
            )
            session.add(version)
            session.flush()
            for start in range(0, len(records), 1000):
                session.execute(
                    insert(ShipCheckDatasetRecord),
                    [
                        {
                            "dataset_version_id": version.id,
                            "record_key": record_key,
                            "ordinal": ordinal,
                            "payload": payload,
                        }
                        for ordinal, (record_key, payload) in enumerate(records[start : start + 1000], start)
                    ],
                )
        else:
            stored_count = session.scalar(
                select(func.count())
                .select_from(ShipCheckDatasetRecord)
                .where(ShipCheckDatasetRecord.dataset_version_id == version.id)
            )
            if (
                stored_count != len(records)
                or version.record_count != len(records)
                or version.source_path != definition.source_path
                or version.collection_key != definition.collection_key
                or version.document_metadata != metadata
            ):
                raise RuntimeError(f"Stored catalog version {source_key} ({content_sha256}) is incomplete.")

        active = session.get(ShipCheckActiveDataset, source_key)
        if active is None:
            session.add(ShipCheckActiveDataset(source_key=source_key, dataset_version_id=version.id))
        else:
            active.dataset_version_id = version.id
        imported[source_key] = (content_sha256, len(records))
    session.flush()
    return imported


def read_active_catalog(session: Session, source_key: str) -> dict[str, Any]:
    if source_key not in CATALOG_SOURCES:
        raise KeyError(source_key)
    active = session.get(ShipCheckActiveDataset, source_key)
    if active is None:
        raise LookupError(f"ShipCheck catalog {source_key!r} has not been imported.")
    version = session.get(ShipCheckDatasetVersion, active.dataset_version_id)
    if version is None:
        raise RuntimeError(f"Active ShipCheck catalog {source_key!r} points to a missing version.")
    if version.source_key != source_key:
        raise RuntimeError(f"Active ShipCheck catalog {source_key!r} points to another source's version.")
    records = session.scalars(
        select(ShipCheckDatasetRecord.payload)
        .where(ShipCheckDatasetRecord.dataset_version_id == version.id)
        .order_by(ShipCheckDatasetRecord.ordinal)
    ).all()
    if len(records) != version.record_count:
        raise RuntimeError(
            f"Active ShipCheck catalog {source_key!r} is incomplete "
            f"(expected {version.record_count} records, found {len(records)})."
        )
    if version.collection_key is None:
        if len(records) != 1:
            raise RuntimeError(f"Document catalog {source_key!r} must contain exactly one record.")
        return records[0]
    result = dict(version.document_metadata or {})
    result[version.collection_key] = records
    return result
