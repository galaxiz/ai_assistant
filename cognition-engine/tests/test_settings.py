"""Tests for Settings."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from cognition_engine.settings import Settings


def test_defaults() -> None:
    s = Settings()
    assert s.grpc_port == 50051
    assert s.grpc_host == "0.0.0.0"
    assert "gemini" in s.primary_model
    assert "gemini" in s.fallback_model
    assert s.log_level == "INFO"
    assert s.log_format == "json"


def test_grpc_address() -> None:
    s = Settings(grpc_host="127.0.0.1", grpc_port=9090)
    assert s.grpc_address == "127.0.0.1:9090"


def test_prompt_token_budget() -> None:
    s = Settings(max_context_tokens=100_000, max_completion_tokens=10_000)
    assert s.prompt_token_budget == 90_000


def test_invalid_log_level() -> None:
    with pytest.raises(ValidationError):
        Settings(log_level="VERBOSE")


def test_invalid_log_format() -> None:
    with pytest.raises(ValidationError):
        Settings(log_format="xml")


def test_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CE_GRPC_PORT", "12345")
    monkeypatch.setenv("CE_LOG_LEVEL", "DEBUG")
    s = Settings()
    assert s.grpc_port == 12345
    assert s.log_level == "DEBUG"
