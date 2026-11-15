from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = "development"
    debug: bool = False
    database_url: str | None = None
    frontend_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    # Access token for requests from other computers (app/core/access.py). Unset: this computer only.
    backend_api_token: str | None = Field(default=None, min_length=24)
    embedding_model: str = "BAAI/bge-m3"
    embedding_model_revision: str = "5617a9f61b028005a4858fdac845db406aefb181"
    embedding_device: str = "cpu"
    embedding_cache_folder: str | None = None
    regulatory_vector_dimension: int = 1024
    pgvector_schema: str = "extensions"
    db_pool_size: int = Field(default=5, ge=1, le=50)
    db_max_overflow: int = Field(default=10, ge=0, le=100)
    ai_encryption_key: str | None = None
    ai_request_timeout_seconds: float = Field(default=60, gt=0, le=600)
    ai_max_source_characters: int = Field(default=100_000, ge=1_000, le=1_000_000)
    ai_allowed_hosts: str = ""
    ollama_base_url: str | None = None
    ollama_api_key: str | None = None
    ollama_models: str = ""
    ollama_model: str | None = None
    gemini_api_key: str | None = None
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    gemini_model: str | None = None
    # Optional second Gemini model, used only when the configured one is overloaded (HTTP 503) after retries.
    gemini_fallback_model: str | None = None
    # Fast model chain (app/services/ai_chain.py): first model first, next one on error, timeout or bad answer.
    anthropic_api_key: str | None = None
    anthropic_base_url: str = "https://api.anthropic.com"
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    ai_model_chain: str = (
        "anthropic:claude-opus-5-5:speed=fast,"
        "openai:gpt-6.1-sol:service_tier=ultrafast,"
        "openai:gpt-6-astra:service_tier=fast"
    )
    # Model chain profile when AI_MODEL_CHAIN is not set: "fast" (Claude Opus 5.5 fast first, a few cents per
    # answer) or "budget" (GPT-6.1 Sol first, about 1-2 cents per answer, a few seconds slower).
    ai_cost_profile: str = "fast"
    ai_chain_step_timeout_seconds: float = Field(default=45, gt=0, le=600)
    ai_chain_max_tokens: int = Field(default=8000, ge=256, le=64000)

    @field_validator("backend_api_token", mode="before")
    @classmethod
    def _empty_token_is_none(cls, value):
        # "BACKEND_API_TOKEN=" (as in .env.example) means: no token, this computer only.
        return None if value is None or not str(value).strip() else str(value).strip()

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.frontend_origins.split(",") if origin.strip()]

    @property
    def ai_provider_hosts(self) -> set[str]:
        return {host.strip().lower() for host in self.ai_allowed_hosts.split(",") if host.strip()}

    @property
    def ollama_configured_models(self) -> list[str]:
        values = [value.strip() for value in self.ollama_models.split(",") if value.strip()]
        if self.ollama_model and self.ollama_model.strip():
            values.append(self.ollama_model.strip())
        return list(dict.fromkeys(values))

    @property
    def sqlalchemy_database_url(self) -> str | None:
        if self.database_url is None:
            return None
        url = self.database_url
        if url.startswith("postgres://"):
            return url.replace("postgres://", "postgresql+psycopg://", 1)
        if url.startswith("postgresql://"):
            return url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url


settings = Settings()
