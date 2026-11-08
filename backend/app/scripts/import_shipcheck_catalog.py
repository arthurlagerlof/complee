import os
import sys
from pathlib import Path

from app.core.config import BACKEND_DIR
from app.db.database import SessionLocal
from app.services.shipcheck_catalog import CATALOG_SOURCES, import_catalog_sources


def main() -> None:
    if SessionLocal is None:
        raise RuntimeError("Set DATABASE_URL before importing ShipCheck catalogs.")
    source_root = Path(os.environ.get("SHIPCHECK_CATALOG_SOURCE_ROOT", BACKEND_DIR.parent)).resolve()
    requested = sys.argv[1:]
    if requested:
        unknown = set(requested) - set(CATALOG_SOURCES)
        if unknown:
            raise ValueError(f"Unknown ShipCheck catalog source key(s): {', '.join(sorted(unknown))}")
        sources = {key: CATALOG_SOURCES[key] for key in requested}
    else:
        sources = CATALOG_SOURCES
    with SessionLocal.begin() as session:
        imported = import_catalog_sources(session, source_root, sources)
    for source_key, (content_sha256, record_count) in imported.items():
        print(f"{source_key}: {record_count} records, sha256={content_sha256}")


if __name__ == "__main__":
    main()
