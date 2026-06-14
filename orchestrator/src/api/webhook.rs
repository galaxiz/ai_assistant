//! Webhook handler — stateless POST /webhook.

use std::sync::Arc;

use axum::{
    extract::{Extension, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use opentelemetry::KeyValue;
use std::time::Instant;

use super::{
    rate_limit::SessionRateLimiter,
    types::{AgentResponse, ErrorResponse, UserMessage},
};
use crate::{
    access_control::{AccessPolicy, ValidatedUser},
    agent_loop,
    cognition_client::CognitionClient,
    config::Settings,
    memory::MemoryStore,
    session::SessionStore,
    telemetry,
    tool_registry::ToolRegistry,
};

#[derive(Clone)]
pub struct WebhookState {
    pub sessions: Arc<SessionStore>,
    pub cognition: Arc<CognitionClient>,
    pub tools: Arc<ToolRegistry>,
    pub memory: Option<Arc<MemoryStore>>,
    pub rate_limiter: Arc<SessionRateLimiter>,
    pub settings: Arc<Settings>,
}

/// `POST /webhook` — synchronous request/response webhook.
#[axum::debug_handler]
pub async fn webhook_handler(
    State(state): State<WebhookState>,
    user: Option<Extension<ValidatedUser>>,
    Json(payload): Json<UserMessage>,
) -> impl IntoResponse {
    let start = Instant::now();
    let m = telemetry::metrics();
    m.requests_total
        .add(1, &[KeyValue::new("endpoint", "webhook")]);

    let user = user.map(|Extension(u)| u).unwrap_or_else(|| ValidatedUser {
        token: String::new(),
        policy: AccessPolicy::allow_all(),
    });

    // Resolve or create session.
    let session_id = match &payload.session_id {
        Some(id) if state.sessions.get(id).await.is_some() => id.clone(),
        _ => state.sessions.create(Default::default()).await,
    };

    // Enforce per-session rate limit.
    if !state.rate_limiter.check(&session_id) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!(ErrorResponse::new(
                "rate_limited",
                "Too many requests — please slow down."
            ))),
        );
    }

    let arc = match state.sessions.get(&session_id).await {
        Some(a) => a,
        None => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(ErrorResponse::new(
                    "session_error",
                    "Could not create session"
                ))),
            );
        }
    };

    let result = {
        let mut session = arc.lock().await;
        agent_loop::run_turn(
            &mut session,
            agent_loop::AgentRequest::Message(payload.message.clone()),
            &state.cognition,
            &state.tools,
            &state.settings.agent,
            &user.token,
            &user.policy,
            state.memory.as_ref(),
        )
        .await
    };

    let elapsed = start.elapsed().as_millis() as f64;
    m.request_duration_ms
        .record(elapsed, &[KeyValue::new("endpoint", "webhook")]);

    match result {
        Ok(agent_loop::AgentResponse::Message(content)) => (
            StatusCode::OK,
            Json(serde_json::json!(AgentResponse {
                session_id,
                content,
                model_used: String::new(),
                input_tokens: 0,
                output_tokens: 0,
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!(ErrorResponse::new(
                "agent_error",
                e.to_string()
            ))),
        ),
    }
}
