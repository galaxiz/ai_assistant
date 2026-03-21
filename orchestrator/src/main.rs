//! Entry point. Loads config, wires dependencies, starts the Axum server.

use std::sync::Arc;

use orchestrator::{
    api::router::build_router,
    cognition_client::CognitionClient,
    config::Settings,
    health::{start_grpc_health_server, HealthState},
    heartbeat,
    memory::{embedding, MemoryStore},
    session::SessionStore,
    telemetry,
    tool_registry::ToolRegistry,
};
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // --- Load config ---
    let settings = Settings::load()?;

    // --- Telemetry (logs + traces) ---
    telemetry::init(&settings)?;

    info!(
        version = env!("CARGO_PKG_VERSION"),
        grpc_address = %settings.cognition_engine.address,
        http_address = %settings.http.listen_address(),
        grpc_health_port = settings.http.grpc_health_port,
        "Orchestrator starting"
    );

    // --- Dependency wiring ---
    let session_store = Arc::new(SessionStore::new());
    let cognition_client = Arc::new(CognitionClient::connect(&settings.cognition_engine).await?);
    let tool_registry = Arc::new(
        ToolRegistry::load(&settings.tools.tools_dir, settings.tools.max_memory_pages, settings.tools.sandbox_root.clone()).await?,
    );
    let health = Arc::new(HealthState::new());

    // --- Memory / Qdrant (P5) ---
    let memory_store: Option<Arc<MemoryStore>> = init_memory(&settings).await;

    // --- gRPC health service (P7) ---
    let grpc_health_addr: std::net::SocketAddr =
        format!("0.0.0.0:{}", settings.http.grpc_health_port).parse()?;
    let health_reporter = start_grpc_health_server(grpc_health_addr);
    info!(addr = %grpc_health_addr, "gRPC health server listening");

    // --- Background heartbeat (P7) ---
    heartbeat::spawn(
        Arc::clone(&cognition_client),
        memory_store.clone(),
        Arc::clone(&session_store),
        Arc::clone(&health),
        health_reporter,
        settings.agent.clone(),
    );

    // --- HTTP/WS server ---
    let app = build_router(
        Arc::clone(&session_store),
        Arc::clone(&cognition_client),
        Arc::clone(&tool_registry),
        memory_store,
        Arc::clone(&health),
        settings.clone(),
    );

    let listener = tokio::net::TcpListener::bind(settings.http.listen_address()).await?;
    info!(address = %settings.http.listen_address(), "Listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Orchestrator stopped");
    Ok(())
}

/// Attempt to initialise the embedding engine and connect to Qdrant.
async fn init_memory(settings: &Settings) -> Option<Arc<MemoryStore>> {
    if let Err(e) = embedding::init() {
        warn!(error = %e, "BGE embedding engine init failed — semantic memory disabled");
        return None;
    }
    match MemoryStore::connect(&settings.qdrant).await {
        Ok(store) => {
            info!(url = %settings.qdrant.url, "Memory store connected");
            Some(Arc::new(store))
        }
        Err(e) => {
            warn!(error = %e, url = %settings.qdrant.url, "Qdrant unavailable — semantic memory disabled");
            None
        }
    }
}

async fn shutdown_signal() {
    use tokio::signal;
    let ctrl_c = async { signal::ctrl_c().await.expect("failed to install Ctrl+C handler") };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("Shutdown signal received");
}
