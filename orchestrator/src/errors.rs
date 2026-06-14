//! Unified error hierarchy for the Orchestrator.

use thiserror::Error;

/// Top-level error for the Orchestrator.
#[derive(Debug, Error)]
pub enum OrchestratorError {
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Session is already being processed")]
    SessionBusy,

    #[error("Cognition Engine error: {0}")]
    CognitionEngine(#[from] CognitionError),

    #[error("Tool error: {0}")]
    Tool(#[from] ToolError),

    #[error("Memory error: {0}")]
    Memory(#[from] MemoryError),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("Agent loop exceeded max iterations ({0})")]
    MaxIterationsExceeded(u32),

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

/// Errors originating from the Cognition Engine gRPC client.
#[derive(Debug, Error)]
pub enum CognitionError {
    #[error("Connection failed: {0}")]
    Connection(#[from] tonic::transport::Error),

    #[error("RPC failed ({status}): {message}")]
    Rpc {
        status: tonic::Code,
        message: String,
    },

    #[error("Timeout")]
    Timeout,

    #[error("All retries exhausted")]
    RetriesExhausted,
}

impl From<tonic::Status> for CognitionError {
    fn from(s: tonic::Status) -> Self {
        Self::Rpc {
            status: s.code(),
            message: s.message().to_string(),
        }
    }
}

/// Errors from the Wasm tool sandbox.
#[derive(Debug, Error)]
pub enum ToolError {
    #[error("Tool not found: {0}")]
    NotFound(String),

    #[error("Tool definition parse error in {file}: {source}")]
    ParseError { file: String, source: anyhow::Error },

    #[error("Wasm compile error: {0}")]
    Compile(anyhow::Error),

    #[error("Wasm execution error: {0}")]
    Execution(anyhow::Error),

    #[error("Tool timed out after {secs}s")]
    Timeout { secs: u64 },

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Invalid arguments: {0}")]
    InvalidArgs(String),
}

/// Errors from the memory / Qdrant layer.
#[derive(Debug, Error)]
pub enum MemoryError {
    #[error("Qdrant error: {0}")]
    Qdrant(String),

    #[error("Embedding error: {0}")]
    Embedding(anyhow::Error),

    #[error("Collection not initialised for session: {0}")]
    CollectionNotReady(String),
}
