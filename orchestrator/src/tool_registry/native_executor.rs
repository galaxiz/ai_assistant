//! Native (OS binary) tool executor.
//!
//! Runs an allow-listed OS binary as a subprocess with:
//!   - Environment scrubbing (only PATH, HOME, LANG, TERM, TZ are inherited)
//!   - Working directory pinned to `sandbox_root`
//!   - Per-tool timeout via `tokio::time::timeout`
//!   - Output truncation at `max_output_bytes`
//!   - No shell — `Command::new(binary)` directly, preventing injection
//!   - Optional stdin piping for tools that mark an arg with `is_stdin = true`

use std::{collections::HashSet, path::Path, process::Stdio, time::Duration};

use serde_json::Value;
use tracing::instrument;

use super::definition::ToolDefinition;
use crate::errors::ToolError;

const TRUNCATION_SUFFIX: &str = "\n[truncated]";

/// Run an OS binary described by `definition` with the validated JSON `args`.
///
/// # Security controls
/// - `binary` must appear in `allowed_binaries`; otherwise `ToolError::PermissionDenied`.
/// - Execution is wrapped in `tokio::time::timeout(definition.timeout_secs)`.
/// - The subprocess's working directory is set to `sandbox_root`.
/// - Environment is cleared; only `PATH`, `HOME`, `LANG`, `TERM`, and `TZ` are re-injected.
/// - Combined stdout+stderr is capped at `max_output_bytes`; excess is replaced with
///   `"\n[truncated]"`.
/// - If any arg in the definition has `is_stdin = true`, its value is piped to the
///   process's stdin instead of being added to argv.
///
/// # Output
/// Returns a JSON string: `{"stdout":"…","stderr":"…","exit_code":0}`.
#[instrument(skip(definition, args, allowed_binaries), fields(tool = %definition.name))]
pub async fn run(
    definition: &ToolDefinition,
    args: &Value,
    allowed_binaries: &HashSet<String>,
    sandbox_root: &Path,
    max_output_bytes: usize,
) -> Result<String, ToolError> {
    let binary = definition.binary.as_deref().ok_or_else(|| {
        ToolError::Execution(anyhow::anyhow!("native tool has no `binary` field"))
    })?;

    if !allowed_binaries.contains(binary) {
        return Err(ToolError::PermissionDenied(format!(
            "binary `{binary}` is not in the allowed_binaries list"
        )));
    }

    let argv = build_argv(definition, args);

    // Extract the stdin arg value, if any arg is marked `is_stdin = true`.
    let stdin_content = definition
        .args
        .iter()
        .find(|a| a.is_stdin)
        .and_then(|a| args.get(&a.name))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let sandbox_root = sandbox_root.to_path_buf();
    let binary = binary.to_string();
    let timeout_secs = definition.timeout_secs;

    let result = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        spawn(binary, argv, stdin_content, sandbox_root, max_output_bytes),
    )
    .await
    .map_err(|_| ToolError::Timeout { secs: timeout_secs })??;

    Ok(result)
}

/// Spawn the binary and collect its output.
async fn spawn(
    binary: String,
    argv: Vec<String>,
    stdin_content: Option<String>,
    sandbox_root: std::path::PathBuf,
    max_output_bytes: usize,
) -> Result<String, ToolError> {
    // Collect env vars we want to forward before clearing.
    let path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let lang = std::env::var("LANG").unwrap_or_default();
    let term = std::env::var("TERM").unwrap_or_default();
    let tz = std::env::var("TZ").unwrap_or_default();

    let mut child = tokio::process::Command::new(&binary)
        .args(&argv)
        .current_dir(&sandbox_root)
        .env_clear()
        .env("PATH", &path)
        .env("HOME", &home)
        .env("LANG", &lang)
        .env("TERM", &term)
        .env("TZ", &tz)
        .stdin(if stdin_content.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ToolError::Execution(anyhow::anyhow!("failed to spawn `{binary}`: {e}")))?;

    // Write stdin content and close the pipe so the process sees EOF.
    if let Some(content) = stdin_content {
        let mut stdin = child.stdin.take().expect("stdin was piped");
        tokio::io::AsyncWriteExt::write_all(&mut stdin, content.as_bytes())
            .await
            .map_err(|e| ToolError::Execution(anyhow::anyhow!("failed to write stdin: {e}")))?;
        // Drop closes the pipe, signalling EOF to the child.
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| ToolError::Execution(anyhow::anyhow!("failed to wait for `{binary}`: {e}")))?;

    let stdout = truncate(output.stdout, max_output_bytes);
    let stderr = truncate(output.stderr, max_output_bytes.saturating_sub(stdout.len()));
    let exit_code = output.status.code().unwrap_or(-1);

    let result = serde_json::json!({
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": exit_code,
    });

    Ok(result.to_string())
}

