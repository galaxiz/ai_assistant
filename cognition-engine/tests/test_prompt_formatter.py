"""Tests for PromptFormatter."""

from __future__ import annotations

from pathlib import Path

import pytest

from cognition_engine.errors import TemplateError, TemplateNotFoundError
from cognition_engine.prompt_formatter import PromptFormatter, RenderedPrompt
from cognition_engine.settings import Settings
from cognition_engine.token_counter import TokenCounter

MODEL = "gemini/gemini-2.5-flash-preview-04-17"


@pytest.fixture()
def settings() -> Settings:
    return Settings(
        primary_model=MODEL,
        max_context_tokens=10_000,
        max_completion_tokens=500,
    )


@pytest.fixture()
def counter(settings: Settings) -> TokenCounter:
    return TokenCounter(model=MODEL, max_context_tokens=settings.max_context_tokens)


@pytest.fixture()
def fmt(settings: Settings, counter: TokenCounter) -> PromptFormatter:
    return PromptFormatter(settings, counter)


# ---------------------------------------------------------------------------
# render() — named templates
# ---------------------------------------------------------------------------


def test_render_default_template_basic(fmt: PromptFormatter) -> None:
    rendered = fmt.render("default", {"query": "What is 2+2?"})

    assert isinstance(rendered, RenderedPrompt)
    assert rendered.template_name == "default"
    # Should have system + user
    roles = [m["role"] for m in rendered.messages]
    assert "system" in roles
    assert "user" in roles


def test_render_default_user_content(fmt: PromptFormatter) -> None:
    rendered = fmt.render("default", {"query": "Hello there!"})
    user_msg = next(m for m in rendered.messages if m["role"] == "user")
    assert "Hello there!" in user_msg["content"]


def test_render_default_system_contains_context(fmt: PromptFormatter) -> None:
    rendered = fmt.render("default", {"query": "q", "context": "You are in Paris."})
    system_msg = next(m for m in rendered.messages if m["role"] == "system")
    assert "Paris" in system_msg["content"]


def test_render_default_no_context_omits_context_block(fmt: PromptFormatter) -> None:
    rendered = fmt.render("default", {"query": "q"})
    system_msg = next(m for m in rendered.messages if m["role"] == "system")
    # The "Additional context:" block should not appear when context is omitted.
    assert "Additional context" not in system_msg["content"]


def test_render_json_output_template(fmt: PromptFormatter) -> None:
    rendered = fmt.render("json_output", {"query": "List 3 colors as JSON."})
    roles = [m["role"] for m in rendered.messages]
    assert "system" in roles
    assert "user" in roles
    system_msg = next(m for m in rendered.messages if m["role"] == "system")
    assert "JSON" in system_msg["content"]


def test_render_json_output_with_schema_hint(fmt: PromptFormatter) -> None:
    rendered = fmt.render(
        "json_output",
        {"query": "Get colors.", "schema_hint": '{"colors": ["string"]}'},
    )
    system_msg = next(m for m in rendered.messages if m["role"] == "system")
    assert '{"colors"' in system_msg["content"]


def test_render_missing_template_raises(fmt: PromptFormatter) -> None:
    with pytest.raises(TemplateNotFoundError) as exc_info:
        fmt.render("nonexistent_template", {"query": "oops"})
    assert exc_info.value.template_name == "nonexistent_template"


def test_render_undefined_variable_renders_empty(fmt: PromptFormatter) -> None:
    # ChainableUndefined: missing vars render as empty string rather than raising.
    # This lets templates use optional vars freely in {% if %} and {{ }} blocks.
    rendered = fmt.render("default", {})  # 'query' missing → empty user message
    user_msg = next(m for m in rendered.messages if m["role"] == "user")
    assert user_msg["content"] == ""


# ---------------------------------------------------------------------------
# render() — history injection
# ---------------------------------------------------------------------------


def test_render_with_history(fmt: PromptFormatter) -> None:
    history = [
        {"role": "user", "content": "First message"},
        {"role": "assistant", "content": "First reply"},
    ]
    rendered = fmt.render("default", {"query": "Follow-up question"}, history=history)
    roles = [m["role"] for m in rendered.messages]
    assert roles == ["system", "user", "assistant", "user"]


