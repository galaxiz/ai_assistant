"""
Prompt Formatter for the Cognition Engine.

Loads Jinja2 templates from a directory, renders them with caller-supplied
variables, and assembles a ready-to-send message list for LLMClient.

Template layout
---------------
Templates live under a root directory (default: the built-in
``cognition_engine/templates/`` folder).  Each template is a subdirectory
containing one or both of:

    <root>/<template_name>/system.j2   # optional — omitted if absent
    <root>/<template_name>/user.j2     # required

Built-in templates
------------------
  default      — general-purpose assistant with optional ``context`` variable.
  json_output  — instructs the model to return raw JSON; accepts ``schema_hint``.

Usage
-----
    from cognition_engine.prompt_formatter import PromptFormatter
    from cognition_engine.settings import Settings
    from cognition_engine.token_counter import TokenCounter

    settings = Settings()
    counter  = TokenCounter(settings.primary_model, settings.max_context_tokens)
    fmt      = PromptFormatter(settings, counter)

    # Named template
    rendered = fmt.render("default", {"query": "What is the capital of France?"})
    # rendered.messages  → [{"role": "system", ...}, {"role": "user", ...}]
    # rendered.token_count  → int
    # rendered.fits_budget  → bool

    # Ad-hoc template strings (no file required)
    rendered = fmt.render_raw(
        system="You are a pirate.",
        user="Tell me about {{ topic }}.",
        variables={"topic": "treasure maps"},
    )
"""

from __future__ import annotations

import importlib.resources
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import structlog
from jinja2 import (
    ChainableUndefined,
    Environment,
    FileSystemLoader,
    TemplateNotFound,
    UndefinedError,
    select_autoescape,
)

from cognition_engine.errors import TemplateError, TemplateNotFoundError
from cognition_engine.settings import Settings
from cognition_engine.token_counter import TokenCounter

log = structlog.get_logger(__name__)

# Path to the templates shipped with the package.
_BUILTIN_TEMPLATES_DIR: Path = Path(__file__).parent / "templates"


@dataclass(frozen=True)
class RenderedPrompt:
    """
    The result of rendering a prompt template.

    ``messages`` is ready to pass directly to ``LLMClient.complete()``.
    """

    messages: list[dict[str, str]]
    """OpenAI-style message list: system (optional), history, user."""

    token_count: int
    """Estimated token count of the full message list."""

    fits_budget: bool
    """True when ``token_count`` is within the configured prompt token budget."""

    template_name: str = field(default="<raw>")
    """Name of the template that produced this prompt (or '<raw>' for ad-hoc)."""


