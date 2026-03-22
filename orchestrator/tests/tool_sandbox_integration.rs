//! Integration tests for the Wasm tool sandbox.
//!
//! These tests load the real `tools/` directory and execute the `read_file`
//! tool against the pre-built `tools/read_file.wasm` artifact.
//!
//! Run with:
//!   cargo test --test tool_sandbox_integration
//!
//! To rebuild the wasm artifact first:
//!   cd tools/src/read_file && cargo build --target wasm32-wasip1 --release
//!   cp target/wasm32-wasip1/release/read_file.wasm ../../

use std::{path::PathBuf, sync::Arc};

use orchestrator::{errors::ToolError, tool_registry::ToolRegistry};

fn tools_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tools")
}

async fn load_registry(sandbox_root: PathBuf) -> Arc<ToolRegistry> {
    ToolRegistry::load(&tools_dir(), 256, sandbox_root, std::collections::HashSet::new(), 65536)
        .await
        .map(Arc::new)
        .expect("failed to load tool registry from tools/")
}

async fn load_registry_with_binaries(
    sandbox_root: PathBuf,
    allowed_binaries: std::collections::HashSet<String>,
) -> Arc<ToolRegistry> {
    ToolRegistry::load(&tools_dir(), 256, sandbox_root, allowed_binaries, 65536)
        .await
        .map(Arc::new)
        .expect("failed to load tool registry from tools/")
}

