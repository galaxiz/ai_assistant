//! Tool-call wire protocol — JSON-in-fence format.
//!
//! The LLM emits:
//! ```tool_call
//! { "tool": "name", "call_id": "c1", "args": { ... } }
//! ```
//!
//! The Orchestrator injects back:
//! ```tool_result
//! { "call_id": "c1", "status": "ok", "output": "..." }
//! ```

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Regex to extract a ```tool_call ... ``` block from LLM output.
static TOOL_CALL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"```tool_call\s*\n([\s\S]*?)\n```").expect("invalid tool_call regex"));

/// A parsed tool invocation from the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool: String,
    pub call_id: String,
    #[serde(default)]
    pub args: Value,
}

impl ToolCall {
    /// Serialize the args object back to a JSON string for the executor.
    pub fn args_json(&self) -> String {
        self.args.to_string()
    }
}

/// Scan `text` for a `tool_call` fence block. Returns the first match.
pub fn extract_tool_call(text: &str) -> Option<ToolCall> {
    let caps = TOOL_CALL_RE.captures(text)?;
    let json_str = caps.get(1)?.as_str();
    serde_json::from_str(json_str).ok()
}

/// Format a `tool_result` block to inject into the conversation.
pub fn format_tool_result(call_id: &str, status: &str, output: &str) -> String {
    let payload = serde_json::json!({
        "call_id": call_id,
        "status": status,
        "output": output,
    });
    format!(
        "```tool_result\n{}\n```",
        serde_json::to_string_pretty(&payload).unwrap()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const LLM_OUTPUT: &str = r#"Some reasoning...

```tool_call
{"tool": "read_file", "call_id": "c1", "args": {"path": "/tmp/test.txt"}}
```

More text."#;

    #[test]
    fn extract_tool_call_success() {
        let call = extract_tool_call(LLM_OUTPUT).unwrap();
        assert_eq!(call.tool, "read_file");
        assert_eq!(call.call_id, "c1");
        assert_eq!(call.args["path"], "/tmp/test.txt");
    }

    #[test]
    fn extract_tool_call_none_when_absent() {
        assert!(extract_tool_call("No tool here, just prose.").is_none());
    }

    #[test]
    fn format_tool_result_structure() {
        let result = format_tool_result("c1", "ok", "Hello!");
        assert!(result.contains("tool_result"));
        assert!(result.contains("c1"));
        assert!(result.contains("Hello!"));
    }
}
