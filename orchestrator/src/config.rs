//! Runtime configuration loaded from environment variables and an optional `.env` file.
//!
//! Layout mirrors `CE_` prefix convention used by the Cognition Engine.
//! All Orchestrator vars use the `ORCH_` prefix.



use serde::{Deserialize, Serialize};

/// Top-level settings object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub cognition_engine: CognitionEngineSettings,
    pub qdrant: QdrantSettings,
    pub http: HttpSettings,
    pub tools: ToolSettings,
    pub agent: AgentSettings,
    pub telemetry: TelemetrySettings,
    pub auth: AuthSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CognitionEngineSettings {
    /// Full gRPC address, e.g. `http://cognition-engine:50051`
    pub address: String,
    /// Connection timeout in seconds.
    pub connect_timeout_secs: u64,
    /// Per-RPC timeout in seconds.
    pub request_timeout_secs: u64,
    /// Max retry attempts on transient failures.
    pub max_retries: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QdrantSettings {
    pub url: String,
    pub api_key: Option<String>,
    pub collection_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpSettings {
    pub host: String,
    pub port: u16,
    /// Port for the Orchestrator's own gRPC health service (grpc.health.v1).
    pub grpc_health_port: u16,
}

impl HttpSettings {
    pub fn listen_address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSettings {
    /// Directory to scan for `tool.md` files.
    pub tools_dir: std::path::PathBuf,
    /// Global default execution timeout in seconds.
    pub default_timeout_secs: u64,
    /// Maximum Wasm memory pages (64 KiB each).
    pub max_memory_pages: u64,
    /// Host directory exposed to Wasm tools as their filesystem root.
    /// Individual tools may override this with `[permissions] sandbox_root`.
    pub sandbox_root: std::path::PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSettings {
    /// Maximum number of tool-call iterations per request (prevents infinite loops).
    pub max_tool_iterations: u32,
    /// Maximum session idle time before cleanup (seconds).
    pub session_idle_timeout_secs: u64,
    /// Maximum number of tokens allowed in the conversation history before trimming.
    pub max_context_tokens: u32,
    /// Maximum requests per session per minute (0 = unlimited).
    pub rate_limit_rpm: u32,
    /// How often the heartbeat task runs (seconds).
    pub heartbeat_interval_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetrySettings {
    pub log_level: String,
    pub log_format: String,
    /// Optional OTLP collector endpoint, e.g. `http://localhost:4317`
    pub otlp_endpoint: Option<String>,
    pub service_name: String,
    /// Fraction of traces to sample (0.0 = none, 1.0 = all). Default: 1.0.
    pub sampling_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSettings {
    /// Static bearer token for inbound WebSocket / Webhook authentication.
    /// In production, replace with a proper JWT or mTLS strategy.
    pub token: Option<String>,
    /// Allowed tool names for authenticated callers.
    /// Empty list means all tools are permitted.
    pub allowed_tools: Vec<String>,
    /// Allowed model identifiers for authenticated callers.
    /// Empty list means all models are permitted.
    pub allowed_models: Vec<String>,
}

impl Settings {
    /// Load settings from environment variables with `ORCH_` prefix.
    /// Reads an optional `.env` file first.
    pub fn load() -> anyhow::Result<Self> {
        // Load .env file if present (ignore errors — it's optional).
        let _ = dotenvy::dotenv();

        let config = config::Config::builder()
            // Built-in defaults
            .set_default("cognition_engine.address", "http://localhost:50051")?
            .set_default("cognition_engine.connect_timeout_secs", 5)?
            .set_default("cognition_engine.request_timeout_secs", 60)?
            .set_default("cognition_engine.max_retries", 3)?
            .set_default("qdrant.url", "http://localhost:6334")?
            .set_default("qdrant.collection_prefix", "agent")?
            .set_default("http.host", "0.0.0.0")?
            .set_default("http.port", 8080)?
            .set_default("http.grpc_health_port", 8081)?
            .set_default("tools.tools_dir", "tools")?
            .set_default("tools.default_timeout_secs", 10)?
            .set_default("tools.max_memory_pages", 256)?
            .set_default("tools.sandbox_root", ".")?
            .set_default("agent.max_tool_iterations", 10)?
            .set_default("agent.session_idle_timeout_secs", 1800)?
            .set_default("agent.max_context_tokens", 8000)?
            .set_default("agent.rate_limit_rpm", 60)?
            .set_default("agent.heartbeat_interval_secs", 30)?
            .set_default("telemetry.log_level", "info")?
            .set_default("telemetry.log_format", "json")?
            .set_default("telemetry.service_name", "orchestrator")?
            .set_default("telemetry.sampling_rate", 1.0)?
            .set_default("auth.allowed_tools", Vec::<String>::new())?
            .set_default("auth.allowed_models", Vec::<String>::new())?
            // Override from environment (ORCH__COGNITION_ENGINE__ADDRESS etc.)
            .add_source(
                config::Environment::with_prefix("ORCH")
                    .prefix_separator("__")
                    .separator("__"),
            )
            .build()?;

        Ok(config.try_deserialize()?)
    }
}
