"""Cognition Engine package."""

from cognition_engine.errors import (
    AllModelsFailedError,
    AuthError,
    CognitionError,
    LLMError,
    ModelUnavailableError,
    ParseError,
    RateLimitError,
    SchemaValidationError,
    TemplateError,
    TemplateNotFoundError,
    TokenLimitError,
)
from cognition_engine.llm_client import CompletionResult, LLMClient
from cognition_engine.output_parser import OutputParser, ParseResult
from cognition_engine.prompt_formatter import PromptFormatter, RenderedPrompt
from cognition_engine.settings import Settings
from cognition_engine.token_counter import TokenCounter

__all__ = [
    # settings
    "Settings",
    # llm client
    "LLMClient",
    "CompletionResult",
    # token counter
    "TokenCounter",
    # prompt formatter
    "PromptFormatter",
    "RenderedPrompt",
    # output parser
    "OutputParser",
    "ParseResult",
    # errors
    "CognitionError",
    "LLMError",
    "RateLimitError",
    "TokenLimitError",
    "AuthError",
    "ModelUnavailableError",
    "AllModelsFailedError",
    "ParseError",
    "SchemaValidationError",
    "TemplateError",
    "TemplateNotFoundError",
]
__version__ = "0.1.0"
