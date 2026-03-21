//! Tool registry — discovers and lazily loads `tool.md`-defined Wasm tools.
//!
//! At startup: scans `tools_dir/*.md`, parses only the TOML frontmatter,
//!             builds an in-memory registry of tool schemas.
//! On first invocation: compiles the Wasm binary, caches the `Module`.
//! On each invocation: creates a fresh `Store` for isolation.

pub mod definition;
pub mod executor;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::sync::RwLock;
use tracing::{info, warn};
use wasmtime::Engine;

use crate::errors::ToolError;
pub use definition::ToolDefinition;

/// In-memory entry combining the definition and the (lazily compiled) Module.
struct ToolEntry {
    definition: ToolDefinition,
    module: Option<wasmtime::Module>, // None until first call
}

/// Thread-safe registry of all available tools.
pub struct ToolRegistry {
    engine: Engine,
    entries: RwLock<HashMap<String, ToolEntry>>,
    max_memory_pages: u64,
    /// Global sandbox root used when a tool definition does not specify its own.
    sandbox_root: PathBuf,
}

impl ToolRegistry {
    /// Scan `dir` for `*.md` files, parse frontmatter, build registry.
    pub async fn load(dir: &Path, max_memory_pages: u64, sandbox_root: PathBuf) -> Result<Self, ToolError> {
        let engine_config = {
            let mut cfg = wasmtime::Config::new();
            // Enable fuel metering for instruction-count enforcement.
            cfg.consume_fuel(true);
            cfg
        };
        let engine = Engine::new(&engine_config)
            .map_err(|e| ToolError::Compile(e.into()))?;
        let mut entries = HashMap::new();

        if !dir.exists() {
            warn!(path = %dir.display(), "tools_dir does not exist — no tools registered");
            return Ok(Self {
                engine,
                entries: RwLock::new(entries),
                max_memory_pages,
                sandbox_root,
            });
        }

        let mut read_dir = tokio::fs::read_dir(dir)
            .await
            .map_err(|e| ToolError::ParseError {
                file: dir.display().to_string(),
                source: e.into(),
            })?;

        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            match definition::parse_tool_md(&path).await {
                Ok(def) => {
                    info!(tool = %def.name, wasm = %def.wasm.display(), "Registered tool");
                    entries.insert(def.name.clone(), ToolEntry { definition: def, module: None });
                }
                Err(e) => {
                    warn!(file = %path.display(), error = %e, "Skipping invalid tool.md");
                }
            }
        }

        Ok(Self {
            engine,
            entries: RwLock::new(entries),
            max_memory_pages,
            sandbox_root,
        })
    }

    /// List all registered tool names and their schemas (for system prompt injection).
    pub async fn list_schemas(&self) -> Vec<ToolDefinition> {
        let entries = self.entries.read().await;
        entries.values().map(|e| e.definition.clone()).collect()
    }

    /// Get a tool definition by name.
    pub async fn get_definition(&self, name: &str) -> Option<ToolDefinition> {
        let entries = self.entries.read().await;
        entries.get(name).map(|e| e.definition.clone())
    }

    /// Execute a tool by name with JSON-encoded arguments.
    ///
    /// If this is the first invocation, the Wasm module is compiled and cached.
    pub async fn execute(
        self: &Arc<Self>,
        tool_name: &str,
        args_json: &str,
    ) -> Result<String, ToolError> {
        // Ensure the tool exists and get its definition.
        let definition = {
            let entries = self.entries.read().await;
            entries
                .get(tool_name)
                .map(|e| e.definition.clone())
                .ok_or_else(|| ToolError::NotFound(tool_name.to_string()))?
        };

        // Validate and normalise arguments before touching Wasm.
        let args_json = definition.validate_args(args_json)?.to_string();
        let args_json = args_json.as_str();

        // Lazy-compile the Wasm module if not yet cached.
        {
            let mut entries = self.entries.write().await;
            let entry = entries
                .get_mut(tool_name)
                .ok_or_else(|| ToolError::NotFound(tool_name.to_string()))?;

            if entry.module.is_none() {
                info!(tool = %tool_name, wasm = %definition.wasm.display(), "Compiling Wasm module (first use)");
                let wasm_bytes =
                    tokio::fs::read(&definition.wasm).await.map_err(|e| ToolError::Compile(e.into()))?;
                let module = wasmtime::Module::new(&self.engine, &wasm_bytes)
                    .map_err(|e| ToolError::Compile(e.into()))?;
                entry.module = Some(module);
                info!(tool = %tool_name, "Wasm module compiled and cached");
            }
        }

        // Extract the cached module (clone is cheap — Arc-backed).
        let module = {
            let entries = self.entries.read().await;
            entries[tool_name].module.clone().unwrap()
        };

        // Resolve sandbox root: per-tool override wins, else global default.
        let sandbox_root = definition.permissions.sandbox_root
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.sandbox_root.clone());

        executor::run(
            &self.engine,
            &module,
            &definition,
            args_json,
            self.max_memory_pages,
            sandbox_root,
        )
        .await
    }
}