def test_render_history_appears_before_user(fmt: PromptFormatter) -> None:
    history = [{"role": "user", "content": "Earlier"}, {"role": "assistant", "content": "Before"}]
    rendered = fmt.render("default", {"query": "Now"}, history=history)
    # Last message should be the new user turn.
    assert rendered.messages[-1]["role"] == "user"
    assert "Now" in rendered.messages[-1]["content"]


# ---------------------------------------------------------------------------
# render_raw()
# ---------------------------------------------------------------------------


def test_render_raw_no_system(fmt: PromptFormatter) -> None:
    rendered = fmt.render_raw("Tell me about {{ topic }}.", {"topic": "astronomy"})
    assert rendered.template_name == "<raw>"
    roles = [m["role"] for m in rendered.messages]
    assert "system" not in roles
    assert "user" in roles
    assert "astronomy" in rendered.messages[-1]["content"]


def test_render_raw_with_system(fmt: PromptFormatter) -> None:
    rendered = fmt.render_raw(
        user="Question: {{ q }}",
        variables={"q": "42?"},
        system="You are a math tutor.",
    )
    roles = [m["role"] for m in rendered.messages]
    assert roles[0] == "system"
    assert "math tutor" in rendered.messages[0]["content"]


def test_render_raw_undefined_variable_renders_empty(fmt: PromptFormatter) -> None:
    # ChainableUndefined: missing vars render silently as empty string.
    rendered = fmt.render_raw("Hello {{ name }}!", {})
    assert rendered.messages[-1]["content"] == "Hello !"


def test_render_raw_with_history(fmt: PromptFormatter) -> None:
    history = [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]
    rendered = fmt.render_raw(
        "New turn: {{ q }}",
        {"q": "yes"},
        history=history,
    )
    assert len(rendered.messages) == 3  # 2 history + 1 new user


# ---------------------------------------------------------------------------
# Token counting & budget
# ---------------------------------------------------------------------------


def test_rendered_prompt_has_token_count(fmt: PromptFormatter) -> None:
    rendered = fmt.render("default", {"query": "Hi"})
    assert rendered.token_count > 0


def test_rendered_prompt_fits_budget_small(fmt: PromptFormatter) -> None:
    rendered = fmt.render("default", {"query": "Short question."})
    assert rendered.fits_budget is True


def test_rendered_prompt_over_budget_flagged(settings: Settings, counter: TokenCounter) -> None:
    # Create a formatter with a tiny budget.
    tiny_settings = Settings(
        primary_model=MODEL,
        max_context_tokens=20,
        max_completion_tokens=10,
    )
    tiny_fmt = PromptFormatter(tiny_settings, counter)
    rendered = tiny_fmt.render("default", {"query": "This is a somewhat longer question."})
    assert rendered.fits_budget is False


# ---------------------------------------------------------------------------
# list_templates()
# ---------------------------------------------------------------------------


def test_list_templates_includes_builtins(fmt: PromptFormatter) -> None:
    templates = fmt.list_templates()
    assert "default" in templates
    assert "json_output" in templates


def test_list_templates_includes_custom(
    settings: Settings,
    counter: TokenCounter,
    tmp_path: Path,
) -> None:
    # Create a minimal custom template in a temp directory.
    custom_dir = tmp_path / "my_template"
    custom_dir.mkdir()
    (custom_dir / "user.j2").write_text("{{ prompt }}")

    fmt_custom = PromptFormatter(settings, counter, extra_dirs=[tmp_path])
    templates = fmt_custom.list_templates()
    assert "my_template" in templates
    assert "default" in templates  # built-ins still present


def test_custom_template_shadows_builtin(
    settings: Settings,
    counter: TokenCounter,
    tmp_path: Path,
) -> None:
    """A custom template with the same name as a built-in should take precedence."""
    custom_dir = tmp_path / "default"
    custom_dir.mkdir()
    (custom_dir / "user.j2").write_text("CUSTOM: {{ query }}")

    fmt_custom = PromptFormatter(settings, counter, extra_dirs=[tmp_path])
    rendered = fmt_custom.render("default", {"query": "test"})
    user_msg = next(m for m in rendered.messages if m["role"] == "user")
    assert user_msg["content"].startswith("CUSTOM:")


# ---------------------------------------------------------------------------
# RenderedPrompt structure
# ---------------------------------------------------------------------------


def test_rendered_prompt_is_frozen(fmt: PromptFormatter) -> None:
    rendered = fmt.render("default", {"query": "q"})
    with pytest.raises((AttributeError, TypeError)):
        rendered.token_count = 999  # type: ignore[misc]
