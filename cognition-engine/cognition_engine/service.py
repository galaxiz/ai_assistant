"""
gRPC service implementation for the Cognition Engine.

Translates protobuf ``CognitionService`` RPCs into calls against the Python
engine components (LLMClient, TokenCounter, OutputParser) and maps our typed
error hierarchy to the appropriate gRPC status codes.

The servicer is intentionally stateless — all state (settings, model clients)
is injected at construction time, making it straightforward to unit-test by
calling methods directly without a running server.
"""

from __future__ import annotations

import json
from typing import Any

import grpc
import structlog
from grpc import aio

from cognition_engine import errors
from cognition_engine.generated import cognition_pb2, cognition_pb2_grpc
from cognition_engine.llm_client import LLMClient
from cognition_engine.output_parser import OutputParser
from cognition_engine.settings import Settings
from cognition_engine.token_counter import TokenCounter

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Error → gRPC status code mapping
# ---------------------------------------------------------------------------

_ERROR_TO_STATUS: dict[type[errors.CognitionError], grpc.StatusCode] = {
    errors.RateLimitError:         grpc.StatusCode.RESOURCE_EXHAUSTED,
    errors.TokenLimitError:        grpc.StatusCode.INVALID_ARGUMENT,
    errors.AuthError:              grpc.StatusCode.UNAUTHENTICATED,
    errors.ModelUnavailableError:  grpc.StatusCode.UNAVAILABLE,
    errors.AllModelsFailedError:   grpc.StatusCode.UNAVAILABLE,
    errors.TimeoutError:           grpc.StatusCode.DEADLINE_EXCEEDED,
    errors.ParseError:             grpc.StatusCode.INVALID_ARGUMENT,
    errors.SchemaValidationError:  grpc.StatusCode.INVALID_ARGUMENT,
    errors.TemplateNotFoundError:  grpc.StatusCode.NOT_FOUND,
    errors.TemplateError:          grpc.StatusCode.INTERNAL,
    errors.LLMError:               grpc.StatusCode.INTERNAL,
    errors.CognitionError:         grpc.StatusCode.INTERNAL,
}


def _status_for(exc: Exception) -> grpc.StatusCode:
    """Return the most specific matching gRPC status code for ``exc``."""
    for exc_type, code in _ERROR_TO_STATUS.items():
        if isinstance(exc, exc_type):
            return code
    return grpc.StatusCode.INTERNAL


def _abort(context: aio.ServicerContext, exc: Exception) -> None:
    """Set a gRPC error status on the context (async abort is awaited by caller)."""
    code = _status_for(exc)
    log.warning(
        "gRPC request failed",
        error_type=type(exc).__name__,
        grpc_code=code.name,
        detail=str(exc),
    )
    # We raise ServicerContext.abort() — callers must await it.
    raise _AbortCalled(code, str(exc))


class _AbortCalled(Exception):
    """Internal sentinel raised when we want to abort the gRPC call."""
    def __init__(self, code: grpc.StatusCode, details: str) -> None:
        self.code = code
        self.details = details


# ---------------------------------------------------------------------------
# Helper: decode a proto message list
# ---------------------------------------------------------------------------


def _proto_messages_to_dicts(
    proto_messages: Any,
) -> list[dict[str, str]]:
    return [{"role": m.role, "content": m.content} for m in proto_messages]


# ---------------------------------------------------------------------------
# Servicer
# ---------------------------------------------------------------------------