/// Truncate raw bytes to `limit`, decode as UTF-8 (lossy), and append the
/// truncation marker when bytes were dropped.
fn truncate(bytes: Vec<u8>, limit: usize) -> String {
    if bytes.len() <= limit {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        let mut s = String::from_utf8_lossy(&bytes[..limit]).into_owned();
        s.push_str(TRUNCATION_SUFFIX);
        s
    }
}

/// Build the argv vector from the tool definition and validated args.
///
/// Convention:
///   1. Args with `positional = true` are appended in definition order (skipped if null).
///   2. All other args become `--name=value` flags (skipped if null).
///   3. Boolean `true` → `--name` (flag only); boolean `false` → omitted.
pub fn build_argv(definition: &ToolDefinition, args: &Value) -> Vec<String> {
    let obj = match args.as_object() {
        Some(o) => o,
        None => return definition.command_args.clone(),
    };

    // Start with any fixed prefix args (e.g. ["diff"] for `git diff`).
    let mut argv = definition.command_args.clone();

    // Pass 1 — positional args in definition order.
    for arg_def in &definition.args {
        if !arg_def.positional || arg_def.is_stdin {
            continue;
        }
        if let Some(val) = obj.get(&arg_def.name) {
            if !val.is_null() {
                argv.push(json_value_to_string(val));
            }
        }
    }

    // Pass 2 — named flags (--name=value or --name for booleans).
    for arg_def in &definition.args {
        if arg_def.positional || arg_def.is_stdin {
            continue;
        }
        match obj.get(&arg_def.name) {
            Some(Value::Bool(true)) => {
                argv.push(format!("--{}", arg_def.name));
            }
            Some(Value::Bool(false)) | Some(Value::Null) | None => {
                // Omit the flag entirely.
            }
            Some(val) => {
                argv.push(format!("--{}={}", arg_def.name, json_value_to_string(val)));
            }
        }
    }

    argv
}

fn json_value_to_string(val: &Value) -> String {
    match val {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_registry::definition::{ArgDef, ToolBackend, ToolDefinition, ToolPermissions};

    fn make_def(args: Vec<ArgDef>) -> ToolDefinition {
        ToolDefinition {
            name: "test".into(),
            version: "0.1.0".into(),
            description: "test".into(),
            backend: ToolBackend::Native,
            wasm: None,
            binary: Some("echo".into()),
            command_args: vec![],
            timeout_secs: 5,
            permissions: ToolPermissions::default(),
            args,
            docs: String::new(),
        }
    }

    fn arg(name: &str, positional: bool) -> ArgDef {
        ArgDef {
            name: name.into(),
            ty: "string".into(),
            required: false,
            description: String::new(),
            default: None,
            positional,
            is_stdin: false,
        }
    }

    #[test]
    fn test_build_argv_positional() {
        let def = make_def(vec![arg("path", true), arg("output", true)]);
        let args = serde_json::json!({"path": "/tmp/x", "output": "/tmp/y"});
        let argv = build_argv(&def, &args);
        assert_eq!(argv, vec!["/tmp/x", "/tmp/y"]);
    }

    #[test]
    fn test_build_argv_boolean_flags() {
        let def = make_def(vec![
            ArgDef {
                name: "verbose".into(),
                ty: "boolean".into(),
                required: false,
                description: String::new(),
                default: None,
                positional: false,
                is_stdin: false,
            },
            ArgDef {
                name: "quiet".into(),
                ty: "boolean".into(),
                required: false,
                description: String::new(),
                default: None,
                positional: false,
                is_stdin: false,
            },
        ]);
        let args = serde_json::json!({"verbose": true, "quiet": false});
        let argv = build_argv(&def, &args);
        assert_eq!(argv, vec!["--verbose"]);
    }

    #[test]
    fn test_build_argv_named_flag() {
        let def = make_def(vec![arg("format", false)]);
        let args = serde_json::json!({"format": "json"});
        let argv = build_argv(&def, &args);
        assert_eq!(argv, vec!["--format=json"]);
    }

    #[test]
    fn test_build_argv_null_skipped() {
        let def = make_def(vec![arg("path", true), arg("format", false)]);
        let args = serde_json::json!({"path": null, "format": null});
        let argv = build_argv(&def, &args);
        assert!(argv.is_empty());
    }

    #[test]
    fn test_truncate_under_limit() {
        let s = truncate(b"hello".to_vec(), 100);
        assert_eq!(s, "hello");
    }

    #[test]
    fn test_truncate_over_limit() {
        let s = truncate(b"hello world".to_vec(), 5);
        assert!(s.starts_with("hello"));
        assert!(s.ends_with(TRUNCATION_SUFFIX));
    }
}
