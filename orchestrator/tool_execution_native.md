# Tool Execution — Native Command Executor

Add a second execution backend to the tool registry so OS-installed CLI binaries (e.g. `curl`, `git`, `jq`, `grep`) can be exposed as tools alongside Wasm tools. No changes to the Wasm executor path.

---

## Proposed Changes

### 1. Backend Discriminator in Tool Definitions

#### [MODIFY] `src/tool_registry/definition.rs`

Make `wasm` optional and add a `backend` + `binary` field to `ToolDefinition`:

```rust
/// Which executor backend runs this tool.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ToolBackend {
    #[default]
    Wasm,
    Native,
}

pub struct ToolDefinition {
    // ... existing fields ...

    #[serde(default)]
    pub backend: ToolBackend, // default = Wasm (backwards-compatible)

    /// Path to `.wasm` binary. Required when backend = "wasm".
    pub wasm: Option<PathBuf>,

    /// OS binary name. Required when backend = "native".
    /// Must appear in the global allow-list (`ToolSettings::allowed_binaries`).
    pub binary: Option<String>,
}
```

Update `parse_tool_md` to validate:
- `backend = "wasm"` → `wasm` must be `Some`
- `backend = "native"` → `binary` must be `Some`

Return `ToolError::ParseError` on mismatch.

Also add `positional` flag to `ArgDef` (used by the native executor to map JSON args to CLI argv):

```rust
pub struct ArgDef {
    // ... existing fields ...
    /// If true, this arg is passed as a positional argument (no `--` prefix).
    #[serde(default)]
    pub positional: bool,
}
```

##### Example native tool definition — `tools/git_diff.md`

```toml
---
name = "git_diff"
version = "0.1.0"
description = "Show unstaged changes in the working tree."
backend = "native"
binary = "git"
timeout_secs = 15

[permissions]
fs_read = true

[[args]]
name = "path"
type = "string"
required = false
description = "Limit diff to a specific file or directory."
---

# git_diff

Runs `git diff [path]` and returns the output.
```

---

### 2. Native Executor Module

#### [NEW] `src/tool_registry/native_executor.rs`

New module that runs an OS command via `std::process::Command`:

```rust
pub async fn run(
    definition: &ToolDefinition,
    args: &serde_json::Value,
    allowed_binaries: &HashSet<String>,
    sandbox_root: &Path,
    max_output_bytes: usize,
) -> Result<String, ToolError>
```

**Security controls:**

| Control | Implementation |
|---|---|
| Binary allow-list | Reject if `definition.binary` is not in `allowed_binaries`. Return `ToolError::PermissionDenied`. |
| Timeout | Wrap in `tokio::time::timeout(Duration::from_secs(definition.timeout_secs), ...)`. Return `ToolError::Timeout`. |
| Working directory | Set `Command::current_dir(sandbox_root)` — commands see only this directory as their working root. |
| Environment scrub | Call `Command::env_clear()` then re-inject only `PATH`, `HOME`, `LANG`, and `TERM`. |
| Output truncation | Cap stdout + stderr at `max_output_bytes` (default 64 KiB from config). Append `"\n[truncated]"` if exceeded. |
| No shell | Use `Command::new(binary).args(...)` directly — **never** `sh -c`. This prevents injection. |

**Argument mapping** — translate the validated JSON args object into CLI argv:

```rust
/// Builds the argv vector from the tool definition and validated args.
///
/// Convention:
///   1. Args with `positional = true` in their ArgDef are appended in
///      definition order (only if the value is non-null).
///   2. All other args become `--name=value` flags.
///   3. Boolean `true` → `--name`, `false` → omitted.
fn build_argv(definition: &ToolDefinition, args: &Value) -> Vec<String>
```

**Result format** — return a JSON string matching the Wasm convention:

```json
{"stdout": "<captured stdout>", "stderr": "<captured stderr>", "exit_code": 0}
```

Return `ToolError::Execution` if the binary cannot be spawned (e.g. not found on `PATH`).

