from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services.shipcheck_catalog import active_catalog_etag, read_active_catalog_json


router = APIRouter(prefix="/shipcheck/catalog", tags=["shipcheck"])


def _etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    return any(value.strip() in (etag, "*") for value in header.split(","))


@router.get("/{source_key}")
def catalog(source_key: str, request: Request, db: Session = Depends(get_db)) -> Response:
    # Served as pre-serialized JSON, cached per immutable dataset version (see read_active_catalog_json).
    # The ETag is the dataset's content hash: clients and the ShipCheck proxy revalidate instead of downloading the
    # parts list (tens of MB) again, and a newly activated version changes the ETag.
    try:
        etag = active_catalog_etag(db, source_key)
        if _etag_matches(request.headers.get("if-none-match"), etag):
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
        body = read_active_catalog_json(db, source_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown ShipCheck catalog.") from exc
    except LookupError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(
        content=body,
        media_type="application/json",
        headers={"Cache-Control": "no-cache", "ETag": etag},
    )
