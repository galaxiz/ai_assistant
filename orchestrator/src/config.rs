//! Runtime configuration loaded from environment variables and an optional `.env` file.
//!
//! Layout mirrors `CE_` prefix convention used by the Cognition Engine.
//! All Orchestrator vars use the `ORCH_` prefix.



use serde::{Deserialize, Deserializer, Serialize};

/// Deserialise a `Vec<String>` from either a TOML/JSON sequence **or** a
/// comma-separated string (the form Docker / shell env vars provide).
///
/// Examples that both succeed:
///   - `ORCH__TOOLS__ALLOWED_BINARIES=git,curl,jq`  → `["git", "curl", "jq"]`
///   - `allowed_binaries = ["git", "curl"]`          → `["git", "curl"]`
fn deserialize_comma_separated_vec<'de, D>(de: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::{SeqAccess, Visitor};
    use std::fmt;

    struct CommaSepOrSeq;

    impl<'de> Visitor<'de> for CommaSepOrSeq {
        type Value = Vec<String>;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a sequence or a comma-separated string")
        }

        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Vec<String>, E> {
            Ok(v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect())
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<String>, A::Error> {
            let mut out = Vec::new();
            while let Some(s) = seq.next_element()? {
                out.push(s);
            }
            Ok(out)
        }
    }

    de.deserialize_any(CommaSepOrSeq)
}

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
    /// Binaries that native tools are allowed to invoke.
    /// If empty, all native tools are rejected (fail-closed).
    /// Override: `ORCH__TOOLS__ALLOWED_BINARIES="git,curl,jq"`
    #[serde(default, deserialize_with = "deserialize_comma_separated_vec")]
    pub allowed_binaries: Vec<String>,
    /// Maximum bytes captured from native tool stdout+stderr combined.
    pub max_output_bytes: usize,
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
    #[serde(default, deserialize_with = "deserialize_comma_separated_vec")]
    pub allowed_tools: Vec<String>,
    /// Allowed model identifiers for authenticated callers.
    /// Empty list means all models are permitted.
    #[serde(default, deserialize_with = "deserialize_comma_separated_vec")]
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
            .set_default("tools.allowed_binaries", Vec::<String>::new())?
            .set_default("tools.max_output_bytes", 65536)?
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
