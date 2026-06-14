//! Background heartbeat task.
//!
//! Runs on a configurable interval and:
//!   1. Checks Cognition Engine liveness via gRPC health protocol.
//!   2. Checks Qdrant liveness via MemoryStore::health_check().
//!   3. Cleans up expired/idle sessions from the SessionStore.
//!   4. Updates the shared HealthState so GET /health reflects current reality.
//!   5. Publishes the aggregated status to the gRPC health reporter.

use std::sync::Arc;
use std::time::Duration;

use tonic_health::server::HealthReporter;
use tracing::{debug, warn};

use crate::{
    cognition_client::CognitionClient,
    config::AgentSettings,
    health::{HealthReport, HealthState, SubsystemStatus},
    memory::MemoryStore,
    session::SessionStore,
};

/// Spawn the heartbeat as a background Tokio task.
///
/// Returns the `JoinHandle` — callers may drop it (fire-and-forget).
pub fn spawn(
    cognition: Arc<CognitionClient>,
    memory: Option<Arc<MemoryStore>>,
    sessions: Arc<SessionStore>,
    health: Arc<HealthState>,
    reporter: HealthReporter,
    settings: AgentSettings,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run(cognition, memory, sessions, health, reporter, settings))
}

async fn run(
    cognition: Arc<CognitionClient>,
    memory: Option<Arc<MemoryStore>>,
    sessions: Arc<SessionStore>,
    health: Arc<HealthState>,
    mut reporter: HealthReporter,
    settings: AgentSettings,
) {
    let interval = Duration::from_secs(settings.heartbeat_interval_secs);
    let idle_timeout = settings.session_idle_timeout_secs;

    loop {
        tokio::time::sleep(interval).await;

        // --- Check Cognition Engine ---
        let ce_status = match cognition.health_check().await {
            Ok(()) => SubsystemStatus::Ok,
            Err(e) => {
                warn!(error = %e, "Cognition Engine health check failed");
                SubsystemStatus::Down
            }
        };

        // --- Check Qdrant ---
        let qdrant_status = match &memory {
            Some(store) => match store.health_check().await {
                Ok(()) => SubsystemStatus::Ok,
                Err(e) => {
                    warn!(error = %e, "Qdrant health check failed");
                    SubsystemStatus::Down
                }
            },
            None => SubsystemStatus::Down,
        };

        // --- Session cleanup ---
        let cleaned = sessions.cleanup_expired(idle_timeout).await;
        if cleaned > 0 {
            debug!(count = cleaned, "Expired sessions removed");
        }
        let active_sessions = sessions.len().await;

        // --- Aggregate overall status ---
        let overall = if ce_status == SubsystemStatus::Down {
            SubsystemStatus::Down
        } else if qdrant_status == SubsystemStatus::Down {
            SubsystemStatus::Degraded
        } else {
            SubsystemStatus::Ok
        };

        // --- Update shared health state (GET /health) ---
        health
            .update(HealthReport {
                status: overall,
                cognition_engine: ce_status,
                qdrant: qdrant_status,
                active_sessions,
            })
            .await;

        // --- Update gRPC health reporter ---
        match overall {
            SubsystemStatus::Ok | SubsystemStatus::Degraded => {
                reporter
                    .set_serving::<tonic_health::pb::health_server::HealthServer<()>>()
                    .await;
            }
            SubsystemStatus::Down => {
                reporter
                    .set_not_serving::<tonic_health::pb::health_server::HealthServer<()>>()
                    .await;
            }
        }

        debug!(
            ce = ?ce_status,
            qdrant = ?qdrant_status,
            active_sessions,
            "Heartbeat complete"
        );
    }
}
