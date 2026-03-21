"""Tests for TokenCounter."""

from __future__ import annotations

import pytest

from cognition_engine.token_counter import TokenCounter

MODEL = "gemini/gemini-2.5-flash-preview-04-17"


@pytest.fixture()
def counter() -> TokenCounter:
    return TokenCounter(model=MODEL, max_context_tokens=1_000_000)


# ---------------------------------------------------------------------------
# count_text
# ---------------------------------------------------------------------------


def test_count_text_empty(counter: TokenCounter) -> None:
    assert counter.count_text("") == 0


def test_count_text_nonempty(counter: TokenCounter) -> None:
    n = counter.count_text("Hello, world!")
    assert n > 0


def test_count_text_longer_is_more(counter: TokenCounter) -> None:
    short = counter.count_text("Hi")
    long_ = counter.count_text("Hi " * 100)
    assert long_ > short


# ---------------------------------------------------------------------------
# count_messages
# ---------------------------------------------------------------------------


def test_count_messages_single(counter: TokenCounter) -> None:
    msgs = [{"role": "user", "content": "What is 2+2?"}]
    n = counter.count_messages(msgs)
    assert n > 0


def test_count_messages_more_content_is_more(counter: TokenCounter) -> None:
    short_msgs = [{"role": "user", "content": "Hi"}]
    long_msgs = [{"role": "user", "content": "Hi " * 200}]
    assert counter.count_messages(long_msgs) > counter.count_messages(short_msgs)


def test_count_messages_system_adds_tokens(counter: TokenCounter) -> None:
    without_system = [{"role": "user", "content": "Hello"}]
    with_system = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello"},
    ]
    assert counter.count_messages(with_system) > counter.count_messages(without_system)


# ---------------------------------------------------------------------------
# fits_in_budget / remaining_tokens
# ---------------------------------------------------------------------------


def test_fits_in_budget_small_messages(counter: TokenCounter) -> None:
    msgs = [{"role": "user", "content": "Hello"}]
    assert counter.fits_in_budget(msgs, completion_budget=8_192)


def test_remaining_tokens_decreases_with_more_content(counter: TokenCounter) -> None:
    msgs_short = [{"role": "user", "content": "Hi"}]
    msgs_long = [{"role": "user", "content": "Hi " * 500}]
    rem_short = counter.remaining_tokens(msgs_short, completion_budget=8_192)
    rem_long = counter.remaining_tokens(msgs_long, completion_budget=8_192)
    assert rem_short > rem_long


def test_remaining_tokens_never_negative(counter: TokenCounter) -> None:
    # Stuff the context with way more than max_context_tokens worth of text.
    huge_content = "word " * 2_000_000
    msgs = [{"role": "user", "content": huge_content}]
    # Use a tiny counter to force overflow.
    tiny_counter = TokenCounter(model=MODEL, max_context_tokens=10)
    assert tiny_counter.remaining_tokens(msgs, completion_budget=5) == 0


# ---------------------------------------------------------------------------
# truncate_messages
# ---------------------------------------------------------------------------


def test_truncate_messages_no_op_when_fits(counter: TokenCounter) -> None:
    msgs = [{"role": "user", "content": "Hello"}]
    result = counter.truncate_messages(msgs, budget=10_000)
    assert result == msgs


def test_truncate_messages_drops_oldest_first(counter: TokenCounter) -> None:
    msgs = [
        {"role": "user", "content": "First message " * 50},
        {"role": "assistant", "content": "Reply " * 50},
        {"role": "user", "content": "Last message"},
    ]
    # Force a tight budget so something must be dropped.
    result = counter.truncate_messages(msgs, budget=50)
    # Last message should survive (it's the newest).
    contents = [m["content"] for m in result]
    assert any("Last message" in c for c in contents)


def test_truncate_messages_preserves_system(counter: TokenCounter) -> None:
    msgs = [
        {"role": "system", "content": "System prompt."},
        {"role": "user", "content": "Old history " * 100},
        {"role": "user", "content": "New question"},
    ]
    result = counter.truncate_messages(msgs, budget=50, keep_system=True)
    roles = [m["role"] for m in result]
    assert "system" in roles


# ---------------------------------------------------------------------------
# split_text_to_chunks
# ---------------------------------------------------------------------------


def test_split_text_to_chunks_single(counter: TokenCounter) -> None:
    text = "Hello, world!"
    chunks = counter.split_text_to_chunks(text, chunk_size=1_000)
    assert len(chunks) == 1
    assert "Hello" in chunks[0]


def test_split_text_to_chunks_multiple(counter: TokenCounter) -> None:
    text = "word " * 200
    chunks = counter.split_text_to_chunks(text, chunk_size=50)
    assert len(chunks) > 1
    # Each chunk should parse back to at most chunk_size tokens.
    for chunk in chunks:
        assert counter.count_text(chunk) <= 50
