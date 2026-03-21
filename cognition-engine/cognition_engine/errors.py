"""
Unified error hierarchy for the Cognition Engine.

All errors raised by this package are subclasses of CognitionError, so callers
can catch at any granularity they need:

    except RateLimitError:   # very specific
    except LLMError:         # any LLM problem
    except CognitionError:   # anything from this package
"""

from __future__ import annotations


class CognitionError(Exception):
    """Base class for all Cognition Engine errors."""


# ---------------------------------------------------------------------------
# LLM / provider errors
# ---------------------------------------------------------------------------


class LLMError(CognitionError):
    """An error returned by, or during communication with, an LLM provider."""

    def __init__(self, message: str, *, model: str | None = None) -> None:
        super().__init__(message)
        self.model = model


class RateLimitError(LLMError):
    """The provider's rate limit was hit (HTTP 429)."""


class TokenLimitError(LLMError):
    """The prompt exceeded the model's context window."""


class AuthError(LLMError):
    """Invalid or missing API credentials."""


class ModelUnavailableError(LLMError):
    """The requested model is temporarily unavailable or unsupported."""


class AllModelsFailedError(LLMError):
    """Every model in the fallback chain failed."""


class TimeoutError(LLMError):  # noqa: A001  (intentional shadow of builtins.TimeoutError)
    """The LLM call timed out."""


# ---------------------------------------------------------------------------
# Parsing / output errors  (used in P3)
# ---------------------------------------------------------------------------


class ParseError(CognitionError):
    """The LLM response could not be parsed into the expected structure."""

    def __init__(self, message: str, *, raw_response: str | None = None) -> None:
        super().__init__(message)
        self.raw_response = raw_response


class SchemaValidationError(ParseError):
    """Parsed JSON did not match the expected Pydantic schema."""


# ---------------------------------------------------------------------------
# Template errors
# ---------------------------------------------------------------------------


class TemplateError(CognitionError):
    """A prompt template could not be loaded or rendered."""

    def __init__(self, message: str, *, template_name: str | None = None) -> None:
        super().__init__(message)
        self.template_name = template_name


class TemplateNotFoundError(TemplateError):
    """The requested template does not exist in the registry."""
