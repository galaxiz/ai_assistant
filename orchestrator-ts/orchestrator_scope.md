# Orchestrator (TypeScript) – Work Scope

## Overview

The Orchestrator is the **core daemon** of the AI Agent system. This is the **TypeScript / Node.js** implementation, a port of the existing Rust orchestrator. It is the central hub that connects all other components:

| Connection | Protocol | Notes |
|---|---|---|
| Orchestrator ↔ Cognition Engine | gRPC (protobuf) | [cognition.proto](file:///Users/xizhao/projects/ai_agent/proto/cognition.proto) already defined with 4 RPCs |
| Orchestrator ↔ Tool Sandbox | In-process (WASI host functions) | Via Node WASI / `wasmtime` bindings |
| Orchestrator ↔ Memory/Storage | HTTP/gRPC client | Qdrant vector DB |
| Messaging Adapters → Orchestrator | WebSockets or Webhooks | Inbound user messages |

**Responsibilities**: Event loop management, heartbeat scheduling, routing, and access control.
**Key design constraint**: Supports multiple concurrent sessions, each processed serially (single in-flight turn per session via an async mutex), each with separate agent memory.

> **Runtime target**: Node.js 20+ LTS, ESM, TypeScript `strict` mode. Node's single-threaded event loop replaces Rust's Tokio runtime; CPU-bound isolation (Wasm) runs on worker threads where needed.

---

## Prioritized Work Breakdown

### P0 — Project Scaffolding
> **Estimated effort**: Small
> **Dependencies**: None

- [x] Initialize Node project (`npm init`) in `/orchestrator-ts`, ESM (`"type": "module"`)
- [x] Set up `package.json` + `tsconfig.json` (strict, `NodeNext` module resolution) with initial dependencies:
  - `@grpc/grpc-js` + `@grpc/proto-loader` + `ts-proto` — gRPC client/server + protobuf codegen
  - `fastify` + `@fastify/websocket` — HTTP/WebSocket server
  - `zod` (runtime validation / structured parsing)
  - `uuid` (session IDs)
  - `pino` (structured logging)
- [x] Dev tooling: `tsx` (dev runner), `vitest` (tests), `typescript-eslint`, `prettier`, `tsup`/`tsc` (build)
- [x] Codegen script at `scripts/gen-proto.sh` (runs `protoc` + `ts-proto` plugin; requires `protoc` installed)
- [x] Verify bare project type-checks (`tsc --noEmit` passes)

---

### P1 — Session Model & State Management
> **Estimated effort**: Medium
> **Dependencies**: P0

- [x] Define `Session` type:
  - `sessionId: string` (UUID)
  - `createdAt: number` (epoch ms)
  - `lastActive: number`
  - `conversationHistory: Message[]` (mirrors proto `Message`)
  - `state: SessionState` union (`'idle' | 'processing' | 'awaitingTool' | 'error'`)
- [x] Define `SessionStore` (in-memory session registry):
  - `Map<string, Session>` with a per-session async lock (`async-mutex`)
  - Methods: `create()`, `get()`, `remove()`, `listActive()`, `cleanupExpired()`
  - `withSession()` helper acquires the per-session mutex and runs the callback with exclusive access
- [x] Ensure single-turn-at-a-time guarantee per session (per-session `Mutex` from `async-mutex`; serialises concurrent `withSession` calls on the same session)
- [x] Unit tests for session lifecycle (vitest, 20 tests covering create/get/remove/listActive/cleanupExpired/withSession)

---

### P2 — Cognition Engine gRPC Client
> **Estimated effort**: Medium
> **Dependencies**: P0

- [x] Hand-written TypeScript types in `src/cognition/types.ts` mirroring `proto/cognition.proto` (replaced by `npm run proto:gen` output when `protoc` is available)
- [x] Create `CognitionClient` wrapper class (`src/cognition/client.ts`) with:
  - Connection management via `@grpc/grpc-js` channel with keepalive options; auto-reconnects
  - `complete()` → calls `Complete` RPC (unary, with retry)
  - `streamComplete()` → calls `StreamComplete` RPC (returns `AsyncIterable<StreamChunk>`)
  - `countTokens()` → calls `CountTokens` RPC (unary, with retry)
  - `parseOutput()` → calls `ParseOutput` RPC (unary, with retry)
  - Stub is injectable for unit testing; `CognitionClient.fromConfig()` creates production instance
- [x] `RequestContext` (session_id, auth_token) embedded in every request message (matches proto schema)
- [x] Retry with exponential backoff + ±10% jitter for `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED` (`src/cognition/retry.ts`)
- [x] Config via `loadConfig()` reading `ORCH_COGNITION_*` env vars (`src/cognition/config.ts`)
- [x] 21 unit tests; 2 integration tests auto-skipped unless `ORCH_COGNITION_ENGINE_ADDRESS` is set

---

### P3 — Core Event Loop & Request Router
> **Estimated effort**: Large
> **Dependencies**: P1, P2

- [x] Define `AgentRequest` and `AgentResponse` types (`src/agent/types.ts`); also `ToolCall`, `ToolResult`, `ToolExecutor` interface (P4 implements), `MaxIterationsError`
- [x] Implement the main agent loop `runTurn()` (`src/agent/loop.ts`):
  1. Resolve or create session (creates new if sessionId absent or unknown)
  2. Append user message; acquire per-session exclusive lock via `withSession`
  3. Count tokens via CE; trim oldest non-system messages if over budget
  4. Call `Complete` on Cognition Engine
  5. Parse response for `` ```tool_call ``` `` blocks (`src/agent/protocol.ts`)
  6. If tool calls → execute all in parallel; catch errors per-call (error status, no throw); inject `` ```tool_result ``` `` blocks as next user message → loop
  7. Return `AgentResponse` when completion contains no tool calls
- [x] `AgentRouter` class (`src/agent/router.ts`) — dispatcher pattern wrapping `runTurn`; designed to be extended in P6 for WS/webhook adapters
- [x] Error paths handled: CE errors set session to `error` state and re-throw; tool errors captured as `status: 'error'` result and fed back to LLM
- [x] `MaxIterationsError` thrown and session set to `error` when loop hits `ORCH_AGENT_MAX_TOOL_ITERATIONS` (default 10)
- [x] 30 tests (13 protocol + 17 loop) covering happy path, tool calls, trimming, error paths, and max-iterations guard

---

### P4 — Tool Execution Sandbox Integration (WASI)
> **Estimated effort**: Large
> **Dependencies**: P0

- [x] Runtime: Node's built-in `node:wasi` (preview1) + `worker_threads`; each invocation gets a fresh worker for isolation and forcible cancellation via `worker.terminate()`
- [x] Host function interface: WASI `wasi_snapshot_preview1` (fd_write, args_get, proc_exit, etc.); file I/O gated by WASI preopens (`/` mounted only when `fs_read` or `fs_write` is true); network is reserved (not yet enforced at Wasm layer)
- [x] `WasmToolExecutor` implements `ToolExecutor` (`src/tools/executor.ts`):
  - Reads `.wasm` bytes from disk on first call, caches them in memory
  - `execute(call) → Promise<ToolResult>` — runs in worker, captures stdout via temp file, returns `{ status: 'ok' | 'error', output }`
  - Timeout enforced by `setTimeout` + `worker.terminate()` → throws `ToolTimeoutError`
  - `ToolNotFoundError` and `ToolTimeoutError` propagate; other errors become `status: 'error'` results
- [x] **Tool format**: `tool.md` (TOML frontmatter + Markdown description) — shared with Rust orchestrator
- [x] `ToolRegistry.fromDir()` scans `tools/*.md` at startup, parses only TOML frontmatter (`smol-toml`), builds in-memory map; skips invalid files with a warning
- [x] **Lazy loading**: `.wasm` bytes read + cached on first `execute()` call; `WebAssembly.compile()` happens inside each worker (fresh compile per invocation avoids cross-thread Module sharing complexity)
- [x] Permission scopes from frontmatter enforced via WASI preopen config in the worker
- [x] Added `src/types/webassembly-globals.d.ts` to declare `WebAssembly` as a runtime value (TypeScript ES2022 lib only has it as a namespace)
- [x] 17 tests: 11 registry (frontmatter parsing, error resilience) + 6 executor (noop, stdout capture, caching, not-found, timeout, missing wasm); WAT compiled inline with `wabt`

---

### P5 — Memory & Qdrant Integration
> **Estimated effort**: Medium
> **Dependencies**: P0

- [ ] Add `@qdrant/js-client-rest` dependency
- [ ] Implement `MemoryStore` class:
  - Client to Qdrant (HTTP/gRPC, connection reuse)
  - `store(sessionId, text, payload)` — embed and store arbitrary text
  - `search(sessionId, query, topK) → Promise<unknown[]>` — semantic search
  - `storeConversation(sessionId, messages)` — upsert full conversation snapshot (deterministic IDs, idempotent)
  - `getConversation(sessionId) → Promise<Message[]>` — scroll + sort by seq
  - `healthCheck()` — ping Qdrant for heartbeat use
- [ ] Embeddings in-process via `fastembed-js` or `@xenova/transformers` running **BAAI/bge-small-en-v1.5** (384-dim, ONNX) — no network hop, no extra service
- [ ] `EmbeddingEngine` singleton loaded once at startup; exposes `embed(text)` and `embedBatch(texts)`
- [ ] Per-session collection/namespace isolation in Qdrant (collection named `{prefix}_{sessionId}`)
- [ ] Connection health checks and reconnect logic (fail-open at startup with warning; health exposed via heartbeat)
- [ ] `MemoryStore` wired into entry point, router, WS state, and webhook state
- [ ] Conversation persisted to Qdrant after every agent turn (errors logged, never propagated)
- [ ] Integration test against a running Qdrant instance (skipped by default unless `QDRANT_URL` set)

---

### P6 — Inbound API Layer (WebSocket / Webhook)
> **Estimated effort**: Medium
> **Dependencies**: P3

- [ ] Use `fastify` (with `@fastify/websocket`) or `express` + `ws` for HTTP/WebSocket server
- [ ] WebSocket endpoint: `/ws` — persistent bidirectional connection per user
  - On connect → create or resume session
  - On message → enqueue `AgentRequest` into event loop
  - On response → push `AgentResponse` back through socket
- [ ] Webhook endpoint: `POST /webhook` — stateless request/response
  - Authenticate (HMAC signature or token)
  - Map to session, run agent loop, return response
- [ ] User authentication middleware (token validation)
- [ ] Rate limiting per user/session

---

### P7 — Heartbeat & Health
> **Estimated effort**: Small
> **Dependencies**: P1, P2, P5

- [ ] Background timer: periodic heartbeat to check:
  - Cognition Engine connectivity (gRPC health check — it already exposes `grpc.health.v1`)
  - Qdrant health
  - Session cleanup (remove expired/idle sessions)
- [ ] Expose health endpoint: `GET /health` returning JSON status of each subsystem
- [ ] gRPC health service on the Orchestrator itself (for upstream monitoring)

---

### P8 — Access Control
> **Estimated effort**: Small–Medium
> **Dependencies**: P6

- [ ] Define `AccessPolicy` model:
  - Which tools a session/user can invoke
  - Which models can be requested (pass through to Cognition Engine)
  - Rate limits per user
- [ ] Middleware to restrict routes/actions by policy
- [ ] Populate `RequestContext.auth_token` from validated user credentials

---

### P9 — OpenTelemetry Instrumentation
> **Estimated effort**: Small
> **Dependencies**: P3

- [ ] Configure `@opentelemetry/sdk-node` with OTLP exporter (`@opentelemetry/exporter-trace-otlp-grpc`)
- [ ] Instrument key spans:
  - Full request lifecycle (`session_id`, `user_id` as span attributes)
  - Cognition Engine RPC calls (timing, status)
  - Tool execution (tool name, duration, success/failure)
  - Memory queries
- [ ] Auto-instrumentation for HTTP/gRPC via `@opentelemetry/auto-instrumentations-node`
- [ ] Config: OTLP endpoint, service name, sampling rate (env vars)

---

### P10 — Containerization & CI
> **Estimated effort**: Small
> **Dependencies**: P0+

- [ ] Multi-stage `Dockerfile` (builder with `npm ci` + `tsc` → slim `node:20-slim` runtime)
- [ ] `.dockerignore`
- [ ] `docker-compose.yml` update to run Orchestrator-ts alongside Cognition Engine + Qdrant
- [ ] CI workflow: `eslint`, `tsc --noEmit`, `vitest run`, `npm run build`

---

## Suggested Implementation Order

```mermaid
graph TD
    P0[P0: Scaffolding] --> P1[P1: Session Model]
    P0 --> P2[P2: gRPC Client]
    P0 --> P4[P4: Wasm Sandbox]
    P0 --> P5[P5: Qdrant Memory]
    P1 --> P3[P3: Event Loop & Router]
    P2 --> P3
    P4 --> P3
    P5 --> P3
    P3 --> P6[P6: Inbound API]
    P3 --> P7[P7: Heartbeat & Health]
    P6 --> P8[P8: Access Control]
    P3 --> P9[P9: OpenTelemetry]
    P0 --> P10[P10: Container & CI]
```

**Critical path**: P0 → P2 → P3 → P6 (minimum for end-to-end user message → LLM response)

**Parallelizable after P0**: P1, P2, P4, P5 can all be developed independently.

---

## Key npm Dependencies

| Package | Purpose | Rust analog |
|---|---|---|
| `@grpc/grpc-js` | gRPC framework (client + server) | `tonic` |
| `ts-proto` / `@grpc/proto-loader` | Protobuf codegen / loading | `prost` |
| `fastify` + `@fastify/websocket` | HTTP/WebSocket server | `axum` |
| `node:wasi` / `@bytecodealliance/jco` | Wasm execution + WASI sandbox | `wasmtime` |
| `@qdrant/js-client-rest` | Qdrant vector DB | `qdrant-client` |
| `fastembed-js` / `@xenova/transformers` | BGE embeddings in-process (ONNX) | `fastembed` |
| `@opentelemetry/sdk-node` | Observability | `tracing-opentelemetry` |
| `zod` | Runtime validation / parsing | `serde` (+ validation) |
| `@iarna/toml` / `smol-toml` | `tool.md` frontmatter parsing | `toml` |
| `uuid` | Session IDs | `uuid` |
| `pino` | Structured logging | `tracing` |

## Design Decisions

### 1. Runtime — Node.js event loop

Node's single-threaded async runtime replaces Tokio. There is no real parallelism for JS code, so per-session serialization uses an **async mutex** rather than an OS thread lock — it guards against interleaved `await` points within a session. CPU-bound or untrusted work (Wasm tool execution) is offloaded to `worker_threads` so the main loop stays responsive and tools can be force-terminated on timeout. Distributed / multi-node sessions are explicitly out of scope.

### 2. Embedding Model — BGE in-process

Use `fastembed-js` (or `@xenova/transformers`) with `BAAI/bge-small-en-v1.5` (384-dim, ONNX). Runs entirely in the Orchestrator process — no network hop, no extra service. Upgrade path to `bge-base-en-v1.5` (768-dim) if retrieval quality needs improvement.

### 3. Tool Format — `tool.md` (TOML frontmatter + Markdown)

Identical to the Rust orchestrator so tool definitions are shared. Each tool lives as a self-describing file in a `tools/` directory:

```toml
---
name = "read_file"
version = "1.0.0"
description = "Read the contents of a local file."
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
description = "Absolute path of the file to read."

[[args]]
name = "max_bytes"
type = "integer"
required = false
default = 4096
description = "Max bytes to read."
---

# read_file

Reads a file from the local filesystem up to `max_bytes` bytes...
```

**Lazy loading**: at startup only the TOML frontmatter is parsed to build the in-memory registry. The `.wasm` binary is compiled and cached on first invocation. Each call gets a fresh instance/worker for isolation.

### 4. Tool-Call Protocol — JSON-in-Fence

Identical wire protocol to the Rust orchestrator. The LLM signals a tool call by emitting a `tool_call` fenced block. The Orchestrator detects it with a regex pass after each completion.

**LLM output (tool request):**
````
Some reasoning...

```tool_call
{
  "tool": "read_file",
  "call_id": "c1",
  "args": { "path": "/workspace/notes.txt" }
}
```
````

**Orchestrator injects back (tool result, as next message):**
````
```tool_result
{
  "call_id": "c1",
  "status": "ok",
  "output": "Hello from notes.txt"
}
```
````

**Agent loop with tool calls:**
```
user message
  ├─ count tokens, trim history if needed
  ├─ Complete / StreamComplete → LLM response
  │    ├─ contains ```tool_call```?
  │    │    ├─ YES → execute → inject tool_result → loop (max 10 iterations)
  │    │    └─ NO  → final response → adapter
  └─ error? → abort with structured error message
```

Available tool names + arg schemas (from registry) are injected into the system prompt at session start.

### 5. Parity with the Rust Orchestrator

This service is a behavioral port: same gRPC contract (`proto/cognition.proto`), same `tool.md` format, same tool-call wire protocol, same env-var configuration surface (`ORCH_*`), and the same WebSocket/webhook endpoints. The two implementations are interchangeable behind the messaging adapters, allowing side-by-side comparison and gradual migration.
