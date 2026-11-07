from pathlib import Path

from pydantic import Field
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
