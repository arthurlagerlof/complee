"""AI assistance for the 3D viewer (works without a database; see app/services/ai_assist.py)."""
from typing import Any

import json

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

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


@router.post("/{task}/stream")
def stream_task(task: str, payload: dict[str, Any] = Body(...)):
    """Server-sent events while the model writes: model, delta, switch, then done or error."""
    if task not in ai_assist.STREAM_TASKS:
        raise HTTPException(status_code=404, detail="Unknown AI task.")
    holder: dict[str, Any] = {}
    log_task = ai_assist.STREAM_TASKS[task][4]
    schema_name = f"{ai_assist.STREAM_TASKS[task][1].__name__}.v1"

    def events():
        try:
            for event in ai_assist.stream(task, payload, holder):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception:  # noqa: BLE001 - the stream must end with an event the viewer understands
            yield "data: " + json.dumps({"type": "error", "message": "The AI service failed."}) + "\n\n"

    return StreamingResponse(
        events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        background=BackgroundTask(lambda: ai_assist.log_attempts(log_task, schema_name, holder.get("attempts", []))),
    )
