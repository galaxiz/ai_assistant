//! Axum router — wires all routes together.

use std::sync::Arc;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use tower_http::trace::TraceLayer;

use crate::{
    cognition_client::CognitionClient,
    config::Settings,
    health::{health_handler, HealthState},
    memory::MemoryStore,
    session::SessionStore,
    tool_registry::ToolRegistry,
};
use super::{
    middleware::{auth_middleware, AuthConfig},
    rate_limit::SessionRateLimiter,
    webhook::{webhook_handler, WebhookState},
    ws::{ws_handler, WsState},
};

/// Build the application router.
pub fn build_router(
    sessions: Arc<SessionStore>,
    cognition: Arc<CognitionClient>,
    tools: Arc<ToolRegistry>,
    memory: Option<Arc<MemoryStore>>,
    health: Arc<HealthState>,
    settings: Settings,
) -> Router {
    let settings = Arc::new(settings);
    let rate_limiter = Arc::new(SessionRateLimiter::new(settings.agent.rate_limit_rpm));
    let auth_config = AuthConfig(settings.auth.clone());

    let ws_state = WsState {
        sessions: Arc::clone(&sessions),
        cognition: Arc::clone(&cognition),
        tools: Arc::clone(&tools),
        memory: memory.clone(),
        rate_limiter: Arc::clone(&rate_limiter),
        settings: Arc::clone(&settings),
    };

    let webhook_state = WebhookState {
        sessions: Arc::clone(&sessions),
        cognition: Arc::clone(&cognition),
        tools: Arc::clone(&tools),
        memory,
        rate_limiter,
        settings: Arc::clone(&settings),
    };

    // Auth middleware applies to /ws and /webhook but not /health (health is public).
    let protected = Router::new()
        .route("/ws", get(ws_handler).with_state(ws_state))
        .route("/webhook", post(webhook_handler).with_state(webhook_state))
        .route_layer(middleware::from_fn_with_state(auth_config, auth_middleware));

    Router::new()
        .merge(protected)
        .route("/health", get(health_handler).with_state(Arc::clone(&health)))
        .layer(TraceLayer::new_for_http())
}
