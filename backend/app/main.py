from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text

from app.api.routes import ai, assessments, calculations, design, knowledge, regulations
from app.core.config import settings
from app.db.database import engine
from app.services.common import ConflictError, EntityNotFound, InvalidReference
from app.ai.providers import AIProviderError, AIProviderResponseError, AIProviderUnavailable
from app.services.ai import AIConfigurationError


app = FastAPI(
    title="Ship Compliance API",
    description=(
        "Traceable ship-design and regulatory evidence workflows. Regulatory search returns candidates; "
        "it does not determine compliance or certify a design."
    ),
    version="0.1.0",
    debug=settings.debug,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(design.router, prefix="/api/v1")
app.include_router(assessments.router, prefix="/api/v1")
app.include_router(regulations.router, prefix="/api/v1")
app.include_router(calculations.router, prefix="/api/v1")
app.include_router(ai.router, prefix="/api/v1")
app.include_router(knowledge.router, prefix="/api/v1")


def _error(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


@app.exception_handler(EntityNotFound)
async def not_found_handler(_request: Request, exc: EntityNotFound):
    return _error("not_found", str(exc), 404)


@app.exception_handler(InvalidReference)
async def invalid_reference_handler(_request: Request, exc: InvalidReference):
    return _error("invalid_reference", str(exc), 422)


@app.exception_handler(ConflictError)
async def conflict_handler(_request: Request, exc: ConflictError):
    return _error("conflict", str(exc), 409)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content=jsonable_encoder(
            {"error": {"code": "validation_error", "message": "Request validation failed.", "details": exc.errors()}}
        ),
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Request, exc: HTTPException):
    code = "not_found" if exc.status_code == 404 else "request_error"
    message = exc.detail if isinstance(exc.detail, str) else "The request could not be completed."
    return _error(code, message, exc.status_code)


@app.exception_handler(404)
async def http_not_found_handler(_request: Request, exc):
    return _error("not_found", "The requested endpoint or resource was not found.", 404)


@app.exception_handler(AIConfigurationError)
async def ai_configuration_error_handler(_request: Request, exc: AIConfigurationError):
    return _error("ai_configuration_error", str(exc), 503)


@app.exception_handler(AIProviderUnavailable)
async def ai_provider_unavailable_handler(_request: Request, exc: AIProviderUnavailable):
    return _error("ai_provider_unavailable", str(exc), 502)


@app.exception_handler(AIProviderResponseError)
async def ai_provider_response_error_handler(_request: Request, exc: AIProviderResponseError):
    return _error("ai_provider_response_error", str(exc), 502)


@app.exception_handler(AIProviderError)
async def ai_provider_error_handler(_request: Request, exc: AIProviderError):
    return _error("ai_provider_error", str(exc), 502)


@app.get("/health", tags=["health"])
def health():
    return {"status": "ok"}


@app.get("/health/database", tags=["health"])
def database_health():
    if engine is None:
        return JSONResponse(
            status_code=503,
            content={"error": {"code": "database_not_configured", "message": "Database is not configured."}},
        )
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"status": "ok", "database": "connected"}
