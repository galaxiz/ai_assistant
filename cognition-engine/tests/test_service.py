"""
Tests for CognitionServicer.

All tests call servicer methods directly (no live gRPC server).
LLMClient and OutputParser network calls are mocked.
"""

from __future__ import annotations

from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import grpc
import pytest

from cognition_engine.generated import cognition_pb2
from cognition_engine.llm_client import CompletionResult, LLMClient
from cognition_engine.output_parser import OutputParser
from cognition_engine.service import CognitionServicer, _status_for, _proto_messages_to_dicts
from cognition_engine.settings import Settings
from cognition_engine import errors
from cognition_engine.token_counter import TokenCounter


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------

MODEL = "gemini/gemini-2.5-flash-preview-04-17"


def _settings() -> Settings:
    return Settings(
        primary_model=MODEL,
        fallback_model="gemini/gemini-2.0-flash",
        max_context_tokens=10_000,
        max_completion_tokens=500,
    )


def _make_ctx() -> MagicMock:
    """Fake gRPC servicer context."""
    ctx = MagicMock()
    ctx.abort = AsyncMock()
    return ctx


def _make_request_context(session_id: str = "sess-001") -> cognition_pb2.RequestContext:
    return cognition_pb2.RequestContext(session_id=session_id)


def _make_completion_result(content: str = "Hello!") -> CompletionResult:
    return CompletionResult(
        content=content,
        model_used=MODEL,
        input_tokens=10,
        output_tokens=5,
        finish_reason="stop",
    )


def _make_servicer(llm_client: Any = None, output_parser: Any = None) -> CognitionServicer:
    settings = _settings()
    llm = llm_client or MagicMock(spec=LLMClient)
    counter = TokenCounter(model=MODEL, max_context_tokens=settings.max_context_tokens)
    parser = output_parser or OutputParser(settings, llm_client=llm)
    return CognitionServicer(
        settings=settings,
        llm_client=llm,
        token_counter=counter,
        output_parser=parser,
    )


MESSAGES = [
    cognition_pb2.Message(role="user", content="What is the capital of France?")
]


# ---------------------------------------------------------------------------
# _proto_messages_to_dicts
# ---------------------------------------------------------------------------


def test_proto_messages_to_dicts() -> None:
    msgs = [
        cognition_pb2.Message(role="system", content="You are helpful."),
        cognition_pb2.Message(role="user", content="Hi!"),
    ]
    result = _proto_messages_to_dicts(msgs)
    assert result == [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "Hi!"},
    ]


def test_proto_messages_to_dicts_empty() -> None:
    assert _proto_messages_to_dicts([]) == []


# ---------------------------------------------------------------------------
# _status_for
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("exc", "expected_code"),
    [
        (errors.RateLimitError("x"), grpc.StatusCode.RESOURCE_EXHAUSTED),
        (errors.TokenLimitError("x"), grpc.StatusCode.INVALID_ARGUMENT),
        (errors.AuthError("x"), grpc.StatusCode.UNAUTHENTICATED),
        (errors.ModelUnavailableError("x"), grpc.StatusCode.UNAVAILABLE),
        (errors.AllModelsFailedError("x"), grpc.StatusCode.UNAVAILABLE),
        (errors.TimeoutError("x"), grpc.StatusCode.DEADLINE_EXCEEDED),
        (errors.ParseError("x"), grpc.StatusCode.INVALID_ARGUMENT),
        (errors.SchemaValidationError("x"), grpc.StatusCode.INVALID_ARGUMENT),
        (errors.TemplateNotFoundError("x"), grpc.StatusCode.NOT_FOUND),
        (errors.LLMError("x"), grpc.StatusCode.INTERNAL),
        (errors.CognitionError("x"), grpc.StatusCode.INTERNAL),
        (ValueError("unknown"), grpc.StatusCode.INTERNAL),
    ],
)
def test_status_for(exc: Exception, expected_code: grpc.StatusCode) -> None:
    assert _status_for(exc) == expected_code


# ---------------------------------------------------------------------------
# Complete RPC
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_complete_success() -> None:
    mock_llm = MagicMock(spec=LLMClient)
    mock_llm.complete = AsyncMock(return_value=_make_completion_result("Paris"))
    servicer = _make_servicer(llm_client=mock_llm)

    request = cognition_pb2.CompleteRequest(
        context=_make_request_context("s1"),
        messages=MESSAGES,
    )
    response = await servicer.Complete(request, _make_ctx())

    assert response.content == "Paris"
    assert response.model_used == MODEL
    assert response.input_tokens == 10
    assert response.output_tokens == 5
    assert response.finish_reason == "stop"


