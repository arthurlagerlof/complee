from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services.shipcheck_catalog import read_active_catalog_json


router = APIRouter(prefix="/shipcheck/catalog", tags=["shipcheck"])


@router.get("/{source_key}")
def catalog(source_key: str, db: Session = Depends(get_db)) -> Response:
    # Served as pre-serialized JSON, cached per immutable dataset version (see read_active_catalog_json).
    try:
        body = read_active_catalog_json(db, source_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown ShipCheck catalog.") from exc
    except LookupError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(content=body, media_type="application/json", headers={"Cache-Control": "no-store"})