class PromptFormatter:
    """
    Renders Jinja2 prompt templates into message lists for the LLM.

    Args:
        settings:       Runtime configuration (used for token budget).
        token_counter:  Pre-initialised ``TokenCounter`` for the target model.
        extra_dirs:     Additional template directories to search *before* the
                        built-in templates. Later entries in the list are
                        searched first (Jinja2 loader precedence).
    """

    def __init__(
        self,
        settings: Settings,
        token_counter: TokenCounter,
        *,
        extra_dirs: list[Path] | None = None,
    ) -> None:
        self._settings = settings
        self._counter = token_counter

        search_dirs: list[str] = []
        if extra_dirs:
            search_dirs.extend(str(d) for d in reversed(extra_dirs))
        search_dirs.append(str(_BUILTIN_TEMPLATES_DIR))

        self._env = Environment(
            loader=FileSystemLoader(search_dirs),
            autoescape=select_autoescape(disabled_extensions=("j2",)),
            undefined=ChainableUndefined,
            trim_blocks=True,
            lstrip_blocks=True,
            keep_trailing_newline=False,
        )
        log.debug(
            "PromptFormatter initialised",
            search_dirs=search_dirs,
            budget=settings.prompt_token_budget,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def render(
        self,
        template_name: str,
        variables: dict[str, Any],
        *,
        history: list[dict[str, str]] | None = None,
    ) -> RenderedPrompt:
        """
        Render a named template.

        Args:
            template_name: Name of the template subdirectory (e.g. ``"default"``).
            variables:     Variables injected into the Jinja2 template.
            history:       Optional prior conversation turns inserted between
                           the system message and the new user message.
                           Each entry must be ``{"role": ..., "content": ...}``.

        Returns:
            :class:`RenderedPrompt`

        Raises:
            TemplateNotFoundError: If the template directory or ``user.j2``
                                   does not exist.
            TemplateError:         If rendering fails (e.g. undefined variable).
        """
        system_text = self._render_optional(
            f"{template_name}/system.j2", variables, template_name=template_name
        )
        user_text = self._render_required(
            f"{template_name}/user.j2", variables, template_name=template_name
        )
        return self._assemble(
            system_text=system_text,
            user_text=user_text,
            history=history,
            template_name=template_name,
        )

    def render_raw(
        self,
        user: str,
        variables: dict[str, Any],
        *,
        system: str | None = None,
        history: list[dict[str, str]] | None = None,
    ) -> RenderedPrompt:
        """
        Render ad-hoc Jinja2 template strings (no file required).

        Args:
            user:      Jinja2 template string for the user message.
            variables: Variables injected into both templates.
            system:    Optional Jinja2 template string for the system message.
            history:   Optional prior conversation turns.

        Returns:
            :class:`RenderedPrompt`

        Raises:
            TemplateError: If rendering fails.
        """
        system_text = self._render_string(system, variables) if system else None
        user_text = self._render_string(user, variables)
        return self._assemble(
            system_text=system_text,
            user_text=user_text,
            history=history,
            template_name="<raw>",
        )

    def list_templates(self) -> list[str]:
        """Return the names of all available templates (built-in + custom)."""
        templates: set[str] = set()
        for path_str in self._env.loader.searchpath:  # type: ignore[union-attr]
            p = Path(path_str)
            if p.is_dir():
                for child in p.iterdir():
                    if child.is_dir() and (child / "user.j2").exists():
                        templates.add(child.name)
        return sorted(templates)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _render_required(
        self, template_path: str, variables: dict[str, Any], template_name: str
    ) -> str:
        """Render a template file that must exist."""
        try:
            tmpl = self._env.get_template(template_path)
        except TemplateNotFound:
            raise TemplateNotFoundError(
                f"Template '{template_name}' is missing required file: user.j2",
                template_name=template_name,
            )
        return self._safe_render(tmpl, variables, template_name)

    def _render_optional(
        self, template_path: str, variables: dict[str, Any], template_name: str
    ) -> str | None:
        """Render a template file that may not exist (returns None if absent)."""
        try:
            tmpl = self._env.get_template(template_path)
        except TemplateNotFound:
            return None
        return self._safe_render(tmpl, variables, template_name)

    def _render_string(self, source: str, variables: dict[str, Any]) -> str:
        """Render an ad-hoc Jinja2 string."""
        try:
            tmpl = self._env.from_string(source)
            return tmpl.render(**variables).strip()
        except UndefinedError as exc:
            raise TemplateError(f"Undefined variable in raw template: {exc}") from exc

    @staticmethod
    def _safe_render(tmpl: Any, variables: dict[str, Any], template_name: str) -> str:
        try:
            return tmpl.render(**variables).strip()
        except UndefinedError as exc:
            raise TemplateError(
                f"Undefined variable in template '{template_name}': {exc}",
                template_name=template_name,
            ) from exc

    def _assemble(
        self,
        *,
        system_text: str | None,
        user_text: str,
        history: list[dict[str, str]] | None,
        template_name: str,
    ) -> RenderedPrompt:
        """Build the final message list, count tokens, and check the budget."""
        messages: list[dict[str, str]] = []

        if system_text:
            messages.append({"role": "system", "content": system_text})

        if history:
            messages.extend(history)

        messages.append({"role": "user", "content": user_text})

        token_count = self._counter.count_messages(messages)
        budget = self._settings.prompt_token_budget
        fits = token_count <= budget

        if not fits:
            log.warning(
                "Rendered prompt exceeds token budget",
                template=template_name,
                token_count=token_count,
                budget=budget,
                overage=token_count - budget,
            )

        log.debug(
            "Prompt rendered",
            template=template_name,
            messages=len(messages),
            token_count=token_count,
            fits_budget=fits,
        )

        return RenderedPrompt(
            messages=messages,
            token_count=token_count,
            fits_budget=fits,
            template_name=template_name,
        )
