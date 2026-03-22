# Tool Execution Sandbox — Hardening (Option A)

Harden the existing in-process Wasm sandbox in `orchestrator/src/tool_registry/` and build a reference tool. No crate extraction.

> Native CLI tool execution is scoped separately in [`tool_execution_native.md`](tool_execution_native.md).

---

## Proposed Changes

### 1. Argument Validation

#### [MODIFY] `src/tool_registry/definition.rs`

Add a `validate_args(args_json: &str) -> Result<Value, ToolError>` method to `ToolDefinition`:
- Check all `required: true` args are present
- Type-check values against `ArgDef.ty` (`"string"` → `Value::String`, `"integer"` → `Value::Number` with `is_i64()`, `"boolean"` → `Value::Bool`, `"object"` → `Value::Object`)
- Inject `default` values for missing optional args
- Return `ToolError::InvalidArgs` with a descriptive message on mismatch

#### [MODIFY] `src/tool_registry/mod.rs`

Call `definition.validate_args(args_json)?` in `execute()` **before** Wasm compilation/invocation (around line 112).

---

### 2. WASI Stdout Capture

#### [MODIFY] `src/tool_registry/executor.rs`

Replace `builder.inherit_stdout()` (line 59) with a pipe-based capture:
- Use `wasmtime_wasi`'s `pipe::MemoryOutputPipe` (or `WritePipe<Vec<u8>>`) for stdout
- After `_start` completes, read the pipe contents and return as the tool result instead of `"{}"`
- Keep `inherit_stderr()` so error output still goes to the orchestrator's logs

This fixes the dead code path at line 145 where `_start` tools always return `"{}"`.

---

### 3. Configurable Sandbox Directories

#### [MODIFY] `src/tool_registry/definition.rs`

Add optional `sandbox_root` field to `ToolPermissions`:
```rust
#[serde(default)]
pub sandbox_root: Option<String>, // e.g. "/workspace"
```

#### [MODIFY] `src/tool_registry/executor.rs`

- Replace hardcoded `".", "."` preopens (lines 63–74) with `sandbox_root` from permissions (or a global default from `ToolSettings`)
- Pass the global default sandbox root through to `execute_sync` (new parameter or bundled in a config struct)

#### [MODIFY] `src/config.rs`

Add `sandbox_root: PathBuf` to `ToolSettings` with default `"."`:
```rust
pub sandbox_root: std::path::PathBuf,
```

---

### 4. Reference `.wasm` Tool — `read_file`

#### [NEW] `tools/read_file.md`

Tool definition with TOML frontmatter: `name = "read_file"`, `fs_read = true`, arg `path` (string, required), arg `max_bytes` (integer, optional, default 4096).

#### [NEW] `tools/src/read_file/`

Minimal Rust crate:
- `Cargo.toml` targeting `wasm32-wasi`
- `src/main.rs` — reads `path` from stdin/args JSON, reads up to `max_bytes` from the file via WASI fs, writes result JSON to stdout
- Build script or Makefile entry producing `tools/read_file.wasm`

> **Note:** Building to `wasm32-wasi` requires the target installed: `rustup target add wasm32-wasi`. This is a one-time setup step.

---

### 5. Integration Test

#### [NEW] `tests/tool_sandbox_integration.rs`

End-to-end test (follows pattern of existing `cognition_integration.rs`):
- Load `ToolRegistry` from `tools/` directory
- Verify `read_file` is in `list_schemas()`
- Execute `read_file` with a temp file path → assert correct content returned
- Test invalid args → assert `ToolError::InvalidArgs`
- Test missing tool → assert `ToolError::NotFound`
- Test permission denied (read a path outside sandbox) → verify sandboxed

---

### 6. Unit Tests for New Logic

#### [MODIFY] `src/tool_registry/tests.rs`

Add tests:
- `test_validate_args_required_missing` — missing required arg returns `InvalidArgs`
- `test_validate_args_type_mismatch` — wrong type returns `InvalidArgs`
- `test_validate_args_defaults_injected` — optional arg gets default value
- `test_stdout_capture` — WAT module that writes to fd 1 (stdout), verify captured output is returned

---

## Summary of Files Changed

| Action | File | Description |
|---|---|---|
| MODIFY | `src/tool_registry/definition.rs` | `validate_args()`, `sandbox_root` field |
| MODIFY | `src/tool_registry/executor.rs` | Stdout capture, configurable preopens |
| MODIFY | `src/tool_registry/mod.rs` | Call validation before execution |
| MODIFY | `src/tool_registry/tests.rs` | New unit tests |
| MODIFY | `src/config.rs` | `sandbox_root` in `ToolSettings` |
| NEW | `tools/read_file.md` | Reference tool definition |
| NEW | `tools/src/read_file/` | Rust source → `wasm32-wasi` |
| NEW | `tests/tool_sandbox_integration.rs` | Integration test |

---

## Verification Plan

### Automated Tests
```bash
# Unit tests (including new validation + stdout capture tests)
cargo test tool_registry

# Build reference wasm tool
cd tools/src/read_file && cargo build --target wasm32-wasi --release
cp target/wasm32-wasi/release/read_file.wasm ../../read_file.wasm

# Integration test
cargo test --test tool_sandbox_integration
```

### Manual Verification
- `cargo clippy` — no new warnings
- Confirm `tools/read_file.wasm` is loadable by the registry at startup

---

## Appendix: Option B — Crate Extraction (Deferred)

Option B would extract the sandbox into a standalone crate at `/tool_sandbox/`:

- **What**: Move `tool_registry/` source into a new `tool_sandbox` Rust crate (either a workspace member or standalone). The orchestrator would import it as a dependency via `tool_sandbox = { path = "../tool_sandbox" }`.
- **Structure**: `tool_sandbox/src/lib.rs` (public API: `ToolRegistry`, `ToolDefinition`, `ToolExecutor`), with `definition.rs` and `executor.rs` as submodules. Error types move into the new crate; `orchestrator/src/errors.rs` re-exports or wraps them.
- **Benefits**: Independent compilation/testing, cleaner dependency graph, enables eventual out-of-process execution (e.g., the sandbox as a separate sidecar container communicating via Unix socket or gRPC).
- **Costs**: Refactor overhead (move code, update imports across orchestrator, adjust `Cargo.toml` workspace), no immediate functional gain since the protocol is in-process host functions.
- **When to revisit**: If the sandbox needs to run as a separate process for security isolation, or if multiple services need to share the same tool execution logic.
