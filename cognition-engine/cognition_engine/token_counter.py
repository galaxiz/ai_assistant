"""
Token counter for the Cognition Engine.

Primary path: litellm.token_counter() — supports Gemini and most providers.
Fallback path: tiktoken with cl100k_base encoding (fast estimation).

Usage:
    from cognition_engine.token_counter import TokenCounter
    from cognition_engine.settings import Settings

    counter = TokenCounter(Settings())
    n = counter.count_text("Hello, world!")
    messages = [{"role": "user", "content": "What is 2+2?"}]
    n = counter.count_messages(messages)
    safe_msgs = counter.truncate_messages(messages, budget=500)
"""

from __future__ import annotations

import functools
import logging
from typing import Any

import structlog
import tiktoken

try:
    import litellm

    _LITELLM_AVAILABLE = True
except ImportError:
    _LITELLM_AVAILABLE = False

log = structlog.get_logger(__name__)

# Tiktoken encoding used as a fast fallback / estimation.
# cl100k_base is GPT-4's encoding and is a reasonable approximation for Gemini.
_FALLBACK_ENCODING_NAME = "cl100k_base"

# LiteLLM model strings that map to Gemini — we pass these through to litellm.token_counter.
_GEMINI_MODEL_PREFIXES = ("gemini/",)


@functools.lru_cache(maxsize=8)
def _get_tiktoken_encoding(encoding_name: str) -> tiktoken.Encoding:
    """Load and cache a tiktoken encoding by name."""
    return tiktoken.get_encoding(encoding_name)


class TokenCounter:
    """
    Counts and manages tokens for LLM prompts.

    Prefer using `count_messages` / `count_text` over direct tiktoken calls so
    that the model-aware path (via LiteLLM) is always tried first.
    """

    def __init__(self, model: str, max_context_tokens: int = 1_000_000) -> None:
        """
        Args:
            model: LiteLLM model string (e.g. "gemini/gemini-2.5-flash-preview-04-17").
            max_context_tokens: Full context window of the model.
        """
        self.model = model
        self.max_context_tokens = max_context_tokens
        self._fallback_enc = _get_tiktoken_encoding(_FALLBACK_ENCODING_NAME)
        log.debug("TokenCounter initialised", model=model, max_context=max_context_tokens)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def count_text(self, text: str) -> int:
        """Return the number of tokens in a plain text string."""
        return len(self._fallback_enc.encode(text))

    def count_messages(self, messages: list[dict[str, Any]]) -> int:
        """
        Return the token count for a list of chat messages.

        Tries litellm.token_counter first (model-accurate for Gemini).
        Falls back to tiktoken estimation if LiteLLM is unavailable or errors.
        """
        if _LITELLM_AVAILABLE:
            try:
                count: int = litellm.token_counter(model=self.model, messages=messages)
                return count
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "litellm.token_counter failed, using tiktoken fallback",
                    exc=str(exc),
                    model=self.model,
                )
        return self._tiktoken_count_messages(messages)

    def remaining_tokens(self, messages: list[dict[str, Any]], completion_budget: int) -> int:
        """
        How many tokens are left for additional content, given current messages
        and the headroom we want to reserve for the completion.

        Returns 0 if already over budget (never negative).
        """
        used = self.count_messages(messages)
        available = self.max_context_tokens - completion_budget - used
        return max(0, available)

    def fits_in_budget(
        self, messages: list[dict[str, Any]], completion_budget: int = 8_192
    ) -> bool:
        """Return True if the messages fit within the model's context window."""
        return self.remaining_tokens(messages, completion_budget) > 0

    def truncate_messages(
        self,
        messages: list[dict[str, Any]],
        budget: int,
        *,
        keep_system: bool = True,
    ) -> list[dict[str, Any]]:
        """
        Drop oldest non-system messages until the total token count fits within
        `budget` tokens.

        Args:
            messages:    Full message list (system, user, assistant, …).
            budget:      Target token budget for the prompt.
            keep_system: Always keep the system message if present.

        Returns:
            Truncated list that fits within `budget` tokens.
        """
        if self.count_messages(messages) <= budget:
            return messages

        system_msgs = [m for m in messages if m.get("role") == "system"] if keep_system else []
        non_system = [m for m in messages if m.get("role") != "system"]

        # Drop from the oldest non-system messages first.
        while non_system and self.count_messages(system_msgs + non_system) > budget:
            non_system.pop(0)

        truncated = system_msgs + non_system
        log.info(
            "Truncated message history to fit token budget",
            original_count=len(messages),
            truncated_count=len(truncated),
            budget=budget,
        )
        return truncated

    def split_text_to_chunks(self, text: str, chunk_size: int) -> list[str]:
        """
        Split `text` into chunks of at most `chunk_size` tokens each,
        preserving token boundaries.

        Useful for batch-processing large documents.
        """
        tokens = self._fallback_enc.encode(text)
        chunks = []
        for i in range(0, len(tokens), chunk_size):
            chunk_tokens = tokens[i : i + chunk_size]
            chunks.append(self._fallback_enc.decode(chunk_tokens))
        return chunks

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _tiktoken_count_messages(self, messages: list[dict[str, Any]]) -> int:
        """
        Estimate token count for a message list using tiktoken (cl100k_base).

        Applies the same overhead formula as GPT-4:
          - 3 tokens per message (role + separators)
          - 1 token per content string
          - 3 tokens as reply primer
        """
        num_tokens = 3  # reply primer
        for message in messages:
            num_tokens += 3  # role + framing tokens
            for key, value in message.items():
                if isinstance(value, str):
                    num_tokens += len(self._fallback_enc.encode(value))
                elif isinstance(value, list):
                    # Multi-modal content (list of parts)
                    for part in value:
                        if isinstance(part, dict) and isinstance(part.get("text"), str):
                            num_tokens += len(self._fallback_enc.encode(part["text"]))
                if key == "name":
                    num_tokens += 1  # name field costs an extra token
        return num_tokens