---

### 3. Registry Dispatch

#### [MODIFY] `src/tool_registry/mod.rs`

`ToolEntry` is unchanged structurally — the `module` field simply stays `None` for native tools. In `execute()`, after arg validation, branch on backend:

```rust
match definition.backend {
    ToolBackend::Wasm => {
        // existing path: lazy-compile, cache module, call executor::run
    }
    ToolBackend::Native => {
        native_executor::run(
            &definition,
            &validated_args,
            &self.allowed_binaries,
            &sandbox_root,
            self.max_output_bytes,
        ).await
    }
}
```

Add `allowed_binaries: HashSet<String>` and `max_output_bytes: usize` fields to `ToolRegistry`, populated from config at `load()` time.

---

### 4. Configuration

#### [MODIFY] `src/config.rs`

Add to `ToolSettings`:

```rust
/// Binaries that native tools are allowed to invoke.
/// If empty, all native tools are rejected (fail-closed).
pub allowed_binaries: Vec<String>,

/// Maximum bytes captured from native tool stdout+stderr combined.
pub max_output_bytes: usize,
```

Defaults:
```rust
.set_default("tools.allowed_binaries", Vec::<String>::new())? // fail-closed
.set_default("tools.max_output_bytes", 65536)?                // 64 KiB
```

Environment override: `ORCH__TOOLS__ALLOWED_BINARIES="git,curl,jq"`

---

### 5. Reference Native Tool — `git_diff`

#### [NEW] `tools/git_diff.md`

Tool definition (shown in section 1 above). Exercises the native executor path end-to-end.

---

### 6. Tests

#### [MODIFY] `src/tool_registry/tests.rs`

New unit tests:
- `test_native_echo` — invoke `/bin/echo` with a positional arg, verify stdout captured
- `test_native_binary_not_in_allowlist` — verify `ToolError::PermissionDenied` when binary is not in the allow-list
- `test_native_timeout` — invoke `sleep 60` with `timeout_secs = 1`, verify `ToolError::Timeout`
- `test_native_output_truncation` — invoke a command that produces >64 KiB, verify output ends with `[truncated]`
- `test_build_argv_positional` — verify positional arg ordering and `--flag=value` formatting
- `test_build_argv_boolean_flags` — verify `true` → `--flag`, `false` → omitted

#### [MODIFY] `tests/tool_sandbox_integration.rs`

- Register `git_diff.md` from `tools/` with `"git"` in the allow-list
- Execute `git_diff` in a temp git repo → verify output contains diff text
- Execute with an empty allow-list → verify `PermissionDenied`

---

## Summary of Files Changed

| Action | File | Description |
|---|---|---|
| MODIFY | `src/tool_registry/definition.rs` | `ToolBackend` enum, `binary` + `positional` fields on `ArgDef` |
| NEW | `src/tool_registry/native_executor.rs` | Native command executor with security controls |
| MODIFY | `src/tool_registry/mod.rs` | Dispatch to native/wasm backend, new registry fields |
| MODIFY | `src/tool_registry/tests.rs` | Native executor unit tests |
| MODIFY | `src/config.rs` | `allowed_binaries`, `max_output_bytes` in `ToolSettings` |
| NEW | `tools/git_diff.md` | Reference native tool definition |
| MODIFY | `tests/tool_sandbox_integration.rs` | Native backend integration tests |

---

## Verification Plan

### Automated Tests
```bash
# Unit tests (native executor)
cargo test tool_registry

# Integration tests (native backend)
cargo test --test tool_sandbox_integration
```

### Manual Verification
- `cargo clippy` — no new warnings
- Confirm `tools/git_diff.md` is loaded and appears in `list_schemas()` output
- Run the orchestrator with `ORCH__TOOLS__ALLOWED_BINARIES="git"` and invoke `git_diff` via the agent loop
- Run with an empty allow-list and verify `git_diff` is rejected with `PermissionDenied`
