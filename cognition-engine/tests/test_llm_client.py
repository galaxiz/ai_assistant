"""Tests for LLMClient and error mapping.

All LiteLLM network calls are mocked — no real API keys required.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cognition_engine import errors
from cognition_engine.llm_client import CompletionResult, LLMClient, _map_litellm_error
from cognition_engine.settings import Settings


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

MESSAGES = [{"role": "user", "content": "Hello!"}]


def _make_response(
    content: str = "Hi there!",
    model: str = "gemini/gemini-2.5-flash-preview-04-17",
    prompt_tokens: int = 10,
    completion_tokens: int = 5,
    finish_reason: str = "stop",
) -> MagicMock:
    """Build a fake litellm.ModelResponse-like object."""
    resp = MagicMock()
    resp.model = model
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    resp.choices[0].finish_reason = finish_reason
    resp.choices[0].delta.content = content  # used in streaming
    resp.usage = MagicMock()
    resp.usage.prompt_tokens = prompt_tokens
    resp.usage.completion_tokens = completion_tokens
    return resp


def _settings(**overrides: Any) -> Settings:
    return Settings(
        primary_model="gemini/gemini-2.5-flash-preview-04-17",
        fallback_model="gemini/gemini-2.0-flash",
        llm_max_retries=1,
        llm_timeout_seconds=10.0,
        **overrides,
    )


# ---------------------------------------------------------------------------
# complete() — happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_complete_returns_result() -> None:
    client = LLMClient(_settings())
    fake_resp = _make_response(content="Paris")

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=fake_resp):
        result = await client.complete(MESSAGES)

    assert isinstance(result, CompletionResult)
    assert result.content == "Paris"
    assert result.model_used == "gemini/gemini-2.5-flash-preview-04-17"
    assert result.input_tokens == 10
    assert result.output_tokens == 5
    assert result.total_tokens == 15
    assert result.finish_reason == "stop"


@pytest.mark.asyncio
async def test_complete_model_override() -> None:
    client = LLMClient(_settings())
    fake_resp = _make_response(model="gemini/gemini-2.0-flash")

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=fake_resp) as mock_call:
        await client.complete(MESSAGES, model="gemini/gemini-2.0-flash")

    call_kwargs = mock_call.call_args.kwargs
    assert call_kwargs["model"] == "gemini/gemini-2.0-flash"


@pytest.mark.asyncio
async def test_complete_passes_temperature_and_max_tokens() -> None:
    client = LLMClient(_settings())
    fake_resp = _make_response()

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=fake_resp) as mock_call:
        await client.complete(MESSAGES, temperature=0.1, max_tokens=256)

    kwargs = mock_call.call_args.kwargs
    assert kwargs["temperature"] == 0.1
    assert kwargs["max_tokens"] == 256


# ---------------------------------------------------------------------------
# complete() — fallback behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_complete_falls_back_on_primary_failure() -> None:
    """Primary fails with a rate-limit; fallback should be called and succeed."""
    import litellm as _ll

    client = LLMClient(_settings())
    fallback_resp = _make_response(content="fallback answer", model="gemini/gemini-2.0-flash")

    side_effects = [_ll.RateLimitError("rate limited", llm_provider="google", model="gemini"), fallback_resp]

    with patch("litellm.acompletion", new_callable=AsyncMock, side_effect=side_effects):
        result = await client.complete(MESSAGES)

    assert result.content == "fallback answer"


@pytest.mark.asyncio
async def test_complete_raises_all_models_failed_when_both_fail() -> None:
    import litellm as _ll

    client = LLMClient(_settings())
    err = _ll.RateLimitError("rate limited", llm_provider="google", model="gemini")

    with patch("litellm.acompletion", new_callable=AsyncMock, side_effect=err):
        with pytest.raises(errors.AllModelsFailedError):
            await client.complete(MESSAGES)


@pytest.mark.asyncio
async def test_complete_does_not_fallback_on_auth_error() -> None:
    """AuthError should short-circuit immediately — no point trying the fallback."""
    import litellm as _ll

    client = LLMClient(_settings())
    auth_err = _ll.AuthenticationError("bad key", llm_provider="google", model="gemini")

    with patch("litellm.acompletion", new_callable=AsyncMock, side_effect=auth_err) as mock_call:
        with pytest.raises(errors.AuthError):
            await client.complete(MESSAGES)

    # Only one call should have been made (no fallback attempt).
    assert mock_call.call_count == 1


# ---------------------------------------------------------------------------
# stream_complete()
# ---------------------------------------------------------------------------


async def _fake_aiter(chunks: list[str]):
    """Async generator that yields fake stream chunks."""
    for text in chunks:
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = text
        yield chunk


@pytest.mark.asyncio
async def test_stream_complete_yields_chunks() -> None:
    client = LLMClient(_settings())
    fake_stream = _fake_aiter(["Hello", ", ", "world", "!"])

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=fake_stream):
        stream = await client.stream_complete(MESSAGES)
        collected = [chunk async for chunk in stream]

    assert collected == ["Hello", ", ", "world", "!"]


@pytest.mark.asyncio
async def test_stream_complete_skips_empty_chunks() -> None:
    client = LLMClient(_settings())

    async def _aiter_with_nones():
        for text in [None, "Hello", None, "!"]:
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = text
            yield chunk

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=_aiter_with_nones()):
        stream = await client.stream_complete(MESSAGES)
        collected = [chunk async for chunk in stream]

    assert collected == ["Hello", "!"]


# ---------------------------------------------------------------------------
# _map_litellm_error()
# ---------------------------------------------------------------------------


def _make_litellm_error(cls_name: str, message: str = "err") -> Exception:
    """Dynamically fabricate a fake exception that looks like a LiteLLM one."""
    exc_cls = type(cls_name, (Exception,), {})
    return exc_cls(message)


@pytest.mark.parametrize(
    ("exc_type_name", "expected_error_cls"),
    [
        ("RateLimitError", errors.RateLimitError),
        ("ContextWindowExceededError", errors.TokenLimitError),
        ("AuthenticationError", errors.AuthError),
        ("ServiceUnavailableError", errors.ModelUnavailableError),
        ("Timeout", errors.TimeoutError),
        ("SomeUnknownError", errors.LLMError),
    ],
)
def test_map_litellm_error(exc_type_name: str, expected_error_cls: type) -> None:
    exc = _make_litellm_error(exc_type_name)
    mapped = _map_litellm_error(exc, model="test-model")
    assert isinstance(mapped, expected_error_cls)
    assert mapped.model == "test-model"


def test_map_litellm_error_real_rate_limit() -> None:
    """Test against the real litellm.RateLimitError class."""
    import litellm as _ll

    exc = _ll.RateLimitError("too many requests", llm_provider="google", model="gemini")
    mapped = _map_litellm_error(exc, model="gemini/gemini-2.5-flash-preview-04-17")
    assert isinstance(mapped, errors.RateLimitError)


# ---------------------------------------------------------------------------
# CompletionResult
# ---------------------------------------------------------------------------


def test_completion_result_total_tokens() -> None:
    r = CompletionResult(
        content="hi",
        model_used="gemini/gemini-2.5-flash-preview-04-17",
        input_tokens=100,
        output_tokens=20,
        finish_reason="stop",
    )
    assert r.total_tokens == 120
