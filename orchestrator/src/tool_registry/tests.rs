//! Unit tests for the tool_registry executor.
//!
//! We build minimal Wasm modules from WAT (WebAssembly Text Format) inline
//! using wasmtime's built-in `wat` feature, so no external toolchain needed.

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use wasmtime::{Config, Engine, Module};

    use std::{collections::HashSet, path::Path};

    use crate::{
        errors::ToolError,
        tool_registry::{
            definition::{ToolBackend, ToolDefinition, ToolPermissions},
            executor,
            native_executor,
        },
    };

    /// Returns true when Wasm called proc_exit(0) — a successful WASI exit
    /// that wasmtime represents as a Trap, not Ok.
    fn is_wasi_exit_0(err: &ToolError) -> bool {
        if let ToolError::Execution(e) = err {
            // Walk the anyhow chain for the WASI exit message.
            for cause in e.chain() {
                let msg = cause.to_string();
                if msg.contains("exit status 0") || msg.contains("i32 exit status 0") {
                    return true;
                }
            }
        }
        false
    }

    fn test_engine() -> Engine {
        let mut cfg = Config::new();
        cfg.consume_fuel(true);
        Engine::new(&cfg).expect("engine")
    }

    fn simple_definition(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            version: "0.1.0".into(),
            description: "Test tool".into(),
            backend: ToolBackend::Wasm,
            wasm: Some(PathBuf::from("test.wasm")),
            binary: None,
            command_args: vec![],
            timeout_secs: 5,
            permissions: ToolPermissions::default(),
            args: vec![],
            docs: String::new(),
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // validate_args tests
    // ──────────────────────────────────────────────────────────────────────────

    use crate::tool_registry::definition::ArgDef;
    use serde_json::json;

    fn make_def_with_args(args: Vec<ArgDef>) -> ToolDefinition {
        ToolDefinition {
            name: "test".into(),
            version: "0.1.0".into(),
            description: "Test".into(),
            backend: ToolBackend::Wasm,
            wasm: Some(PathBuf::from("test.wasm")),
            binary: None,
            command_args: vec![],
            timeout_secs: 5,
            permissions: ToolPermissions::default(),
            args,
            docs: String::new(),
        }
    }

    #[test]
    fn test_validate_args_required_missing() {
        let def = make_def_with_args(vec![ArgDef {
            name: "path".into(),
            ty: "string".into(),
            required: true,
            description: String::new(),
            default: None,
            positional: false,
        }]);
        let err = def.validate_args("{}").unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidArgs(ref msg) if msg.contains("path")),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn test_validate_args_type_mismatch() {
        let def = make_def_with_args(vec![ArgDef {
            name: "count".into(),
            ty: "integer".into(),
            required: true,
            description: String::new(),
            default: None,
            positional: false,
        }]);
        // Passing a string where integer is expected.
        let err = def.validate_args(r#"{"count": "hello"}"#).unwrap_err();
        assert!(
            matches!(err, ToolError::InvalidArgs(ref msg) if msg.contains("count")),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn test_validate_args_defaults_injected() {
        let def = make_def_with_args(vec![ArgDef {
            name: "max_bytes".into(),
            ty: "integer".into(),
            required: false,
            description: String::new(),
            default: Some(json!(4096)),
            positional: false,
        }]);
        let result = def.validate_args("{}").unwrap();
        assert_eq!(result["max_bytes"], json!(4096));
    }

    #[test]
    fn test_validate_args_valid_passes() {
        let def = make_def_with_args(vec![
            ArgDef {
                name: "path".into(),
                ty: "string".into(),
                required: true,
                description: String::new(),
                default: None,
                positional: false,
            },
            ArgDef {
                name: "verbose".into(),
                ty: "boolean".into(),
                required: false,
                description: String::new(),
                default: Some(json!(false)),
                positional: false,
            },
        ]);
        let result = def.validate_args(r#"{"path": "/tmp/foo"}"#).unwrap();
        assert_eq!(result["path"], json!("/tmp/foo"));
        assert_eq!(result["verbose"], json!(false)); // default injected
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Stdout capture test
    // ──────────────────────────────────────────────────────────────────────────

    /// WAT module that writes `hello` to fd 1 (stdout) using WASI `fd_write`,
    /// then calls `proc_exit(0)`.
    ///
    /// Memory layout (byte offsets):
    ///   0..5   — "hello" (the string data)
    ///   8..12  — iovec.buf_ptr  = 0  (i32 LE)
    ///   12..16 — iovec.buf_len  = 5  (i32 LE)
    ///   16..20 — nwritten scratch (i32 LE)
    const STDOUT_WAT: &str = r#"
        (module
            (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
            (import "wasi_snapshot_preview1" "proc_exit"
                (func $proc_exit (param i32)))
            (memory 1)
            (export "memory" (memory 0))
            (data (i32.const 0) "hello")
            (func $_start
                ;; iovec at offset 8: buf=0, len=5
                (i32.store (i32.const 8)  (i32.const 0))
                (i32.store (i32.const 12) (i32.const 5))
                ;; fd_write(fd=1, iovs=8, iovs_len=1, nwritten=16)
                (drop (call $fd_write (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 16)))
                (call $proc_exit (i32.const 0))
            )
            (export "_start" (func $_start))
        )
    "#;

    #[tokio::test]
    async fn test_stdout_capture() {
        let engine = test_engine();
        let module = Module::new(&engine, STDOUT_WAT).expect("compile stdout wat");
        let def = simple_definition("stdout_tool");

        let result = executor::run(&engine, &module, &def, "{}", 256, PathBuf::from(".")).await;
        let output = match result {
            Ok(s) => s,
            Err(e) if is_wasi_exit_0(&e) => {
                panic!("got wasi_exit_0 error instead of captured stdout: {:?}", e)
            }
            Err(e) => panic!("unexpected error: {:?}", e),
        };
        assert_eq!(output, "hello", "stdout not captured correctly");
    }

    #[test]
    fn test_validate_args_invalid_json() {
        let def = make_def_with_args(vec![]);
        let err = def.validate_args("not json").unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn test_validate_args_non_object_json() {
        let def = make_def_with_args(vec![]);
        let err = def.validate_args(r#"["a", "b"]"#).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    /// A minimal WASI command module that does nothing (exits successfully).
    const NOOP_WAT: &str = r#"
        (module
            (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
            (memory 1)
            (export "memory" (memory 0))
            (func $_start
                i32.const 0
                call $proc_exit
            )
            (export "_start" (func $_start))
        )
    "#;

    #[tokio::test]
    async fn test_noop_wasi_command() {
        let engine = test_engine();
        let module = Module::new(&engine, NOOP_WAT).expect("compile noop");
        let def = simple_definition("noop");

        // proc_exit(0) inside Wasm raises a Trap — we normalise exit-code-0 to Ok.
        let result = executor::run(&engine, &module, &def, "{}", 256, PathBuf::from(".")).await;
        match &result {
            Ok(_) => {} // clean exit
            Err(e) if is_wasi_exit_0(e) => {} // proc_exit(0) — treated as success
            other => panic!("noop tool unexpected result: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_fuel_limit_enforced() {
        // An infinite loop module to verify fuel cuts it off.
        let wat = r#"
            (module
                (memory 1)
                (export "memory" (memory 0))
                (func $_start
                    (loop $infinite
                        br $infinite
                    )
                )
                (export "_start" (func $_start))
            )
        "#;
        let engine = test_engine();
        let module = Module::new(&engine, wat).expect("compile infinite");
        let mut def = simple_definition("infinite");
        def.timeout_secs = 2; // also bounded by timeout

        let result = executor::run(&engine, &module, &def, "{}", 256, PathBuf::from(".")).await;
        // Should fail — either fuel exhausted or timeout.
        assert!(
            result.is_err(),
            "Infinite loop should be rejected by fuel/timeout"
        );
    }

    #[tokio::test]
    async fn test_timeout_enforced() {
        let engine = test_engine();
        let module = Module::new(&engine, NOOP_WAT).expect("compile noop");
        let mut def = simple_definition("noop_timeout");
        def.timeout_secs = 5; // plenty for noop

        let result = executor::run(&engine, &module, &def, "{}", 256, PathBuf::from(".")).await;
        match &result {
            Ok(_) => {}
            Err(e) if is_wasi_exit_0(e) => {} // proc_exit(0) — treated as success
            other => panic!("noop_timeout unexpected result: {:?}", other),
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Stdin piping test
    // ──────────────────────────────────────────────────────────────────────────

    /// WAT module that reads 1 byte from stdin (fd 0) via `fd_read` and echoes
    /// it back to stdout (fd 1) via `fd_write`, then exits cleanly.
    ///
    /// Memory layout:
    ///   0      — byte buffer for fd_read / fd_write
    ///   4..8   — iovec.buf_ptr  = 0  (i32 LE)
    ///   8..12  — iovec.buf_len  = 1  (i32 LE)
    ///   12..16 — nread / nwritten scratch
    const ECHO_STDIN_WAT: &str = r#"
        (module
            (import "wasi_snapshot_preview1" "fd_read"
                (func $fd_read  (param i32 i32 i32 i32) (result i32)))
            (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
            (import "wasi_snapshot_preview1" "proc_exit"
                (func $proc_exit (param i32)))
            (memory 1)
            (export "memory" (memory 0))
            (func $_start
                ;; iovec at offset 4: buf=0, len=1
                (i32.store (i32.const 4) (i32.const 0))
                (i32.store (i32.const 8) (i32.const 1))
                ;; fd_read(fd=0, iovs=4, iovs_len=1, nread=12)
                (drop (call $fd_read  (i32.const 0) (i32.const 4) (i32.const 1) (i32.const 12)))
                ;; fd_write(fd=1, iovs=4, iovs_len=1, nwritten=12)
                (drop (call $fd_write (i32.const 1) (i32.const 4) (i32.const 1) (i32.const 12)))
                (call $proc_exit (i32.const 0))
            )
            (export "_start" (func $_start))
        )
    "#;

    #[tokio::test]
    async fn test_stdin_piped_to_wasm() {
        let engine = test_engine();
        let module = Module::new(&engine, ECHO_STDIN_WAT).expect("compile echo stdin wat");
        let def = simple_definition("echo_stdin");

        // The executor pipes args_json ("{") as stdin; the module echoes the first byte.
        let result = executor::run(&engine, &module, &def, "{", 256, PathBuf::from(".")).await;
        let output = match result {
            Ok(s) => s,
            Err(ref e) if is_wasi_exit_0(e) => panic!("got exit-0 error, expected Ok: {e:?}"),
            Err(e) => panic!("unexpected error: {e:?}"),
        };
        assert_eq!(output, "{", "first stdin byte not echoed to stdout");
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Native executor unit tests
    // ──────────────────────────────────────────────────────────────────────────

    fn native_def(binary: &str, args: Vec<ArgDef>) -> ToolDefinition {
        ToolDefinition {
            name: binary.to_string(),
            version: "0.1.0".into(),
            description: "test".into(),
            backend: ToolBackend::Native,
            wasm: None,
            binary: Some(binary.to_string()),
            command_args: vec![],
            timeout_secs: 5,
            permissions: ToolPermissions::default(),
            args,
            docs: String::new(),
        }
    }

    fn positional_arg(name: &str) -> ArgDef {
        ArgDef {
            name: name.into(),
            ty: "string".into(),
            required: false,
            description: String::new(),
            default: None,
            positional: true,
        }
    }

    #[tokio::test]
    async fn test_native_echo() {
        let def = native_def("echo", vec![positional_arg("text")]);
        let args = serde_json::json!({"text": "hello"});
        let allowed = HashSet::from(["echo".to_string()]);

        let result = native_executor::run(&def, &args, &allowed, Path::new("."), 65536)
            .await
            .expect("echo should succeed");

        let v: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(
            v["stdout"].as_str().unwrap().contains("hello"),
            "expected 'hello' in stdout, got: {result}"
        );
        assert_eq!(v["exit_code"], serde_json::json!(0));
    }

    #[tokio::test]
    async fn test_native_binary_not_in_allowlist() {
        let def = native_def("echo", vec![]);
        let empty: HashSet<String> = HashSet::new();

        let err = native_executor::run(&def, &serde_json::json!({}), &empty, Path::new("."), 65536)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::PermissionDenied(_)),
            "expected PermissionDenied, got: {err:?}"
        );
    }

    #[tokio::test]
    async fn test_native_timeout() {
        let mut def = native_def("sleep", vec![positional_arg("duration")]);
        def.timeout_secs = 1;
        let args = serde_json::json!({"duration": "60"});
        let allowed = HashSet::from(["sleep".to_string()]);

        let err = native_executor::run(&def, &args, &allowed, Path::new("."), 65536)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::Timeout { secs: 1 }),
            "expected Timeout after 1s, got: {err:?}"
        );
    }

    #[tokio::test]
    async fn test_native_output_truncation() {
        // `seq 1 1000` emits ~3.9 KiB; cap at 50 bytes to force truncation.
        let def = native_def("seq", vec![positional_arg("first"), positional_arg("last")]);
        let args = serde_json::json!({"first": "1", "last": "1000"});
        let allowed = HashSet::from(["seq".to_string()]);

        let result = native_executor::run(&def, &args, &allowed, Path::new("."), 50)
            .await
            .expect("seq should succeed");

        let v: serde_json::Value = serde_json::from_str(&result).unwrap();
        let stdout = v["stdout"].as_str().unwrap();
        assert!(
            stdout.ends_with("[truncated]"),
            "expected stdout to end with '[truncated]', got: {stdout:?}"
        );
    }

    #[tokio::test]
    async fn test_tool_not_found() {
        use std::sync::Arc;
        use crate::tool_registry::ToolRegistry;

        // Create an empty registry.
        let registry = ToolRegistry::load(
            &PathBuf::from("/tmp/nonexistent_tools_dir_abc123"),
            256,
            PathBuf::from("."),
            std::collections::HashSet::new(),
            65536,
        )
        .await
        .expect("load empty registry");
        let registry = Arc::new(registry);

        let err = registry.execute("does_not_exist", "{}").await;
        assert!(
            matches!(err, Err(ToolError::NotFound(_))),
            "Expected NotFound, got {:?}", err
        );
    }
}
