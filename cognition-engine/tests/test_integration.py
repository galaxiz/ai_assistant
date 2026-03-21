"""
Integration tests for the Cognition Engine gRPC server.

These tests start a real grpc.aio server on a random local port, build a real
channel + stub, and exercise each RPC end-to-end.  The LLM provider calls
(litellm.acompletion) are mocked so no API keys are required.

Run with:
    .venv/bin/python -m pytest tests/test_integration.py -v
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import grpc
import pytest
from grpc import aio

from cognition_engine.generated import cognition_pb2, cognition_pb2_grpc
from cognition_engine.llm_client import CompletionResult, LLMClient
from cognition_engine.output_parser import OutputParser
from cognition_engine.service import CognitionServicer
from cognition_engine.settings import Settings
from cognition_engine.token_counter import TokenCounter

# ---------------------------------------------------------------------------
# Shared test data
# ---------------------------------------------------------------------------

MODEL = "gemini/gemini-2.5-flash-preview-04-17"
SESSION_CTX = cognition_pb2.RequestContext(session_id="integration-test")
USER_MESSAGES = [cognition_pb2.Message(role="user", content="What is the capital of France?")]


def _make_completion_result(content: str = "Paris.") -> CompletionResult:
    return CompletionResult(
        content=content,
        model_used=MODEL,
        input_tokens=12,
        output_tokens=4,
        finish_reason="stop",
    )


async def _fake_stream(chunks: list[str]):
    """Async generator that yields litellm-style chunk objects."""
    for c in chunks:
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = c
        yield chunk


# ---------------------------------------------------------------------------
# Server fixture
# ---------------------------------------------------------------------------


@pytest.fixture()
async def grpc_stub():
    """
    Start a real gRPC server on a random local port.

    Yields a ``CognitionServiceStub`` connected to it.
    Tears down the server after the test.
    """
    settings = Settings(
        primary_model=MODEL,
        fallback_model="gemini/gemini-2.0-flash",
        max_context_tokens=10_000,
        max_completion_tokens=500,
        llm_max_retries=1,
    )

    # Build components
    llm_client = LLMClient(settings)
    token_counter = TokenCounter(model=MODEL, max_context_tokens=settings.max_context_tokens)
    output_parser = OutputParser(settings, llm_client=llm_client)
    servicer = CognitionServicer(
        settings=settings,
        llm_client=llm_client,
        token_counter=token_counter,
        output_parser=output_parser,
    )

    # Start server on a random port (port 0 → OS assigns one).
    server = aio.server()
    cognition_pb2_grpc.add_CognitionServiceServicer_to_server(servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()

    # Build client channel and stub.
    channel = aio.insecure_channel(f"127.0.0.1:{port}")
    stub = cognition_pb2_grpc.CognitionServiceStub(channel)

    yield stub

    await channel.close()
    await server.stop(grace=0)


# ---------------------------------------------------------------------------
# Complete RPC
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_complete_success(grpc_stub) -> None:
    fake_resp = MagicMock()
    fake_resp.model = MODEL
    fake_resp.choices = [MagicMock()]
    fake_resp.choices[0].message.content = "Paris"
    fake_resp.choices[0].finish_reason = "stop"
    fake_resp.usage = MagicMock(prompt_tokens=12, completion_tokens=2)

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=fake_resp):
        response = await grpc_stub.Complete(
            cognition_pb2.CompleteRequest(
                context=SESSION_CTX,
                messages=USER_MESSAGES,
            )
        )

    assert response.content == "Paris"
    assert response.finish_reason == "stop"
    assert response.input_tokens == 12
    assert response.output_tokens == 2


@pytest.mark.asyncio
async def test_integration_complete_rate_limit_returns_grpc_error(grpc_stub) -> None:
    import litellm as _ll

    err = _ll.RateLimitError("too many requests", llm_provider="google", model=MODEL)

    with patch("litellm.acompletion", new_callable=AsyncMock, side_effect=err):
        with pytest.raises(grpc.RpcError) as exc_info:
            await grpc_stub.Complete(
                cognition_pb2.CompleteRequest(
                    context=SESSION_CTX,
                    messages=USER_MESSAGES,
                )
            )
    # Both primary and fallback fail → AllModelsFailedError → UNAVAILABLE.
    assert exc_info.value.code() == grpc.StatusCode.UNAVAILABLE


@pytest.mark.asyncio
async def test_integration_complete_passthrough_model_and_temperature(grpc_stub) -> None:
    fake_resp = MagicMock()
    fake_resp.model = "gemini/gemini-2.0-flash"
    fake_resp.choices = [MagicMock()]
    fake_resp.choices[0].message.content = "42"
    fake_resp.choices[0].finish_reason = "stop"
    fake_resp.usage = MagicMock(prompt_tokens=5, completion_tokens=1)

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=fake_resp) as mock_call:
        await grpc_stub.Complete(
            cognition_pb2.CompleteRequest(
                context=SESSION_CTX,
                messages=USER_MESSAGES,
                model="gemini/gemini-2.0-flash",
                temperature=0.1,
                max_tokens=128,
            )
        )

    kwargs = mock_call.call_args.kwargs
    assert kwargs["model"] == "gemini/gemini-2.0-flash"
    assert kwargs["temperature"] == pytest.approx(0.1, abs=0.01)
    assert kwargs["max_tokens"] == 128


# ---------------------------------------------------------------------------
# StreamComplete RPC
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_stream_complete(grpc_stub) -> None:
    stream_chunks = _fake_stream(["Bonjour", " ", "monde"])

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=stream_chunks):
        received: list[str] = []
        done_count = 0
        async for chunk in grpc_stub.StreamComplete(
            cognition_pb2.CompleteRequest(
                context=SESSION_CTX,
                messages=USER_MESSAGES,
            )
        ):
            if chunk.done:
                done_count += 1
            else:
                received.append(chunk.content)

    assert received == ["Bonjour", " ", "monde"]
    assert done_count == 1, "Expected exactly one done=True sentinel chunk"


@pytest.mark.asyncio
async def test_integration_stream_complete_empty_stream(grpc_stub) -> None:
    async def _empty_aiter():
        return
        yield  # make it an async generator

    with patch("litellm.acompletion", new_callable=AsyncMock, return_value=_empty_aiter()):
        chunks = [
            c async for c in grpc_stub.StreamComplete(
                cognition_pb2.CompleteRequest(context=SESSION_CTX, messages=USER_MESSAGES)
            )
        ]

    # Only the sentinel chunk should be present.
    assert len(chunks) == 1
    assert chunks[0].done is True
    assert chunks[0].content == ""


# ---------------------------------------------------------------------------
# CountTokens RPC
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_count_tokens(grpc_stub) -> None:
    response = await grpc_stub.CountTokens(
        cognition_pb2.CountTokensRequest(
            context=SESSION_CTX,
            messages=USER_MESSAGES,
        )
    )
    assert response.token_count > 0
    assert response.fits_budget is True
    assert response.remaining_tokens > 0
    assert response.token_count + response.remaining_tokens <= 10_000


@pytest.mark.asyncio
async def test_integration_count_tokens_deterministic(grpc_stub) -> None:
    """Same input must produce the same token count across two calls."""
    request = cognition_pb2.CountTokensRequest(
        context=SESSION_CTX,
        messages=USER_MESSAGES,
    )
    r1 = await grpc_stub.CountTokens(request)
    r2 = await grpc_stub.CountTokens(request)
    assert r1.token_count == r2.token_count


# ---------------------------------------------------------------------------
# ParseOutput RPC
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_parse_output_clean_json(grpc_stub) -> None:
    payload = json.dumps({"city": "Paris", "country": "France"})
    response = await grpc_stub.ParseOutput(
        cognition_pb2.ParseOutputRequest(
            context=SESSION_CTX,
            raw_response=payload,
        )
    )
    parsed = json.loads(response.parsed_json)
    assert parsed["city"] == "Paris"
    assert response.repaired is False


@pytest.mark.asyncio
async def test_integration_parse_output_fenced_json(grpc_stub) -> None:
    raw = '```json\n{"answer": 42}\n```'
    response = await grpc_stub.ParseOutput(
        cognition_pb2.ParseOutputRequest(context=SESSION_CTX, raw_response=raw)
    )
    assert json.loads(response.parsed_json)["answer"] == 42


@pytest.mark.asyncio
async def test_integration_parse_output_repaired_json(grpc_stub) -> None:
    raw = '{"city": "Lyon", "pop": 500000,}'  # trailing comma
    response = await grpc_stub.ParseOutput(
        cognition_pb2.ParseOutputRequest(context=SESSION_CTX, raw_response=raw)
    )
    parsed = json.loads(response.parsed_json)
    assert parsed["city"] == "Lyon"
    assert response.repaired is True


@pytest.mark.asyncio
async def test_integration_parse_output_garbage_raises_grpc_error(grpc_stub) -> None:
    with pytest.raises(grpc.RpcError) as exc_info:
        await grpc_stub.ParseOutput(
            cognition_pb2.ParseOutputRequest(
                context=SESSION_CTX,
                raw_response="This is not JSON at all. Just prose.",
            )
        )
    assert exc_info.value.code() == grpc.StatusCode.INVALID_ARGUMENT


@pytest.mark.asyncio
async def test_integration_parse_output_parse_array(grpc_stub) -> None:
    raw = '[1, 2, 3]'
    response = await grpc_stub.ParseOutput(
        cognition_pb2.ParseOutputRequest(context=SESSION_CTX, raw_response=raw)
    )
    assert json.loads(response.parsed_json) == [1, 2, 3]
