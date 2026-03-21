"""
Settings for the Cognition Engine.

All values can be overridden via environment variables or a .env file.
Prefix: CE_ (e.g. CE_GRPC_PORT=50051)
"""

from __future__ import annotations

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration loaded from environment / .env."""

    model_config = SettingsConfigDict(
        env_prefix="CE_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # gRPC server
    # ------------------------------------------------------------------
    grpc_host: str = Field(default="0.0.0.0", description="gRPC listen host.")
    grpc_port: int = Field(default=50051, description="gRPC listen port.")

    # ------------------------------------------------------------------
    # LLM models
    # ------------------------------------------------------------------
    primary_model: str = Field(
        default="gemini/gemini-2.5-flash-preview-04-17",
        description="Primary LLM model (LiteLLM model string).",
    )
    fallback_model: str = Field(
        default="gemini/gemini-2.0-flash",
        description="Fallback LLM model used when primary fails.",
    )

    # ------------------------------------------------------------------
    # Token budget
    # ------------------------------------------------------------------
    max_context_tokens: int = Field(
        default=1_000_000,
        description="Max context window for the primary model (in tokens).",
    )
    max_completion_tokens: int = Field(
        default=8_192,
        description="Max tokens to allocate for the completion.",
    )

    # ------------------------------------------------------------------
    # Retry / resilience
    # ------------------------------------------------------------------
    llm_max_retries: int = Field(default=3, description="Max LLM call retries.")
    llm_timeout_seconds: float = Field(default=60.0, description="LLM call timeout.")

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------
    log_level: str = Field(default="INFO", description="Log level (DEBUG/INFO/WARNING/ERROR).")
    log_format: str = Field(
        default="json",
        description="Log format: 'json' for structured output, 'console' for human-readable.",
    )

    # ------------------------------------------------------------------
    # API keys (pulled from env, never hardcoded)
    # ------------------------------------------------------------------
    google_api_key: str | None = Field(
        default=None,
        description="Google AI Studio / Vertex API key for Gemini. "
        "Also readable as GOOGLE_API_KEY by LiteLLM.",
    )

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, v: str) -> str:
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        upper = v.upper()
        if upper not in allowed:
            raise ValueError(f"log_level must be one of {allowed}, got {v!r}")
        return upper

    @field_validator("log_format")
    @classmethod
    def _validate_log_format(cls, v: str) -> str:
        allowed = {"json", "console"}
        lower = v.lower()
        if lower not in allowed:
            raise ValueError(f"log_format must be one of {allowed}, got {v!r}")
        return lower

    @property
    def grpc_address(self) -> str:
        """Combined host:port string for the gRPC server."""
        return f"{self.grpc_host}:{self.grpc_port}"

    @property
    def prompt_token_budget(self) -> int:
        """Max tokens available for the prompt (context minus completion headroom)."""
        return self.max_context_tokens - self.max_completion_tokens
