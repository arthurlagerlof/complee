from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services.shipcheck_catalog import read_active_catalog


router = APIRouter(prefix="/shipcheck/catalog", tags=["shipcheck"])


@router.get("/{source_key}")
def catalog(source_key: str, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    try:
        return read_active_catalog(db, source_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown ShipCheck catalog.") from exc
    except LookupError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
