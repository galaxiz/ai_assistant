//! Wasm tool executor.
//!
//! Each invocation gets a fresh `wasmtime::Store` for isolation.
//! The compiled `Module` is reused from the registry cache.
//!
//! The Wasm module interface convention (MVP):
//!   - Export: `fn run(args_ptr: i32, args_len: i32) -> i32`
//!     Returns a pointer to a length-prefixed UTF-8 string in Wasm memory.
//!
//! This is a simple, transport-agnostic ABI. More ergonomic bindings
//! (e.g., wit-bindgen component model) can be adopted later.

use std::{path::PathBuf, time::Duration};

use tracing::instrument;
use wasmtime::{Engine, Linker, Module, Store};
use wasmtime_wasi::{
    pipe::{MemoryInputPipe, MemoryOutputPipe},
    WasiCtxBuilder,
};

use super::definition::ToolDefinition;
use crate::errors::ToolError;

/// Run a compiled Wasm module with the given JSON arguments.
///
/// The module receives `args_json` and must return a UTF-8 string result.
/// Execution is subject to the timeout in `definition.timeout_secs`.
#[instrument(skip(engine, module, definition), fields(tool = %definition.name))]
pub async fn run(
    engine: &Engine,
    module: &Module,
    definition: &ToolDefinition,
    args_json: &str,
    max_memory_pages: u64,
    sandbox_root: PathBuf,
) -> Result<String, ToolError> {
    let timeout = Duration::from_secs(definition.timeout_secs);
    let args_owned = args_json.to_string();
    let engine = engine.clone();
    let module = module.clone();
    let def = definition.clone();

    let result = tokio::time::timeout(
        timeout,
        tokio::task::spawn_blocking(move || {
            execute_sync(
                &engine,
                &module,
                &def,
                &args_owned,
                max_memory_pages,
                &sandbox_root,
            )
        }),
    )
    .await
    .map_err(|_| ToolError::Timeout {
        secs: definition.timeout_secs,
    })?
    .map_err(|e| ToolError::Execution(e.into()))??;

    Ok(result)
}

fn execute_sync(
    engine: &Engine,
    module: &Module,
    definition: &ToolDefinition,
    args_json: &str,
    max_memory_pages: u64,
    sandbox_root: &std::path::Path,
) -> Result<String, ToolError> {
    // Build WASI context respecting the tool's permission set.
    // Stdout is captured via a MemoryOutputPipe so _start tools can return output.
    // 4 MiB is generous for tool output; oversized writes will surface as an error.
    let stdout_pipe = MemoryOutputPipe::new(4 * 1024 * 1024);
    let stdin_pipe = MemoryInputPipe::new(args_json.as_bytes().to_vec());
    let mut builder = WasiCtxBuilder::new();
    builder
        .stdin(stdin_pipe)
        .stdout(stdout_pipe.clone())
        .inherit_stderr();

    if definition.permissions.fs_read && !definition.permissions.fs_write {
        // Read-only access to the configured sandbox directory.
        builder
            .preopened_dir(
                sandbox_root,
                ".",
                wasmtime_wasi::DirPerms::READ,
                wasmtime_wasi::FilePerms::READ,
            )
            .map_err(ToolError::Execution)?;
    } else if definition.permissions.fs_write {
        // Full read+write access to the configured sandbox directory.
        builder
            .preopened_dir(
                sandbox_root,
                ".",
                wasmtime_wasi::DirPerms::all(),
                wasmtime_wasi::FilePerms::all(),
            )
            .map_err(ToolError::Execution)?;
    }
    // network permission: WASI preview1 does not expose sockets by default;
    // leaving it unenforced here (the ABI simply won't resolve socket calls).

    let wasi_ctx = builder.build_p1();

    // --- Resource limits ---
    let limits = wasmtime::StoreLimitsBuilder::new()
        .memories(max_memory_pages as usize)
        .build();

    let mut store2 = Store::new(
        engine,
        LimitedData {
            wasi: wasi_ctx,
            limits,
        },
    );
    // Fuel: 1 unit ≈ 1 Wasm instruction. 500M allows ~seconds of CPU work.
    store2.set_fuel(500_000_000).map_err(ToolError::Execution)?;
    store2.limiter(|data| &mut data.limits);

    let mut linker: Linker<LimitedData> = Linker::new(engine);
    wasmtime_wasi::preview1::add_to_linker_sync(&mut linker, |d| &mut d.wasi)
        .map_err(ToolError::Execution)?;

    let instance = linker
        .instantiate(&mut store2, module)
        .map_err(ToolError::Execution)?;

    // Invoke the `run` export if it exists, otherwise fall back to `_start` (WASI command).
    if let Ok(run_fn) = instance.get_typed_func::<(i32, i32), i32>(&mut store2, "run") {
        // Write args into Wasm memory.
        let memory = instance.get_memory(&mut store2, "memory").ok_or_else(|| {
            ToolError::Execution(anyhow::anyhow!("Wasm module has no `memory` export"))
        })?;

        let args_bytes = args_json.as_bytes();
        let args_len = args_bytes.len() as i32;

        // Allocate in Wasm memory via `alloc` export if available, else use offset 0 (simple modules).
        let args_ptr = if let Ok(alloc) = instance.get_typed_func::<i32, i32>(&mut store2, "alloc")
        {
            alloc
                .call(&mut store2, args_len)
                .map_err(ToolError::Execution)?
        } else {
            0i32
        };

        memory
            .write(&mut store2, args_ptr as usize, args_bytes)
            .map_err(|e| ToolError::Execution(e.into()))?;

        let result_ptr = run_fn
            .call(&mut store2, (args_ptr, args_len))
            .map_err(ToolError::Execution)?;

        // Read result: first 4 bytes are length (little-endian u32), then UTF-8.
        let mut len_bytes = [0u8; 4];
        memory
            .read(&mut store2, result_ptr as usize, &mut len_bytes)
            .map_err(|e| ToolError::Execution(e.into()))?;
        let result_len = u32::from_le_bytes(len_bytes) as usize;

        let mut result_bytes = vec![0u8; result_len];
        memory
            .read(&mut store2, result_ptr as usize + 4, &mut result_bytes)
            .map_err(|e| ToolError::Execution(e.into()))?;

        String::from_utf8(result_bytes).map_err(|e| ToolError::Execution(e.into()))
    } else {
        // WASI command — run `_start` and capture whatever it wrote to stdout.
        // This supports standard CLI-style tools compiled to WASI.
        if let Ok(start) = instance.get_typed_func::<(), ()>(&mut store2, "_start") {
            // proc_exit(0) manifests as an anyhow Trap; treat exit-code-0 as a clean exit.
            if let Err(e) = start.call(&mut store2, ()) {
                let is_clean_exit = e.chain().any(|cause| {
                    let msg = cause.to_string();
                    msg.contains("exit status 0") || msg.contains("i32 exit status 0")
                });
                if !is_clean_exit {
                    return Err(ToolError::Execution(e));
                }
            }
        }
        // Read captured stdout; fall back to empty JSON object if nothing written.
        let bytes = stdout_pipe.contents();
        if bytes.is_empty() {
            Ok("{}".to_string())
        } else {
            String::from_utf8(bytes.to_vec()).map_err(|e| {
                ToolError::Execution(anyhow::anyhow!("tool stdout is not valid UTF-8: {e}"))
            })
        }
    }
}

/// Combines the WASI preview-1 context with a `StoreLimits` so both can
/// live in the same `Store<T>` slot.
struct LimitedData {
    wasi: wasmtime_wasi::preview1::WasiP1Ctx,
    limits: wasmtime::StoreLimits,
}
