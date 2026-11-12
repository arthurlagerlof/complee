"""AI assistance for the 3D viewer (works without a database; see app/services/ai_assist.py)."""
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Body

from app.services import ai_assist

router = APIRouter(prefix="/ai/assist", tags=["ai assist"])


@router.get("/status")
def assist_status():
    return ai_assist.status()


@router.post("/explain-finding")
def explain_finding(background: BackgroundTasks, payload: dict[str, Any] = Body(...)):
    out = ai_assist.explain_finding(payload)
    background.add_task(ai_assist.log_attempts, "viewer_explain_finding", "FindingExplanation.v1", out["attempts"])
    return out


@router.post("/escape-suggestions")
def escape_suggestions(background: BackgroundTasks, payload: dict[str, Any] = Body(...)):
    out = ai_assist.escape_suggestions(payload)
    background.add_task(ai_assist.log_attempts, "viewer_escape_suggestions", "EscapeSuggestions.v1", out["attempts"])
    return out
