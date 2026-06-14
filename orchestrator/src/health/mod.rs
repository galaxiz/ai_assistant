//! Health state, GET /health handler, and gRPC health server.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use tokio::sync::RwLock;
use tonic_health::server::health_reporter;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SubsystemStatus {
    Ok,
    Degraded,
    Down,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthReport {
    pub status: SubsystemStatus,
    pub cognition_engine: SubsystemStatus,
    pub qdrant: SubsystemStatus,
    pub active_sessions: usize,
}

/// Shared health state, updated by the background heartbeat task.
pub struct HealthState {
    inner: RwLock<HealthReport>,
}

impl HealthState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HealthReport {
                status: SubsystemStatus::Ok,
                cognition_engine: SubsystemStatus::Ok,
                qdrant: SubsystemStatus::Ok,
                active_sessions: 0,
            }),
        }
    }

    pub async fn update(&self, report: HealthReport) {
        *self.inner.write().await = report;
    }

    pub async fn report(&self) -> HealthReport {
        self.inner.read().await.clone()
    }
}

impl Default for HealthState {
    fn default() -> Self {
        Self::new()
    }
}

/// Start the gRPC `grpc.health.v1` server on `addr`.
///
/// Returns a `HealthReporter` handle the heartbeat task uses to publish status.
pub fn start_grpc_health_server(
    addr: std::net::SocketAddr,
) -> tonic_health::server::HealthReporter {
    let (reporter, health_service) = health_reporter();

    tokio::spawn(async move {
        if let Err(e) = tonic::transport::Server::builder()
            .add_service(health_service)
            .serve(addr)
            .await
        {
            tracing::error!(error = %e, "gRPC health server error");
        }
    });

    reporter
}

/// `GET /health` handler.
pub async fn health_handler(State(health): State<Arc<HealthState>>) -> impl IntoResponse {
    let report = health.report().await;
    let code = if report.status == SubsystemStatus::Down {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (code, Json(report))
}
