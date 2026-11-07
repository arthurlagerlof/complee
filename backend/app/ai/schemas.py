import uuid
import re
from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


ProviderType = Literal["ollama", "openai_compatible", "openai", "anthropic"]
TASK_NAMES = {
    "text_component_extraction",
    "component_classification",
    "document_interpretation",
    "drawing_interpretation",
    "engineering_assistance",
}
_SECRET_FIELD_NAMES = {
    "api_key",
    "apikey",
    "secret",
    "password",
    "credential",
    "authorization",
    "access_token",
}


def _reject_secret_configuration(value: dict[str, Any]) -> dict[str, Any]:
    def check(item: Any) -> None:
        if isinstance(item, dict):
            for key, nested in item.items():
                normalized = re.sub(r"[^a-z0-9]+", "_", str(key).lower()).strip("_")
                if normalized in _SECRET_FIELD_NAMES or normalized.endswith(
                    ("_secret", "_password", "_credential", "_credentials", "_access_token", "_api_key")
                ):
                    raise ValueError("Credentials must use the dedicated encrypted api_key field.")
                check(nested)
        elif isinstance(item, list):
            for nested in item:
                check(nested)

    check(value)
    return value


def normalize_provider_url(value: str | HttpUrl) -> str:
    url = str(value).strip().rstrip("/")
    if not url:
        raise ValueError("Provider URL is required.")
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        parsed.port
    except ValueError as exc:
        raise ValueError("Provider URL is invalid.") from exc
    if not hostname or parsed.username or parsed.password or "?" in url or "#" in url:
        raise ValueError("Provider URLs cannot contain credentials, query parameters, or fragments.")
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Provider URLs must use HTTP or HTTPS.")
    return url


def validate_provider_transport(provider_type: ProviderType, base_url: str, api_key: str | None) -> None:
    parsed = urlsplit(base_url)
    is_loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if provider_type in {"openai", "anthropic"} and parsed.scheme != "https":
        raise ValueError("OpenAI and Anthropic API endpoints must use HTTPS.")
    if api_key and parsed.scheme != "https" and not is_loopback:
        raise ValueError("Provider API keys may only be sent over HTTPS, except to a loopback service.")


class ProviderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    provider_type: ProviderType
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096)
    enabled: bool = True
    is_local: bool | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_provider(self) -> "ProviderCreate":
        self.base_url = normalize_provider_url(self.base_url)
        provider_configuration = {key: value for key, value in self.configuration.items() if key != "requires_api_key"}
        _reject_secret_configuration(provider_configuration)
        if set(self.configuration) - {"requires_api_key"}:
            raise ValueError("Unsupported provider configuration option.")
        if "requires_api_key" in self.configuration and not isinstance(self.configuration["requires_api_key"], bool):
            raise ValueError("requires_api_key must be a boolean.")
        validate_provider_transport(self.provider_type, self.base_url, self.api_key)
        if self.provider_type in {"openai", "anthropic", "openai_compatible"} and not self.api_key:
            if self.provider_type != "openai_compatible" or self.configuration.get("requires_api_key", True):
                raise ValueError("This provider requires an API key.")
        if self.is_local is None:
            self.is_local = self.provider_type == "ollama"
        return self


class ProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    base_url: str | None = Field(default=None, min_length=1, max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096)
    clear_api_key: bool = False
    enabled: bool | None = None
    is_local: bool | None = None
    configuration: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_update(self) -> "ProviderUpdate":
        if self.base_url is not None:
            self.base_url = normalize_provider_url(self.base_url)
        if self.configuration is not None:
            if set(self.configuration) - {"requires_api_key"}:
                raise ValueError("Unsupported provider configuration option.")
            if (
                "requires_api_key" in self.configuration
                and not isinstance(self.configuration["requires_api_key"], bool)
            ):
                raise ValueError("requires_api_key must be a boolean.")
        if self.api_key and self.clear_api_key:
            raise ValueError("Set api_key or clear_api_key, not both.")
        for field in ("name", "base_url", "enabled", "is_local", "configuration", "api_key"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        return self


class ProviderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    provider_type: ProviderType
    base_url: str
    enabled: bool
    is_local: bool
    has_api_key: bool
    last_tested_at: datetime | None
    last_successful_test_at: datetime | None
    last_test_success: bool | None
    created_at: datetime
    updated_at: datetime


class ModelCreate(BaseModel):
    provider_id: uuid.UUID
    model_name: str = Field(min_length=1, max_length=300)
    display_name: str | None = Field(default=None, max_length=300)
    enabled: bool = True
    supported_capabilities: list[str] = Field(default_factory=list)
    configuration: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def reject_credentials(self) -> "ModelCreate":
        _reject_secret_configuration(self.configuration)
        return self


class ModelUpdate(BaseModel):
    model_name: str | None = Field(default=None, min_length=1, max_length=300)
    display_name: str | None = Field(default=None, max_length=300)
    enabled: bool | None = None
    supported_capabilities: list[str] | None = None
    configuration: dict[str, Any] | None = None

    @model_validator(mode="after")
    def reject_credentials(self) -> "ModelUpdate":
        for field in ("model_name", "enabled", "supported_capabilities", "configuration"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        if self.configuration is not None:
            _reject_secret_configuration(self.configuration)
        return self


class ModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider_id: uuid.UUID
    model_name: str
    display_name: str | None
    enabled: bool
    supported_capabilities: list[str]
    created_at: datetime
    updated_at: datetime


class TaskConfigurationPut(BaseModel):
    provider_id: uuid.UUID
    model_id: uuid.UUID
    generation_settings: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_generation_settings(self) -> "TaskConfigurationPut":
        if set(self.generation_settings) - {"temperature", "max_tokens"}:
            raise ValueError("Generation settings may contain only temperature and max_tokens.")
        temperature = self.generation_settings.get("temperature")
        max_tokens = self.generation_settings.get("max_tokens")
        if temperature is not None and (
            isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not 0 <= temperature <= 2
        ):
            raise ValueError("temperature must be between 0 and 2.")
        if max_tokens is not None and (
            isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or not 1 <= max_tokens <= 32_768
        ):
            raise ValueError("max_tokens must be between 1 and 32768.")
        return self


class TaskConfigurationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    task_name: str
    provider_id: uuid.UUID
    model_id: uuid.UUID
    generation_settings: dict[str, Any]
    updated_at: datetime


class GenerationRequest(BaseModel):
    provider_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    task_name: str | None = None
    prompt: str = Field(min_length=1, max_length=1_000_000)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=32_768)

    @model_validator(mode="after")
    def require_selection(self) -> "GenerationRequest":
        if (self.provider_id is None) != (self.model_id is None):
            raise ValueError("provider_id and model_id must be supplied together.")
        if self.task_name is None and self.provider_id is None:
            raise ValueError("Select a task or explicitly provide a provider and model.")
        if self.task_name is not None and self.task_name not in TASK_NAMES:
            raise ValueError("Unknown AI task.")
        return self


class StructuredGenerationRequest(GenerationRequest):
    schema_name: Literal["text_component_extraction"] = "text_component_extraction"


class GenerationResponse(BaseModel):
    execution_id: uuid.UUID
    provider_id: uuid.UUID
    model_id: uuid.UUID
    model_name: str
    text: str
    parsed: dict[str, Any] | list[Any] | None = None
    validation_errors: list[str] = Field(default_factory=list)
    duration_ms: int
    token_usage: dict[str, Any] = Field(default_factory=dict)


class AIExecutionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    provider_id: uuid.UUID
    model_id: uuid.UUID
    task_name: str
    prompt_template_version: str | None
    output_schema_version: str | None
    processing_status: str
    execution_duration_ms: int
    token_usage: dict[str, Any]
    validation_outcome: str
    created_at: datetime


class Evidence(BaseModel):
    text: str = Field(min_length=1, max_length=5_000)
    section: str | None = Field(default=None, max_length=500)
    page: int | None = Field(default=None, ge=1)


class EngineeringValue(BaseModel):
    value: Any | None = None
    unit: str | None = None
    evidence: list[Evidence] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0, le=1)
    review_status: Literal["pending", "approved", "rejected"] = "pending"


class ComponentCandidate(BaseModel):
    component_type: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    tag: str | None = Field(default=None, max_length=200)
    properties: dict[str, EngineeringValue] = Field(default_factory=dict, max_length=200)
    evidence: list[Evidence] = Field(default_factory=list, max_length=100)
    confidence: float | None = Field(default=None, ge=0, le=1)
    uncertainty: list[str] = Field(default_factory=list, max_length=100)
    missing_information: list[str] = Field(default_factory=list, max_length=100)
    review_status: Literal["pending", "approved", "rejected"] = "pending"


class ExtractedRelationship(BaseModel):
    source_component_name: str = Field(min_length=1, max_length=200)
    target_component_name: str = Field(min_length=1, max_length=200)
    relationship_type: str = Field(min_length=1, max_length=100)
    evidence: list[Evidence] = Field(default_factory=list, max_length=100)
    review_status: Literal["pending", "approved", "rejected"] = "pending"


class RelationshipReview(BaseModel):
    review_status: Literal["pending", "approved", "rejected"]


class ExtractionResult(BaseModel):
    components: list[ComponentCandidate] = Field(default_factory=list, max_length=500)
    relationships: list[ExtractedRelationship] = Field(default_factory=list, max_length=500)
    warnings: list[str] = Field(default_factory=list, max_length=100)


class ExtractionRequest(BaseModel):
    revision_id: uuid.UUID
    provider_id: uuid.UUID | None = None
    model_id: uuid.UUID | None = None
    source_text: str = Field(min_length=1, max_length=1_000_000)
    source_name: str | None = Field(default=None, max_length=500)
    source_file_id: uuid.UUID | None = None


class CandidateReview(BaseModel):
    component_type: str | None = Field(default=None, min_length=1, max_length=100)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    tag: str | None = Field(default=None, max_length=200)
    properties: dict[str, EngineeringValue] | None = None
    evidence: list[Evidence] | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    uncertainty: list[str] | None = None
    missing_information: list[str] | None = None
    review_status: Literal["pending", "approved", "rejected"] | None = None

    @model_validator(mode="after")
    def reject_null_values(self) -> "CandidateReview":
        for field in (
            "component_type",
            "name",
            "properties",
            "evidence",
            "uncertainty",
            "missing_information",
            "review_status",
        ):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        return self


class ExtractionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    revision_id: uuid.UUID
    provider_id: uuid.UUID
    model_id: uuid.UUID
    execution_id: uuid.UUID
    task_name: str
    prompt_template_version: str
    output_schema_version: str
    source_reference: dict[str, Any]
    result: ExtractionResult
    processing_status: str
    execution_duration_ms: int
    token_usage: dict[str, Any]
    validation_outcome: str
    created_at: datetime


class ImportResponse(BaseModel):
    component_ids: list[uuid.UUID]
    imported_count: int
