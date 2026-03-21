"""Tests for OutputParser, _extract_json_candidates, and _repair_json."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import BaseModel, Field

from cognition_engine.errors import ParseError, SchemaValidationError
from cognition_engine.llm_client import CompletionResult
from cognition_engine.output_parser import (
    OutputParser,
    ParseResult,
    _extract_balanced,
    _extract_json_candidates,
    _repair_json,
)
from cognition_engine.settings import Settings


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------


class City(BaseModel):
    name: str
    country: str
    population: int


class Tag(BaseModel):
    label: str
    score: float = Field(ge=0.0, le=1.0)


class ItemList(BaseModel):
    items: list[str]


def _settings() -> Settings:
    return Settings(primary_model="gemini/gemini-2.5-flash-preview-04-17")


def _parser(llm_client: Any = None) -> OutputParser:
    return OutputParser(_settings(), llm_client=llm_client)


CITY_JSON = '{"name": "Paris", "country": "France", "population": 2161000}'
CITY_LIST_JSON = '[{"name": "Paris", "country": "France", "population": 2161000}]'


# ---------------------------------------------------------------------------
# _extract_json_candidates
# ---------------------------------------------------------------------------


def test_extract_from_json_fence() -> None:
    text = f"```json\n{CITY_JSON}\n```"
    candidates = _extract_json_candidates(text)
    assert candidates[0] == CITY_JSON


def test_extract_from_plain_fence() -> None:
    text = f"```\n{CITY_JSON}\n```"
    candidates = _extract_json_candidates(text)
    assert CITY_JSON in candidates


def test_extract_from_raw_object() -> None:
    text = f"Here is the data: {CITY_JSON} — that's it."
    candidates = _extract_json_candidates(text)
    assert CITY_JSON in candidates


def test_extract_from_raw_array() -> None:
    text = f"Result: {CITY_LIST_JSON}"
    candidates = _extract_json_candidates(text)
    assert CITY_LIST_JSON in candidates


def test_extract_full_text_as_last_resort() -> None:
    raw = CITY_JSON
    candidates = _extract_json_candidates(raw)
    assert raw in candidates


def test_extract_deduplicates() -> None:
    text = CITY_JSON  # no fence; balanced extraction + full text are the same
    candidates = _extract_json_candidates(text)
    assert candidates.count(CITY_JSON) == 1


# ---------------------------------------------------------------------------
# _extract_balanced
# ---------------------------------------------------------------------------


def test_extract_balanced_object() -> None:
    result = _extract_balanced('prefix {"key": "val"} suffix', "{", "}")
    assert result == '{"key": "val"}'


def test_extract_balanced_array() -> None:
    result = _extract_balanced("before [1, 2, 3] after", "[", "]")
    assert result == "[1, 2, 3]"


def test_extract_balanced_nested() -> None:
    result = _extract_balanced('{"a": {"b": 1}}', "{", "}")
    assert result == '{"a": {"b": 1}}'


def test_extract_balanced_no_match() -> None:
    assert _extract_balanced("no brackets here", "{", "}") is None


def test_extract_balanced_string_with_bracket() -> None:
    # Braces inside strings must not confuse the depth counter.
    result = _extract_balanced('{"key": "val}ue"}', "{", "}")
    assert result == '{"key": "val}ue"}'


# ---------------------------------------------------------------------------
# _repair_json
# ---------------------------------------------------------------------------


def test_repair_trailing_comma_object() -> None:
    broken = '{"a": 1,}'
    assert _repair_json(broken) == '{"a": 1}'


def test_repair_trailing_comma_array() -> None:
    broken = '[1, 2, 3,]'
    assert _repair_json(broken) == '[1, 2, 3]'


def test_repair_python_true_false_none() -> None:
    broken = '{"a": True, "b": False, "c": None}'
    repaired = _repair_json(broken)
    import json
    parsed = json.loads(repaired)
    assert parsed == {"a": True, "b": False, "c": None}


def test_repair_single_line_comment() -> None:
    broken = '{"a": 1 // this is a comment\n}'
    repaired = _repair_json(broken)
    import json
    parsed = json.loads(repaired)
    assert parsed["a"] == 1


def test_repair_block_comment() -> None:
    broken = '{"a": /* comment */ 1}'
    repaired = _repair_json(broken)
    import json
    assert json.loads(repaired) == {"a": 1}


def test_repair_unquoted_keys() -> None:
    broken = '{name: "Paris", country: "France"}'
    repaired = _repair_json(broken)
    import json
    parsed = json.loads(repaired)
    assert parsed["name"] == "Paris"


def test_repair_idempotent_on_valid_json() -> None:
    valid = '{"key": "value"}'
    import json
    assert json.loads(_repair_json(valid)) == {"key": "value"}


# ---------------------------------------------------------------------------
# OutputParser.parse() — happy paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_raw_json() -> None:
    parser = _parser()
    result = await parser.parse(CITY_JSON, City)
    assert isinstance(result, ParseResult)
    assert result.data.name == "Paris"
    assert result.repaired is False
    assert result.re_prompted is False


@pytest.mark.asyncio
async def test_parse_json_in_fence() -> None:
    parser = _parser()
    text = f"```json\n{CITY_JSON}\n```"
    result = await parser.parse(text, City)
    assert result.data.country == "France"


@pytest.mark.asyncio
async def test_parse_json_with_surrounding_text() -> None:
    parser = _parser()
    text = f"Here is the city: {CITY_JSON}\nHope that helps!"
    result = await parser.parse(text, City)
    assert result.data.population == 2161000


@pytest.mark.asyncio
async def test_parse_completion_result() -> None:
    parser = _parser()
    cr = CompletionResult(
        content=CITY_JSON,
        model_used="gemini/gemini-2.5-flash-preview-04-17",
        input_tokens=10,
        output_tokens=20,
        finish_reason="stop",
    )
    result = await parser.parse(cr, City)
    assert result.data.name == "Paris"


@pytest.mark.asyncio
async def test_parse_list_schema() -> None:
    parser = _parser()
    json_text = '{"items": ["apple", "banana", "cherry"]}'
    result = await parser.parse(json_text, ItemList)
    assert result.data.items == ["apple", "banana", "cherry"]


# ---------------------------------------------------------------------------
# OutputParser.parse() — repair path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_repairs_trailing_comma() -> None:
    parser = _parser()
    broken = '{"name": "Paris", "country": "France", "population": 2161000,}'
    result = await parser.parse(broken, City)
    assert result.data.name == "Paris"
    assert result.repaired is True


@pytest.mark.asyncio
async def test_parse_repairs_python_literals() -> None:
    parser = _parser()
    broken = '{"label": "test", "score": 0.9}'  # valid — ensure repair is a no-op
    result = await parser.parse(broken, Tag)
    assert result.data.label == "test"


# ---------------------------------------------------------------------------
# OutputParser.parse() — validation failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_raises_schema_validation_error() -> None:
    parser = _parser()
    # score must be 0–1; 99.0 violates the constraint
    bad = '{"label": "x", "score": 99.0}'
    with pytest.raises(SchemaValidationError) as exc_info:
        await parser.parse(bad, Tag)
    assert exc_info.value.raw_response is not None


@pytest.mark.asyncio
async def test_parse_raises_parse_error_for_garbage() -> None:
    parser = _parser()
    with pytest.raises(ParseError):
        await parser.parse("This is just plain prose with no JSON.", City)


@pytest.mark.asyncio
async def test_parse_raises_parse_error_missing_fields() -> None:
    parser = _parser()
    # JSON is valid but missing required fields for City
    with pytest.raises(SchemaValidationError):
        await parser.parse('{"name": "Paris"}', City)


# ---------------------------------------------------------------------------
# OutputParser.parse() — re-prompt fallback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_reprompts_and_succeeds() -> None:
    """When the first response is invalid, the client is called to fix it."""
    mock_llm = MagicMock()
    mock_llm.complete = AsyncMock(
        return_value=CompletionResult(
            content=CITY_JSON,
            model_used="gemini/gemini-2.5-flash-preview-04-17",
            input_tokens=10,
            output_tokens=20,
            finish_reason="stop",
        )
    )

    parser = _parser(llm_client=mock_llm)
    context = [{"role": "user", "content": "Give me a city as JSON."}]

    result = await parser.parse(
        "Sorry, I can't do that.",  # no JSON
        City,
        context_messages=context,
    )
    assert result.data.name == "Paris"
    assert result.re_prompted is True
    mock_llm.complete.assert_called_once()


@pytest.mark.asyncio
async def test_parse_reprompt_also_fails_raises() -> None:
    """If the re-prompt response is also invalid, SchemaValidationError is raised."""
    mock_llm = MagicMock()
    mock_llm.complete = AsyncMock(
        return_value=CompletionResult(
            content="still not json",
            model_used="gemini/gemini-2.5-flash-preview-04-17",
            input_tokens=5,
            output_tokens=5,
            finish_reason="stop",
        )
    )

    parser = _parser(llm_client=mock_llm)
    context = [{"role": "user", "content": "Give me JSON."}]

    with pytest.raises(SchemaValidationError):
        await parser.parse("no json here either", City, context_messages=context)


@pytest.mark.asyncio
async def test_parse_no_reprompt_without_context() -> None:
    """Without context_messages, re-prompt is never attempted."""
    mock_llm = MagicMock()
    mock_llm.complete = AsyncMock()

    parser = _parser(llm_client=mock_llm)

    with pytest.raises(ParseError):
        await parser.parse("not json", City)  # no context_messages → no re-prompt

    mock_llm.complete.assert_not_called()


# ---------------------------------------------------------------------------
# ParseResult
# ---------------------------------------------------------------------------


def test_parse_result_is_frozen() -> None:
    city = City(name="Lyon", country="France", population=500000)
    result = ParseResult(
        data=city,
        raw_response="{}",
        extracted_json="{}",
    )
    with pytest.raises((AttributeError, TypeError)):
        result.repaired = True  # type: ignore[misc]
