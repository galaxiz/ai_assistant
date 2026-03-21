# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a distributed AI agent system with two core services:
- **Orchestrator** (Rust) — Session management, agent reasoning loop, tool execution
- **Cognition Engine** (Python) — LLM completions, token counting, structured output parsing

They communicate over gRPC (defined in `proto/cognition.proto`).

## Running the System

**Cognition Engine** (gRPC server on port 50051):
```bash
cd cognition-engine
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env  # Set CE_GOOGLE_API_KEY
python -m cognition_engine
```

**Orchestrator** (HTTP/WebSocket server on port 8080):
```bash
cd orchestrator
cp .env.example .env
cargo run
```

**Docker** (Orchestrator only — builds from repo root):
```bash
docker build -f orchestrator/Dockerfile -t orchestrator:latest .
docker run -e ORCH__HTTP__PORT=8080 -p 8080:8080 orchestrator:latest
```

## Testing

**Cognition Engine:**
```bash
cd cognition-engine
pytest                          # all tests
pytest -v tests/test_llm_client.py  # single file
```

**Orchestrator:**
```bash
cd orchestrator
cargo test                      # unit tests
cargo test --ignored            # integration tests (requires Cognition Engine running)
```

## Architecture

### Request Flow
1. Client connects via WebSocket (`/ws`) or sends a POST to the webhook endpoint
2. Orchestrator creates/retrieves a `Session` (keyed by session_id UUID)
3. Agent loop appends the message, counts tokens, trims history if over budget
4. Orchestrator calls `CognitionService.Complete` over gRPC
5. LLM response is scanned for `tool_call` fence blocks; tools are executed via Wasmtime
6. Tool results are injected as `tool_result` fence blocks; loop repeats (up to `MAX_TOOL_ITERATIONS`)
7. Final text response is sent back over WebSocket/webhook

### Session State Machine
`Idle → Processing → AwaitingToolResult → Processing → ... → Idle`
One Mutex per session prevents concurrent processing of the same session.

### Tool Definition Format
Tools are `.md` files with TOML frontmatter in the `tools/` directory:
```toml
---
name = "read_file"
wasm = "tools/read_file.wasm"
timeout_secs = 10
[permissions]
fs_read = true
fs_write = false
network = false
[[args]]
name = "path"
type = "string"
required = true
---
```

Tools run in a Wasmtime sandbox with per-tool memory limits (`MAX_MEMORY_PAGES`) and fuel-based CPU limits. WASI permissions (`fs_read`, `fs_write`) are enforced; `network` is reserved.

### Tool-Call Wire Protocol
The LLM emits tool calls in markdown fences; the orchestrator injects results:
```
```tool_call
{"tool": "read_file", "call_id": "c1", "args": {"path": "/tmp/x"}}
```
```tool_result
{"call_id": "c1", "status": "ok", "output": "..."}
```
```

### Token Budget
The Cognition Engine trims the oldest user/assistant messages when the conversation exceeds `CE_MAX_CONTEXT_TOKENS`. The system prompt is always preserved.

## Key Configuration

**Orchestrator** — env prefix `ORCH__`:
| Variable | Default |
|---|---|
| `ORCH__COGNITION_ENGINE__ADDRESS` | `http://localhost:50051` |
| `ORCH__HTTP__PORT` | `8080` |
| `ORCH__TOOLS__TOOLS_DIR` | `tools` |
| `ORCH__AGENT__MAX_TOOL_ITERATIONS` | `10` |
| `ORCH__TELEMETRY__OTLP_ENDPOINT` | `http://localhost:4317` |

**Cognition Engine** — env prefix `CE_`:
| Variable | Default |
|---|---|
| `CE_GRPC_PORT` | `50051` |
| `CE_PRIMARY_MODEL` | `gemini/gemini-2.5-flash-preview-04-17` |
| `CE_FALLBACK_MODEL` | `gemini/gemini-2.0-flash` |
| `CE_MAX_CONTEXT_TOKENS` | `1000000` |
| `CE_GOOGLE_API_KEY` | *(required)* |

## Key Source Files

**Orchestrator (`orchestrator/src/`):**
- `main.rs` — entry point, dependency wiring
- `config.rs` — all runtime settings
- `agent_loop/mod.rs` — core reasoning loop
- `agent_loop/protocol.rs` — tool-call fence parsing
- `session/mod.rs` — session model and state machine
- `tool_registry/executor.rs` — Wasmtime execution with permission enforcement
- `api/ws.rs` — WebSocket handler
- `api/webhook.rs` — Webhook handler

**Cognition Engine (`cognition-engine/cognition_engine/`):**
- `service.py` — gRPC RPC implementations
- `llm_client.py` — LiteLLM wrapper with primary/fallback and retry
- `prompt_formatter.py` — Jinja2 template rendering (`templates/default`, `templates/json_output`)
- `token_counter.py` — Model-aware counting with tiktoken fallback
- `output_parser.py` — JSON extraction, heuristic repair, Pydantic validation, optional re-prompting
- `settings.py` — Pydantic settings

**Protocol:**
- `proto/cognition.proto` — gRPC service definition (Complete, StreamComplete, CountTokens, ParseOutput)