@pytest.mark.asyncio
async def test_complete_passes_model_override() -> None:
    mock_llm = MagicMock(spec=LLMClient)
    mock_llm.complete = AsyncMock(return_value=_make_completion_result())
    servicer = _make_servicer(llm_client=mock_llm)

    request = cognition_pb2.CompleteRequest(
        context=_make_request_context(),
        messages=MESSAGES,
        model="gemini/gemini-2.0-flash",
        temperature=0.2,
        max_tokens=256,
    )
    await servicer.Complete(request, _make_ctx())

    call_kwargs = mock_llm.complete.call_args.kwargs
    assert call_kwargs["model"] == "gemini/gemini-2.0-flash"
    assert call_kwargs["temperature"] == pytest.approx(0.2, abs=0.01)
    assert call_kwargs["max_tokens"] == 256


@pytest.mark.asyncio
async def test_complete_error_calls_abort() -> None:
    mock_llm = MagicMock(spec=LLMClient)
    mock_llm.complete = AsyncMock(
        side_effect=errors.RateLimitError("rate limited")
    )
    servicer = _make_servicer(llm_client=mock_llm)
    ctx = _make_ctx()

    request = cognition_pb2.CompleteRequest(
        context=_make_request_context(), messages=MESSAGES
    )
    await servicer.Complete(request, ctx)

    ctx.abort.assert_called_once_with(grpc.StatusCode.RESOURCE_EXHAUSTED, "rate limited")


# ---------------------------------------------------------------------------
# StreamComplete RPC
# ---------------------------------------------------------------------------


async def _fake_stream(chunks: list[str]) -> AsyncIterator[str]:
    for c in chunks:
        yield c


@pytest.mark.asyncio
async def test_stream_complete_yields_chunks_and_sentinel() -> None:
    mock_llm = MagicMock(spec=LLMClient)
    mock_llm.stream_complete = AsyncMock(
        return_value=_fake_stream(["Hello", ", ", "world!"])
    )
    servicer = _make_servicer(llm_client=mock_llm)

    request = cognition_pb2.CompleteRequest(
        context=_make_request_context(), messages=MESSAGES
    )
    chunks = [c async for c in servicer.StreamComplete(request, _make_ctx())]

    contents = [c.content for c in chunks]
    done_flags = [c.done for c in chunks]

    assert contents == ["Hello", ", ", "world!", ""]
    assert done_flags == [False, False, False, True]


@pytest.mark.asyncio
async def test_stream_complete_error_calls_abort() -> None:
    mock_llm = MagicMock(spec=LLMClient)
    mock_llm.stream_complete = AsyncMock(
        side_effect=errors.ModelUnavailableError("down")
    )
    servicer = _make_servicer(llm_client=mock_llm)
    ctx = _make_ctx()

    request = cognition_pb2.CompleteRequest(
        context=_make_request_context(), messages=MESSAGES
    )
    # Consume the generator to trigger the error handler.
    _ = [c async for c in servicer.StreamComplete(request, ctx)]
    ctx.abort.assert_called_once_with(grpc.StatusCode.UNAVAILABLE, "down")


# ---------------------------------------------------------------------------
# CountTokens RPC
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_count_tokens_basic() -> None:
    servicer = _make_servicer()
    request = cognition_pb2.CountTokensRequest(
        context=_make_request_context(),
        messages=MESSAGES,
    )
    response = await servicer.CountTokens(request, _make_ctx())

    assert response.token_count > 0
    assert response.fits_budget is True
    assert response.remaining_tokens > 0


@pytest.mark.asyncio
async def test_count_tokens_remaining_is_nonnegative() -> None:
    servicer = _make_servicer()
    # Very long content — should still return 0, never negative.
    long_msg = cognition_pb2.Message(role="user", content="word " * 100_000)
    request = cognition_pb2.CountTokensRequest(
        context=_make_request_context(),
        messages=[long_msg],
    )
    response = await servicer.CountTokens(request, _make_ctx())
    assert response.remaining_tokens >= 0


# ---------------------------------------------------------------------------
# ParseOutput RPC — no schema
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_output_raw_json() -> None:
    servicer = _make_servicer()
    request = cognition_pb2.ParseOutputRequest(
        context=_make_request_context(),
        raw_response='{"city": "Paris", "pop": 2161000}',
    )
    response = await servicer.ParseOutput(request, _make_ctx())
    import json
    parsed = json.loads(response.parsed_json)
    assert parsed["city"] == "Paris"
    assert response.repaired is False


@pytest.mark.asyncio
async def test_parse_output_from_fence() -> None:
    servicer = _make_servicer()
    request = cognition_pb2.ParseOutputRequest(
        context=_make_request_context(),
        raw_response='```json\n{"key": "value"}\n```',
    )
    response = await servicer.ParseOutput(request, _make_ctx())
    import json
    assert json.loads(response.parsed_json)["key"] == "value"


@pytest.mark.asyncio
async def test_parse_output_garbage_calls_abort() -> None:
    servicer = _make_servicer()
    ctx = _make_ctx()
    request = cognition_pb2.ParseOutputRequest(
        context=_make_request_context(),
        raw_response="This is just plain prose, no JSON here.",
    )
    await servicer.ParseOutput(request, ctx)
    ctx.abort.assert_called_once()
    assert ctx.abort.call_args.args[0] == grpc.StatusCode.INVALID_ARGUMENT
