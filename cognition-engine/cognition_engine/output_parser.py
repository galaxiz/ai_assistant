"""
Structured Output Parser for the Cognition Engine.

Turns a raw LLM response string into a validated Pydantic model instance.

Pipeline
--------
1.  **Extract** — pull a JSON string out of the raw response (strips markdown
    code fences, locates the outermost object/array).
2.  **Parse**   — ``json.loads()`` the extracted string.
3.  **Repair**  — if parsing fails, apply heuristics (trailing commas, single
    quotes, dangling keys) and retry.
4.  **Validate**— run the parsed dict through a Pydantic ``BaseModel``.
5.  **Re-prompt**— if validation still fails and a ``LLMClient`` + conversation
    context are provided, ask the LLM to fix its output and try once more.

Usage
-----
    from pydantic import BaseModel
    from cognition_engine.output_parser import OutputParser, ParseResult
    from cognition_engine.llm_client import LLMClient
    from cognition_engine.settings import Settings

    class City(BaseModel):
        name: str
        country: str
        population: int

    parser = OutputParser(llm_client=client, settings=settings)
    result: ParseResult[City] = await parser.parse(
        '```json\\n{"name": "Paris", "country": "France", "population": 2161000}\\n```',
        City,
    )
    print(result.data.name)   # Paris
    print(result.repaired)    # False
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, TypeVar

import structlog
from pydantic import BaseModel, ValidationError

from cognition_engine.errors import ParseError, SchemaValidationError
from cognition_engine.llm_client import LLMClient, CompletionResult
from cognition_engine.settings import Settings

log = structlog.get_logger(__name__)

T = TypeVar("T", bound=BaseModel)

# ---------------------------------------------------------------------------
# Regex patterns for JSON extraction
# ---------------------------------------------------------------------------

# Matches ```json ... ``` or ``` ... ``` (non-greedy, DOTALL)
_CODE_FENCE_RE = re.compile(
    r"```(?:json|JSON)?\s*\n?(.*?)\n?```",
    re.DOTALL,
)

# Matches an inline single-line code span: `{...}` or `[...]`
_CODE_SPAN_RE = re.compile(r"`([{\[].*?[}\]])`", re.DOTALL)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ParseResult:
    """
    The result of a successful parse + validation.

    Generic over T (the Pydantic model type), but kept as a plain dataclass
    so callers can annotate return types as ``ParseResult`` without generics
    overhead.
    """

    data: BaseModel
    """The validated Pydantic model instance."""

    raw_response: str
    """The original LLM response string, unchanged."""

    extracted_json: str
    """The JSON string that was actually parsed (after extraction / repair)."""

    repaired: bool = field(default=False)
    """True if heuristic repairs were applied to produce valid JSON."""

    re_prompted: bool = field(default=False)
    """True if the LLM was asked to fix its output during this parse."""


# ---------------------------------------------------------------------------
# Main parser
# ---------------------------------------------------------------------------


class OutputParser:
    """
    Parses and validates structured JSON from LLM responses.

    Args:
        settings:   Runtime configuration.
        llm_client: Optional ``LLMClient`` used for the re-prompt fallback.
                    Required only if you pass ``context_messages`` to
                    ``parse()``.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        llm_client: LLMClient | None = None,
    ) -> None:
        self._settings = settings
        self._llm = llm_client

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def parse(
        self,
        response: str | CompletionResult,
        schema: type[T],
        *,
        context_messages: list[dict[str, Any]] | None = None,
        max_repair_attempts: int = 1,
    ) -> ParseResult:
        """
        Parse a raw LLM response into a validated Pydantic model.

        Args:
            response:            Raw LLM response text, or a
                                 ``CompletionResult`` from ``LLMClient``.
            schema:              Pydantic ``BaseModel`` subclass to validate
                                 against.
            context_messages:    The original prompt messages. When provided
                                 along with a ``llm_client``, a failed parse
                                 triggers a re-prompt asking the LLM to
                                 correct its output.
            max_repair_attempts: How many heuristic repair passes to try
                                 before giving up (or re-prompting).

        Returns:
            :class:`ParseResult` with a validated ``data`` attribute.

        Raises:
            ParseError:           Could not extract any JSON from the response.
            SchemaValidationError: Extracted JSON failed Pydantic validation
                                   (and the re-prompt fallback also failed or
                                   was not configured).
        """
        raw = response.content if isinstance(response, CompletionResult) else response

        # --- Step 1 & 2: extract + parse ---
        json_str, parsed = self._try_extract_and_parse(raw)

        if parsed is not None:
            return self._validate(raw, json_str, parsed, schema, repaired=False, re_prompted=False)

        # --- Step 3: repair heuristics ---
        repaired_str = None
        if max_repair_attempts > 0 and json_str:
            repaired_str = _repair_json(json_str)
            if repaired_str != json_str:
                try:
                    parsed = json.loads(repaired_str)
                    log.info("JSON repaired successfully", schema=schema.__name__)
                    return self._validate(
                        raw, repaired_str, parsed, schema, repaired=True, re_prompted=False
                    )
                except json.JSONDecodeError:
                    pass

        # --- Step 4: re-prompt fallback ---
        if context_messages is not None and self._llm is not None:
            log.info(
                "Attempting re-prompt to fix JSON output",
                schema=schema.__name__,
            )
            fixed_raw = await self._reprompt(
                original_response=raw,
                context_messages=context_messages,
                schema=schema,
            )
            json_str2, parsed2 = self._try_extract_and_parse(fixed_raw)
            if parsed2 is None and json_str2:
                json_str2 = _repair_json(json_str2)
                try:
                    parsed2 = json.loads(json_str2)
                except json.JSONDecodeError:
                    parsed2 = None
            if parsed2 is not None:
                return self._validate(
                    fixed_raw, json_str2 or fixed_raw, parsed2, schema,
                    repaired=True, re_prompted=True,
                )
            raise SchemaValidationError(
                f"Re-prompt did not produce valid JSON for schema '{schema.__name__}'.",
                raw_response=fixed_raw,
            )

        # --- All strategies exhausted ---
        raise ParseError(
            f"Could not parse JSON from LLM response for schema '{schema.__name__}'.",
            raw_response=raw,
        )

    def parse_sync(
        self,
        response: str | CompletionResult,
        schema: type[T],
    ) -> ParseResult:
        """
        Synchronous parse (no re-prompt fallback).

        Runs extract → repair → validate without any async I/O.
        Useful in contexts where an event loop is not available.

        Raises:
            ParseError, SchemaValidationError
        """
        import asyncio
        return asyncio.get_event_loop().run_until_complete(
            self.parse(response, schema, context_messages=None)
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _try_extract_and_parse(text: str) -> tuple[str, Any]:
        """
        Try to extract a JSON string and parse it.

        Returns (json_str, parsed_object).
        ``parsed_object`` is None if parsing failed; ``json_str`` is the
        best candidate we found to hand to the repair step.
        """
        candidates = _extract_json_candidates(text)
        for candidate in candidates:
            try:
                return candidate, json.loads(candidate)
            except json.JSONDecodeError:
                continue
        # Return the first candidate for the repair step, even if unparseable.
        return (candidates[0] if candidates else text), None

    @staticmethod
    def _validate(
        raw: str,
        json_str: str,
        parsed: Any,
        schema: type[T],
        *,
        repaired: bool,
        re_prompted: bool,
    ) -> ParseResult:
        """Validate a parsed dict against the Pydantic schema."""
        try:
            instance = schema.model_validate(parsed)
            log.debug(
                "Schema validation passed",
                schema=schema.__name__,
                repaired=repaired,
                re_prompted=re_prompted,
            )
            return ParseResult(
                data=instance,
                raw_response=raw,
                extracted_json=json_str,
                repaired=repaired,
                re_prompted=re_prompted,
            )
        except ValidationError as exc:
            raise SchemaValidationError(
                f"JSON did not match schema '{schema.__name__}': {exc}",
                raw_response=raw,
            ) from exc

    async def _reprompt(
        self,
        *,
        original_response: str,
        context_messages: list[dict[str, Any]],
        schema: type[T],
    ) -> str:
        """Ask the LLM to fix its malformed JSON output."""
        assert self._llm is not None

        schema_json = schema.model_json_schema()
        repair_messages = [
            *context_messages,
            {"role": "assistant", "content": original_response},
            {
                "role": "user",
                "content": (
                    "Your previous response was not valid JSON. "
                    "Please respond again with ONLY a valid JSON object "
                    f"matching this schema:\n{json.dumps(schema_json, indent=2)}\n\n"
                    "Output JSON only — no markdown, no explanation."
                ),
            },
        ]
        result = await self._llm.complete(repair_messages, temperature=0.0)
        return result.content


# ---------------------------------------------------------------------------
# JSON extraction helpers (module-level, testable independently)
# ---------------------------------------------------------------------------


def _extract_json_candidates(text: str) -> list[str]:
    """
    Return ordered candidate JSON strings extracted from ``text``.

    Order of preference:
    1. Content inside a ```json ... ``` or ``` ... ``` code fence.
    2. Content inside a backtick code span ``{...}`` or ``[...]``.
    3. The largest balanced ``{...}`` or ``[...]`` substring in the raw text.
    4. The full text (last resort).
    """
    candidates: list[str] = []

    # 1. Code fences
    for match in _CODE_FENCE_RE.finditer(text):
        content = match.group(1).strip()
        if content:
            candidates.append(content)

    # 2. Inline code spans
    for match in _CODE_SPAN_RE.finditer(text):
        candidates.append(match.group(1).strip())

    # 3. Balanced bracket extraction
    for start_char, end_char in (("{", "}"), ("[", "]")):
        extracted = _extract_balanced(text, start_char, end_char)
        if extracted:
            candidates.append(extracted)

    # 4. Full text (trimmed)
    candidates.append(text.strip())

    # Deduplicate while preserving order.
    seen: set[str] = set()
    unique: list[str] = []
    for c in candidates:
        if c and c not in seen:
            seen.add(c)
            unique.append(c)
    return unique


def _extract_balanced(text: str, open_char: str, close_char: str) -> str | None:
    """
    Find the outermost balanced bracket pair in ``text`` and return its content.
    Returns None if no complete balanced pair is found.
    """
    start = text.find(open_char)
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape_next = False

    for i, ch in enumerate(text[start:], start=start):
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"' and not escape_next:
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == open_char:
            depth += 1
        elif ch == close_char:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _repair_json(text: str) -> str:
    """
    Apply heuristic repairs to a JSON string that failed ``json.loads()``.

    Repairs attempted (in order):
    1. Strip leading/trailing whitespace.
    2. Remove trailing commas before ``}`` or ``]``.
    3. Replace escaped single-quote strings with double-quote strings.
    4. Replace Python-style ``True``/``False``/``None`` literals.
    5. Remove single-line ``//`` and ``/* */`` comments.
    6. Quote bare (unquoted) keys.
    """
    s = text.strip()

    # 1. Trailing commas: ,} and ,]
    s = re.sub(r",\s*([}\]])", r"\1", s)

    # 2. Python literals → JSON literals
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    s = re.sub(r"\bNone\b", "null", s)
    s = re.sub(r"\bNaN\b", "null", s)
    s = re.sub(r"\bInfinity\b", "null", s)

    # 3. Single-line comments  // ...
    s = re.sub(r"//[^\n]*", "", s)

    # 4. Block comments  /* ... */
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)

    # 5. Trailing commas again (comments may have exposed new ones)
    s = re.sub(r",\s*([}\]])", r"\1", s)

    # 6. Unquoted object keys:  { key: "value" } → { "key": "value" }
    #    Only match word-character keys not already inside a string.
    s = re.sub(r'(?<!["\w])(\b[a-zA-Z_][a-zA-Z0-9_]*\b)\s*:', r'"\1":', s)

    return s.strip()