class CognitionServicer(cognition_pb2_grpc.CognitionServiceServicer):
    """
    Implements the four CognitionService RPCs.

    Args:
        settings:       Runtime config.
        llm_client:     Pre-built LLM client.
        token_counter:  Pre-built token counter.
        output_parser:  Pre-built output parser.
    """

    def __init__(
        self,
        settings: Settings,
        llm_client: LLMClient,
        token_counter: TokenCounter,
        output_parser: OutputParser,
    ) -> None:
        self._settings = settings
        self._llm = llm_client
        self._counter = token_counter
        self._parser = output_parser

    # ------------------------------------------------------------------
    # Complete
    # ------------------------------------------------------------------

    async def Complete(
        self,
        request: cognition_pb2.CompleteRequest,
        context: aio.ServicerContext,
    ) -> cognition_pb2.CompleteResponse:
        session_id = request.context.session_id
        log.info("Complete RPC", session_id=session_id)

        messages = _proto_messages_to_dicts(request.messages)
        kwargs: dict[str, Any] = {}
        if request.model:
            kwargs["model"] = request.model
        if request.temperature:
            kwargs["temperature"] = request.temperature
        if request.max_tokens:
            kwargs["max_tokens"] = request.max_tokens

        try:
            result = await self._llm.complete(messages, **kwargs)
        except errors.CognitionError as exc:
            await context.abort(_status_for(exc), str(exc))
            return cognition_pb2.CompleteResponse()  # unreachable

        return cognition_pb2.CompleteResponse(
            content=result.content,
            model_used=result.model_used,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            finish_reason=result.finish_reason,
        )

    # ------------------------------------------------------------------
    # StreamComplete
    # ------------------------------------------------------------------

    async def StreamComplete(
        self,
        request: cognition_pb2.CompleteRequest,
        context: aio.ServicerContext,
    ):
        session_id = request.context.session_id
        log.info("StreamComplete RPC", session_id=session_id)

        messages = _proto_messages_to_dicts(request.messages)
        kwargs: dict[str, Any] = {}
        if request.model:
            kwargs["model"] = request.model
        if request.temperature:
            kwargs["temperature"] = request.temperature
        if request.max_tokens:
            kwargs["max_tokens"] = request.max_tokens

        try:
            stream = await self._llm.stream_complete(messages, **kwargs)
            async for chunk in stream:
                yield cognition_pb2.StreamChunk(content=chunk, done=False)
            # Sentinel: signal end of stream.
            yield cognition_pb2.StreamChunk(content="", done=True)
        except errors.CognitionError as exc:
            await context.abort(_status_for(exc), str(exc))

    # ------------------------------------------------------------------
    # CountTokens
    # ------------------------------------------------------------------

    async def CountTokens(
        self,
        request: cognition_pb2.CountTokensRequest,
        context: aio.ServicerContext,
    ) -> cognition_pb2.CountTokensResponse:
        session_id = request.context.session_id
        log.debug("CountTokens RPC", session_id=session_id)

        messages = _proto_messages_to_dicts(request.messages)

        # If the caller requested a different model, we can't re-initialise
        # the TokenCounter cheaply, so we use the server's default counter
        # and note the model in the log if it differs.
        if request.model and request.model != self._settings.primary_model:
            log.debug(
                "CountTokens: model mismatch, using server default",
                requested=request.model,
                using=self._settings.primary_model,
            )

        token_count = self._counter.count_messages(messages)
        remaining = self._counter.remaining_tokens(
            messages, completion_budget=self._settings.max_completion_tokens
        )

        return cognition_pb2.CountTokensResponse(
            token_count=token_count,
            fits_budget=remaining > 0,
            remaining_tokens=remaining,
        )

    # ------------------------------------------------------------------
    # ParseOutput
    # ------------------------------------------------------------------

    async def ParseOutput(
        self,
        request: cognition_pb2.ParseOutputRequest,
        context: aio.ServicerContext,
    ) -> cognition_pb2.ParseOutputResponse:
        session_id = request.context.session_id
        log.info("ParseOutput RPC", session_id=session_id)

        context_messages = (
            _proto_messages_to_dicts(request.context_messages)
            if request.context_messages
            else None
        )

        # Build a dynamic Pydantic model if a JSON Schema was provided,
        # otherwise parse into a plain dict.
        schema_json = request.schema_json.strip() if request.schema_json else ""

        try:
            if schema_json:
                from pydantic import create_model
                parsed_json_str = await self._parse_with_schema(
                    request.raw_response,
                    schema_json,
                    context_messages,
                )
            else:
                parsed_json_str, repaired, re_prompted = await self._parse_any_json(
                    request.raw_response,
                    context_messages,
                )
                return cognition_pb2.ParseOutputResponse(
                    parsed_json=parsed_json_str,
                    repaired=repaired,
                    re_prompted=re_prompted,
                )

        except errors.ParseError as exc:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            return cognition_pb2.ParseOutputResponse()
        except errors.SchemaValidationError as exc:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            return cognition_pb2.ParseOutputResponse()
        except Exception as exc:  # noqa: BLE001
            await context.abort(grpc.StatusCode.INTERNAL, str(exc))
            return cognition_pb2.ParseOutputResponse()

        return cognition_pb2.ParseOutputResponse(
            parsed_json=parsed_json_str,
            repaired=False,
            re_prompted=False,
        )

    async def _parse_with_schema(
        self,
        raw: str,
        schema_json: str,
        context_messages: list[dict[str, str]] | None,
    ) -> str:
        """
        Parse ``raw`` and validate it against a JSON Schema string.

        Uses a Pydantic TypeAdapter so we don't need to define a static model.
        Returns the validated JSON as a compact string.
        """
        from pydantic import TypeAdapter

        try:
            schema = json.loads(schema_json)
        except json.JSONDecodeError as exc:
            raise errors.ParseError(
                f"schema_json is not valid JSON: {exc}"
            ) from exc

        # Extract + repair the raw response first.
        _, parsed_obj = self._parser._try_extract_and_parse(raw)  # type: ignore[attr-defined]
        if parsed_obj is None:
            raise errors.ParseError(
                "Could not extract JSON from raw response.", raw_response=raw
            )

        # Validate against the schema using jsonschema if available,
        # otherwise trust the extraction.
        try:
            import jsonschema
            jsonschema.validate(instance=parsed_obj, schema=schema)
        except ImportError:
            pass  # jsonschema not installed — skip schema validation
        except Exception as exc:  # noqa: BLE001
            raise errors.SchemaValidationError(
                f"JSON did not match provided schema: {exc}", raw_response=raw
            ) from exc

        return json.dumps(parsed_obj, ensure_ascii=False)

    async def _parse_any_json(
        self,
        raw: str,
        context_messages: list[dict[str, str]] | None,
    ) -> tuple[str, bool, bool]:
        """Extract and repair JSON without schema validation."""
        from cognition_engine.output_parser import _extract_json_candidates, _repair_json

        candidates = _extract_json_candidates(raw)
        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
                return json.dumps(parsed, ensure_ascii=False), False, False
            except json.JSONDecodeError:
                repaired = _repair_json(candidate)
                try:
                    parsed = json.loads(repaired)
                    return json.dumps(parsed, ensure_ascii=False), True, False
                except json.JSONDecodeError:
                    continue

        raise errors.ParseError(
            "Could not extract valid JSON from raw response.", raw_response=raw
        )
