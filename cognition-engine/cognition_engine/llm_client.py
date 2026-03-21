"""
LLM client for the Cognition Engine.

Wraps LiteLLM to provide a single async interface for chat completions,
with automatic retry and model fallback.

Usage:
    from cognition_engine.llm_client import LLMClient, CompletionResult
    from cognition_engine.settings import Settings

    client = LLMClient(Settings())

    # One-shot completion
    result: CompletionResult = await client.complete(messages)
    print(result.content, result.model_used, result.input_tokens)

    # Streamed completion
    async for chunk in client.stream_complete(messages):
        print(chunk, end="", flush=True)
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import litellm
import structlog

from cognition_engine import errors
from cognition_engine.errors import AuthError
from cognition_engine.settings import Settings

log = structlog.get_logger(__name__)

# LiteLLM is chatty; silence its internal success callbacks by default.
litellm.suppress_debug_info = True


@dataclass(frozen=True)
class CompletionResult:
    """The result of a non-streaming LLM completion."""

    content: str
    """The assistant's response text."""

    model_used: str
    """The LiteLLM model string that actually produced this response
    (may be the fallback model if the primary failed)."""

    input_tokens: int
    """Tokens consumed by the prompt."""

    output_tokens: int
    """Tokens produced in the completion."""

    finish_reason: str
    """Why the model stopped: 'stop', 'length', 'content_filter', etc."""

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class LLMClient:
    """
    Async LLM client backed by LiteLLM.

    Retry and fallback strategy
    ---------------------------
    - Per-model retries: LiteLLM retries the *same* model up to
      ``settings.llm_max_retries`` times before giving up on it.
    - Fallback: if the primary model exhausts its retries, this client
      automatically tries ``settings.fallback_model``.
    - If the fallback also fails, ``AllModelsFailedError`` is raised.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        log.debug(
            "LLMClient initialised",
            primary=settings.primary_model,
            fallback=settings.fallback_model,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        **kwargs: Any,
    ) -> CompletionResult:
        """
        Run a non-streaming chat completion.

        Args:
            messages:    OpenAI-style message list
                         (``[{"role": "user", "content": "..."}]``).
            model:       Override the model for this call only.
                         Defaults to ``settings.primary_model``.
            temperature: Sampling temperature (0 = deterministic).
            max_tokens:  Max completion tokens. Defaults to
                         ``settings.max_completion_tokens``.
            **kwargs:    Extra kwargs forwarded to ``litellm.acompletion``.

        Returns:
            ``CompletionResult`` with content, usage, and the model used.

        Raises:
            RateLimitError, TokenLimitError, AuthError,
            ModelUnavailableError, AllModelsFailedError, TimeoutError,
            LLMError
        """
        primary = model or self._settings.primary_model
        max_tok = max_tokens or self._settings.max_completion_tokens

        response = await self._complete_with_fallback(
            messages=messages,
            primary_model=primary,
            temperature=temperature,
            max_tokens=max_tok,
            stream=False,
            **kwargs,
        )

        choice = response.choices[0]
        usage = response.usage or _ZeroUsage()

        result = CompletionResult(
            content=choice.message.content or "",
            model_used=response.model or primary,
            input_tokens=getattr(usage, "prompt_tokens", 0),
            output_tokens=getattr(usage, "completion_tokens", 0),
            finish_reason=choice.finish_reason or "unknown",
        )
        log.info(
            "LLM completion",
            model=result.model_used,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            finish_reason=result.finish_reason,
        )
        return result

    async def stream_complete(
        self,
        messages: list[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Run a streaming chat completion.

        Yields text chunks as they arrive from the provider.
        Fallback is attempted at the *start* of the stream (before the
        first chunk); once streaming has begun, no mid-stream fallback
        is performed.

        Args:
            messages:    OpenAI-style message list.
            model:       Override the model for this call only.
            temperature: Sampling temperature.
            max_tokens:  Max completion tokens.
            **kwargs:    Extra kwargs forwarded to ``litellm.acompletion``.

        Yields:
            str chunks of the assistant response.

        Raises:
            Same error set as ``complete()``.
        """
        primary = model or self._settings.primary_model
        max_tok = max_tokens or self._settings.max_completion_tokens

        response = await self._complete_with_fallback(
            messages=messages,
            primary_model=primary,
            temperature=temperature,
            max_tokens=max_tok,
            stream=True,
            **kwargs,
        )

        return self._iter_stream(response)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    async def _complete_with_fallback(
        self,
        *,
        messages: list[dict[str, Any]],
        primary_model: str,
        temperature: float,
        max_tokens: int,
        stream: bool,
        **kwargs: Any,
    ) -> Any:
        """
        Try the primary model; on failure, try the fallback model.
        Maps LiteLLM exceptions to our error hierarchy at each attempt.
        """
        models_to_try = [primary_model]
        if self._settings.fallback_model != primary_model:
            models_to_try.append(self._settings.fallback_model)

        last_exc: Exception | None = None

        for attempt_model in models_to_try:
            try:
                log.debug("Calling LLM", model=attempt_model, stream=stream)
                response = await litellm.acompletion(
                    model=attempt_model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=stream,
                    num_retries=self._settings.llm_max_retries,
                    timeout=self._settings.llm_timeout_seconds,
                    **({"api_key": self._settings.google_api_key} if self._settings.google_api_key else {}),
                    **kwargs,
                )
                return response

            except Exception as exc:  # noqa: BLE001
                mapped = _map_litellm_error(exc, model=attempt_model)
                log.warning(
                    "LLM call failed",
                    model=attempt_model,
                    error_type=type(mapped).__name__,
                    error=str(mapped),
                )
                last_exc = mapped

                # Don't try the fallback for errors that won't benefit from it.
                if isinstance(mapped, AuthError):
                    raise mapped from exc

        assert last_exc is not None
        raise errors.AllModelsFailedError(
            f"All models failed. Last error: {last_exc}",
            model=self._settings.fallback_model,
        ) from last_exc

    @staticmethod
    async def _iter_stream(response: Any) -> AsyncIterator[str]:
        """Yield text deltas from a LiteLLM streaming response."""
        async for chunk in response:
            delta_content = chunk.choices[0].delta.content
            if delta_content:
                yield delta_content


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _ZeroUsage:
    """Sentinel used when the provider returns no usage stats."""

    prompt_tokens = 0
    completion_tokens = 0


