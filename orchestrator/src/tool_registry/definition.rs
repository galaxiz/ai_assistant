//! `tool.md` frontmatter parser.
//!
//! A tool definition file looks like:
//!
//! ```txt
//! ---
//! name = "read_file"
//! version = "1.0.0"
//! description = "Read the contents of a local file."
//! wasm = "tools/read_file.wasm"
//! timeout_secs = 10
//!
//! [permissions]
//! fs_read = true
//! fs_write = false
//! network = false
//!
//! [[args]]
//! name = "path"
//! type = "string"
//! required = true
//! description = "Absolute path of the file to read."
//! ---
//!
//! # read_file
//!
//! Human-readable documentation used in the system prompt...
//! ```

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::ToolError;

/// Permissions a tool may be granted.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolPermissions {
    #[serde(default)]
    pub fs_read: bool,
    #[serde(default)]
    pub fs_write: bool,
    #[serde(default)]
    pub network: bool,
    /// Override the global sandbox root for this specific tool.
    /// When set, the Wasm module is granted filesystem access relative to this
    /// directory instead of the global `ToolSettings::sandbox_root`.
    #[serde(default)]
    pub sandbox_root: Option<String>,
}

/// A single argument definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArgDef {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub description: String,
    pub default: Option<serde_json::Value>,
}

/// Parsed and validated tool definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub version: String,
    pub description: String,
    /// Path to the `.wasm` binary (relative to the tool.md file).
    pub wasm: PathBuf,
    /// Execution timeout in seconds.
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default)]
    pub permissions: ToolPermissions,
    #[serde(default, rename = "args")]
    pub args: Vec<ArgDef>,
    /// The human-readable markdown body (everything after the closing `---`).
    #[serde(skip)]
    pub docs: String,
}

fn default_timeout() -> u64 { 10 }

impl ToolDefinition {
    /// Validate and normalise `args_json` against this tool's argument definitions.
    ///
    /// - Required args must be present.
    /// - Arg types must match (`string`, `integer`, `boolean`, `object`).
    /// - Default values are injected for missing optional args that have one.
    ///
    /// Returns the normalised args object (with defaults applied) on success.
    pub fn validate_args(&self, args_json: &str) -> Result<Value, ToolError> {
        let mut args: Value = serde_json::from_str(args_json).map_err(|e| {
            ToolError::InvalidArgs(format!("args is not valid JSON: {e}"))
        })?;

        let obj = args.as_object_mut().ok_or_else(|| {
            ToolError::InvalidArgs("args must be a JSON object".to_string())
        })?;

        for arg in &self.args {
            match obj.get(&arg.name) {
                Some(v) => {
                    // Type-check the supplied value.
                    let type_ok = match arg.ty.as_str() {
                        "string"  => v.is_string(),
                        "integer" => v.is_number() && v.as_i64().is_some(),
                        "boolean" => v.is_boolean(),
                        "object"  => v.is_object(),
                        // Unknown types are passed through without checking.
                        _ => true,
                    };
                    if !type_ok {
                        return Err(ToolError::InvalidArgs(format!(
                            "arg `{}`: expected type `{}`, got `{}`",
                            arg.name,
                            arg.ty,
                            value_type_name(v),
                        )));
                    }
                }
                None if arg.required => {
                    return Err(ToolError::InvalidArgs(format!(
                        "required arg `{}` is missing",
                        arg.name
                    )));
                }
                None => {
                    // Optional — inject default if one is specified.
                    if let Some(default) = &arg.default {
                        obj.insert(arg.name.clone(), default.clone());
                    }
                }
            }
        }

        Ok(args)
    }
}

fn value_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null    => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_)  => "array",
        Value::Object(_) => "object",
    }
}

/// Parse a `tool.md` file: extract TOML frontmatter, then the markdown body.
pub async fn parse_tool_md(path: &Path) -> Result<ToolDefinition, ToolError> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| ToolError::ParseError {
            file: path.display().to_string(),
            source: e.into(),
        })?;

    let (frontmatter, docs) = split_frontmatter(&raw).ok_or_else(|| ToolError::ParseError {
        file: path.display().to_string(),
        source: anyhow::anyhow!("Missing or malformed `---` frontmatter delimiters"),
    })?;

    let mut def: ToolDefinition = toml::from_str(frontmatter).map_err(|e| ToolError::ParseError {
        file: path.display().to_string(),
        source: e.into(),
    })?;

    // Make the `wasm` path absolute relative to the tool.md directory.
    if def.wasm.is_relative() {
        let base = path.parent().unwrap_or(Path::new("."));
        def.wasm = base.join(&def.wasm);
    }

    def.docs = docs.to_string();
    Ok(def)
}

/// Split `---\n<toml>\n---\n<body>` into `(toml, body)`.
fn split_frontmatter(src: &str) -> Option<(&str, &str)> {
    let src = src.trim_start();
    let src = src.strip_prefix("---")?;
    // Find the closing `---`
    let (fm, rest) = src.split_once("\n---")?;
    // Skip the newline after the closing delimiter.
    let body = rest.trim_start_matches('\n');
    Some((fm.trim(), body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frontmatter() {
        let src = r#"---
name = "echo"
version = "0.1.0"
description = "Echo the input."
wasm = "echo.wasm"

[permissions]
fs_read = false

[[args]]
name = "text"
type = "string"
required = true
description = "Text to echo."
---

# echo

Echoes whatever you send it.
"#;
        let (fm, body) = split_frontmatter(src).unwrap();
        assert!(fm.contains("echo"));
        assert!(body.contains("Echoes"));

        let def: ToolDefinition = toml::from_str(fm).unwrap();
        assert_eq!(def.name, "echo");
        assert_eq!(def.args.len(), 1);
        assert_eq!(def.args[0].name, "text");
    }
}
