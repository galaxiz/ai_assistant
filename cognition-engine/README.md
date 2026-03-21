# Cognition Engine

Prompt formatting, token counting, structured output parsing, and LLM client for the AI Agent.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env  # fill in your API keys
```

## Run

```bash
python -m cognition_engine
```

## Test

```bash
pytest
```