def _map_litellm_error(exc: Exception, *, model: str) -> errors.LLMError:
    """
    Translate a LiteLLM (or underlying httpx/openai) exception into a
    typed ``CognitionError`` subclass.
    """
    exc_type = type(exc).__name__
    msg = str(exc)

    # LiteLLM exposes typed exceptions; check them by name to avoid a hard
    # import dependency on their internal module structure.
    if exc_type in ("RateLimitError", "litellm.RateLimitError"):
        return errors.RateLimitError(msg, model=model)
    if exc_type in ("ContextWindowExceededError", "litellm.ContextWindowExceededError"):
        return errors.TokenLimitError(msg, model=model)
    if exc_type in ("AuthenticationError", "litellm.AuthenticationError"):
        return errors.AuthError(msg, model=model)
    if exc_type in ("ServiceUnavailableError", "litellm.ServiceUnavailableError",
                    "APIConnectionError", "litellm.APIConnectionError"):
        return errors.ModelUnavailableError(msg, model=model)
    if exc_type in ("Timeout", "litellm.Timeout", "asyncio.TimeoutError",
                    "TimeoutError"):
        return errors.TimeoutError(msg, model=model)

    # Fallback: check the actual isinstance chain for LiteLLM's base types.
    try:
        import litellm as _ll
        if isinstance(exc, _ll.RateLimitError):
            return errors.RateLimitError(msg, model=model)
        if isinstance(exc, _ll.ContextWindowExceededError):
            return errors.TokenLimitError(msg, model=model)
        if isinstance(exc, _ll.AuthenticationError):
            return errors.AuthError(msg, model=model)
        if isinstance(exc, _ll.ServiceUnavailableError):
            return errors.ModelUnavailableError(msg, model=model)
        if isinstance(exc, _ll.Timeout):
            return errors.TimeoutError(msg, model=model)
    except AttributeError:
        pass

    return errors.LLMError(f"[{exc_type}] {msg}", model=model)
