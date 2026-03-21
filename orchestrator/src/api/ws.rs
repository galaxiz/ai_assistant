//! WebSocket handler — persistent bidirectional connection per user session.

use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Extension, State,
    },
    response::Response,
};
use futures::{SinkExt, StreamExt};
use tracing::info;

use opentelemetry::KeyValue;
use std::time::Instant;

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
use super::{
    rate_limit::SessionRateLimiter,
    types::{AgentResponse, ErrorResponse, UserMessage},
};

#[derive(Clone)]
pub struct WsState {
    pub sessions: Arc<SessionStore>,
    pub cognition: Arc<CognitionClient>,
    pub tools: Arc<ToolRegistry>,
    pub memory: Option<Arc<MemoryStore>>,
    pub rate_limiter: Arc<SessionRateLimiter>,
    pub settings: Arc<Settings>,
}

/// Upgrade handler — called when a client connects to `/ws`.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
    // `ValidatedUser` was inserted by the auth middleware.
    // If auth is disabled the middleware inserts an allow-all user.
    user: Option<Extension<ValidatedUser>>,
) -> Response {
    let user = user
        .map(|Extension(u)| u)
        .unwrap_or_else(|| ValidatedUser {
            token: String::new(),
            policy: AccessPolicy::allow_all(),
        });
    ws.on_upgrade(|socket| handle_socket(socket, state, user))
}

async fn handle_socket(socket: WebSocket, state: WsState, user: ValidatedUser) {
    let (mut sender, mut receiver) = socket.split();

    while let Some(msg) = receiver.next().await {
        let raw = match msg {
            Ok(WsMessage::Text(t)) => t,
            Ok(WsMessage::Close(_)) | Err(_) => break,
            _ => continue,
        };

        // Parse the inbound message.
        let user_msg: UserMessage = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(e) => {
                let err = serde_json::to_string(&ErrorResponse::new("parse_error", e.to_string()))
                    .unwrap_or_default();
                let _ = sender.send(WsMessage::Text(err.into())).await;
                continue;
            }
        };

        // Resolve or create session.
        let session_id = match &user_msg.session_id {
            Some(id) if state.sessions.get(id).await.is_some() => id.clone(),
            _ => state.sessions.create(Default::default()).await,
        };

        let start = Instant::now();
        let m = telemetry::metrics();
        m.requests_total.add(1, &[KeyValue::new("endpoint", "ws")]);

        // Enforce per-session rate limit.
        if !state.rate_limiter.check(&session_id) {
            let err = serde_json::to_string(&ErrorResponse::new(
                "rate_limited",
                "Too many requests — please slow down.",
            ))
            .unwrap_or_default();
            let _ = sender.send(WsMessage::Text(err.into())).await;
            continue;
        }

        info!(session_id = %session_id, "WebSocket message received");

        let arc = match state.sessions.get(&session_id).await {
            Some(a) => a,
            None => break,
        };

        let response = {
            let mut session = arc.lock().await;
            match agent_loop::run_turn(
                &mut session,
                agent_loop::AgentRequest::Message(user_msg.message.clone()),
                &state.cognition,
                &state.tools,
                &state.settings.agent,
                &user.token,
                &user.policy,
                state.memory.as_ref(),
            )
            .await
            {
                Ok(agent_loop::AgentResponse::Message(content)) => {
                    serde_json::to_string(&AgentResponse {
                        session_id: session_id.clone(),
                        content,
                        model_used: String::new(),
                        input_tokens: 0,
                        output_tokens: 0,
                    })
                    .unwrap_or_default()
                }
                Err(e) => serde_json::to_string(&ErrorResponse::new("agent_error", e.to_string()))
                    .unwrap_or_default(),
            }
        };

        m.request_duration_ms.record(
            start.elapsed().as_millis() as f64,
            &[KeyValue::new("endpoint", "ws")],
        );

        if sender.send(WsMessage::Text(response.into())).await.is_err() {
            break;
        }
    }
}
