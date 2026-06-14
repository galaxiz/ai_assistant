//! Shared request/response types for the HTTP/WS API.

use serde::{Deserialize, Serialize};

/// Inbound user message (WebSocket or Webhook).
#[derive(Debug, Clone, Deserialize)]
pub struct UserMessage {
    /// Optional — client may supply an existing session ID to resume.
    pub session_id: Option<String>,
    pub message: String,
    /// Optional model override (forwarded to Cognition Engine).
    pub model: Option<String>,
}

/// Outbound agent response.
#[derive(Debug, Clone, Serialize)]
pub struct AgentResponse {
    pub session_id: String,
    pub content: String,
    pub model_used: String,
    pub input_tokens: i32,
    pub output_tokens: i32,
}

/// Standard error envelope.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
    /// Included when a session was created before the error occurred,
    /// so the client can resume the same session on retry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl ErrorResponse {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error: message.into(),
            code: code.into(),
            session_id: None,
        }
    }

    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }
}
