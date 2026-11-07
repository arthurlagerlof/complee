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
    regulatory_schema: str = "public"
    regulatory_table: str = "provisions"
    regulatory_id_column: str = "id"
    regulatory_text_column: str = "body"
    regulatory_embedding_column: str = "embedding"
    regulatory_vector_dimension: int = 1024
    pgvector_schema: str = "extensions"
    embedding_api_url: str | None = None
    embedding_api_key: str | None = None
    embedding_model: str = "BAAI/bge-m3"
    db_pool_size: int = Field(default=5, ge=1, le=50)
    db_max_overflow: int = Field(default=10, ge=0, le=100)

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.frontend_origins.split(",") if origin.strip()]

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