/// Initialise a minimal git repo in `dir` with one committed file, then
/// write an unstaged modification so `git diff` has something to show.
fn init_git_repo_with_diff(dir: &std::path::Path) {
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"));
    };
    run(&["init"]);
    run(&["config", "user.email", "test@example.com"]);
    run(&["config", "user.name", "Test"]);
    std::fs::write(dir.join("foo.txt"), "original\n").unwrap();
    run(&["add", "foo.txt"]);
    run(&["commit", "-m", "init"]);
    // Unstaged modification — this is what `git diff` shows.
    std::fs::write(dir.join("foo.txt"), "modified\n").unwrap();
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema / discovery
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_read_file_in_list_schemas() {
    let registry = load_registry(PathBuf::from(".")).await;
    let schemas = registry.list_schemas().await;
    let names: Vec<&str> = schemas.iter().map(|d| d.name.as_str()).collect();
    assert!(
        names.contains(&"read_file"),
        "read_file not found in schemas: {names:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Successful execution
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_read_file_returns_content() {
    // Set up a temp directory as the sandbox root, write a file into it.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let file_path = sandbox.path().join("hello.txt");
    std::fs::write(&file_path, "hello from sandbox").expect("write test file");

    let registry = load_registry(sandbox.path().to_path_buf()).await;

    let args = r#"{"path": "hello.txt"}"#;
    let result = registry.execute("read_file", args).await.expect("execute read_file");

    let json: serde_json::Value = serde_json::from_str(&result)
        .unwrap_or_else(|_| panic!("output is not JSON: {result}"));
    assert_eq!(
        json["content"].as_str().expect("content field"),
        "hello from sandbox"
    );
}

#[tokio::test]
async fn test_read_file_respects_max_bytes() {
    let sandbox = tempfile::tempdir().expect("tempdir");
    std::fs::write(sandbox.path().join("data.txt"), "abcdefghij").expect("write");

    let registry = load_registry(sandbox.path().to_path_buf()).await;

    // max_bytes=3 should truncate to "abc"
    let args = r#"{"path": "data.txt", "max_bytes": 3}"#;
    let result = registry.execute("read_file", args).await.expect("execute");

    let json: serde_json::Value = serde_json::from_str(&result)
        .unwrap_or_else(|_| panic!("output is not JSON: {result}"));
    assert_eq!(json["content"].as_str().expect("content"), "abc");
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument validation (ToolError::InvalidArgs — checked before Wasm runs)
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_read_file_missing_required_arg() {
    let registry = load_registry(PathBuf::from(".")).await;

    // `path` is required — omitting it should return InvalidArgs before Wasm runs.
    let err = registry.execute("read_file", "{}").await.unwrap_err();
    assert!(
        matches!(err, ToolError::InvalidArgs(ref msg) if msg.contains("path")),
        "expected InvalidArgs for missing path, got: {err:?}"
    );
}

#[tokio::test]
async fn test_read_file_wrong_arg_type() {
    let registry = load_registry(PathBuf::from(".")).await;

    // `max_bytes` must be an integer.
    let err = registry
        .execute("read_file", r#"{"path": "f.txt", "max_bytes": "big"}"#)
        .await
        .unwrap_err();
    assert!(
        matches!(err, ToolError::InvalidArgs(ref msg) if msg.contains("max_bytes")),
        "expected InvalidArgs for wrong type, got: {err:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool not found
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_missing_tool_returns_not_found() {
    let registry = load_registry(PathBuf::from(".")).await;

    let err = registry.execute("no_such_tool", "{}").await.unwrap_err();
    assert!(
        matches!(err, ToolError::NotFound(_)),
        "expected NotFound, got: {err:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox path enforcement
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_read_file_path_outside_sandbox() {
    // The sandbox root is an empty temp dir; the tool tries to read a file
    // that is not relative to that root.  WASI rejects the path, and the
    // tool emits {"error": "..."} to stdout rather than crashing.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let registry = load_registry(sandbox.path().to_path_buf()).await;

    // Pass a filename that doesn't exist inside the sandbox.
    let args = r#"{"path": "nonexistent.txt"}"#;
    let result = registry
        .execute("read_file", args)
        .await
        .expect("tool should run and return error JSON, not a ToolError");

    let json: serde_json::Value = serde_json::from_str(&result)
        .unwrap_or_else(|_| panic!("output is not JSON: {result}"));
    assert!(
        json.get("error").is_some(),
        "expected {{\"error\": ...}} for missing file, got: {result}"
    );
}

#[tokio::test]
async fn test_read_file_absolute_path_denied_by_wasi() {
    // An absolute path that exists on the host but is outside the sandbox.
    // WASI preview1 path_open rejects absolute paths that don't resolve
    // through a preopened directory, so the tool should return an error.
    let sandbox = tempfile::tempdir().expect("tempdir");
    let registry = load_registry(sandbox.path().to_path_buf()).await;

    // Use a well-known file that definitely exists on the host.
    let args = r#"{"path": "/etc/hosts"}"#;
    let result = registry
        .execute("read_file", args)
        .await
        .expect("tool should run and return error JSON, not a ToolError");

    let json: serde_json::Value = serde_json::from_str(&result)
        .unwrap_or_else(|_| panic!("output is not JSON: {result}"));
    assert!(
        json.get("error").is_some(),
        "WASI should have blocked access to /etc/hosts, got: {result}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Native backend — git_diff tool
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_git_diff_in_list_schemas() {
    let registry = load_registry(PathBuf::from(".")).await;
    let schemas = registry.list_schemas().await;
    let names: Vec<&str> = schemas.iter().map(|d| d.name.as_str()).collect();
    assert!(
        names.contains(&"git_diff"),
        "git_diff not found in schemas: {names:?}"
    );
}

#[tokio::test]
async fn test_git_diff_captures_diff() {
    let repo = tempfile::tempdir().expect("tempdir");
    init_git_repo_with_diff(repo.path());

    let allowed = std::collections::HashSet::from(["git".to_string()]);
    let registry = load_registry_with_binaries(repo.path().to_path_buf(), allowed).await;

    let result = registry
        .execute("git_diff", "{}")
        .await
        .expect("git_diff should succeed");

    let v: serde_json::Value = serde_json::from_str(&result)
        .unwrap_or_else(|_| panic!("output is not JSON: {result}"));
    let stdout = v["stdout"].as_str().unwrap();
    assert!(
        stdout.contains("diff") && stdout.contains("modified"),
        "expected diff output, got stdout: {stdout:?}"
    );
    assert_eq!(v["exit_code"], serde_json::json!(0));
}

#[tokio::test]
async fn test_git_diff_permission_denied_without_allowlist() {
    let repo = tempfile::tempdir().expect("tempdir");
    // Empty allow-list — git is not permitted.
    let registry = load_registry(repo.path().to_path_buf()).await;

    let err = registry.execute("git_diff", "{}").await.unwrap_err();
    assert!(
        matches!(err, ToolError::PermissionDenied(_)),
        "expected PermissionDenied, got: {err:?}"
    );
}
