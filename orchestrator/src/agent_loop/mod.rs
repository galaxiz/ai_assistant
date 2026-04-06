//! Agent loop — the core reasoning cycle.
//!
//! Flow:
//!   1. Receive user message → append to session history
//!   2. Count tokens → trim old messages if over budget
//!   3. Call Complete on Cognition Engine
//!   4. Scan response for ```tool_call``` blocks
//!   5. If found → execute tool → inject ```tool_result``` → repeat (up to max_iterations)
//!   6. If no tool call → return final response

pub mod protocol;

use std::sync::Arc;

use tracing::{debug, info, instrument, warn};

use opentelemetry::KeyValue;

use crate::{
    access_control::AccessPolicy,
    cognition_client::{proto::Message, CognitionClient},
    config::AgentSettings,
    errors::OrchestratorError,
    memory::MemoryStore,
    session::{Session, SessionState},
    telemetry,
    tool_registry::ToolRegistry,
};
use protocol::{extract_tool_call, format_tool_result};

/// Internal request types for agent workflow dispatch.
#[derive(Debug, Clone)]
pub enum AgentRequest {
    Message(String),
}

/// Internal response types from the agent workflow.
#[derive(Debug, Clone)]
pub enum AgentResponse {
    Message(String),
}

/// Run the agent loop for one user turn.
///
/// `session` must be already locked by the caller.
/// `auth_token` is forwarded in every `RequestContext` sent to the Cognition Engine.
/// `policy` enforces which tools and models this caller may use.
/// `memory` — if provided, the full conversation is persisted to Qdrant after the turn.
#[instrument(skip(session, cognition, tools, settings, policy, memory), fields(session_id = %session.session_id))]
pub async fn run_turn(
    session: &mut Session,
    request: AgentRequest,
    cognition: &Arc<CognitionClient>,
    tools: &Arc<ToolRegistry>,
    settings: &AgentSettings,
    auth_token: &str,
    policy: &AccessPolicy,
    memory: Option<&Arc<MemoryStore>>,
) -> Result<AgentResponse, OrchestratorError> {
    // --- 1. Append user message ---
    // Checkpoint history length so we can roll back if the turn fails,
    // preventing orphaned user messages that corrupt future turns.
    let history_checkpoint = session.conversation_history.len();
    match request {
        AgentRequest::Message(msg) => {
            session.push_message("user", &msg);
        }
    }
    session.state = SessionState::Processing;

    let sid = session.session_id.clone();

    // Inject system prompt with tool schemas on first turn.
    if session.conversation_history.len() == 1 {
        let system_prompt = build_system_prompt(tools, policy).await;
        // Prepend system message (insert before the user message).
        session.conversation_history.insert(
            0,
            Message { role: "system".into(), content: system_prompt },
        );
    }

    let mut final_response = String::new();

    for iteration in 0..=settings.max_tool_iterations {
        if iteration == settings.max_tool_iterations {
            session.state = SessionState::Error("max_iterations".into());
            session.conversation_history.truncate(history_checkpoint);
            return Err(OrchestratorError::MaxIterationsExceeded(settings.max_tool_iterations));
        }
        info!(iteration, history_len = session.conversation_history.len(), "Agent loop iteration start");

        // --- 2. Token trimming ---
        loop {
            let count_res = cognition
                .count_tokens(&sid, auth_token, session.conversation_history.clone(), "placeholder-model")
                .await?;

            if count_res.token_count <= settings.max_context_tokens as i32 {
                break;
            }

            if session.conversation_history.len() > 2 {
                session.conversation_history.remove(1);
                debug!("Trimmed oldest conversation message to respect token limit");
            } else {
                warn!("Cannot trim further, but still over token limit");
                break;
            }
        }

        debug!(iteration, "Calling Cognition Engine");
        let response = match cognition
            .complete(&sid, auth_token, session.conversation_history.clone(), "", 0.0, 0)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                session.conversation_history.truncate(history_checkpoint);
                session.state = SessionState::Error(e.to_string());
                return Err(e.into());
            }
        };

        let content = response.content.clone();
        info!(
            iteration,
            model = %response.model_used,
            input_tokens = response.input_tokens,
            output_tokens = response.output_tokens,
            "Cognition Engine responded"
        );

        // --- 3. Detect tool call ---
        if let Some(tool_call) = extract_tool_call(&content) {
            info!(tool = %tool_call.tool, call_id = %tool_call.call_id, "Tool call detected");

            let m = telemetry::metrics();

            // Enforce access policy — deny if tool not permitted.
            if !policy.allows_tool(&tool_call.tool) {
                warn!(tool = %tool_call.tool, "Tool denied by access policy");
                m.tool_calls_total.add(1, &[
                    KeyValue::new("tool", tool_call.tool.clone()),
                    KeyValue::new("status", "denied"),
                ]);
                let denied_result = format_tool_result(
                    &tool_call.call_id,
                    "error",
                    &format!("Access denied: tool '{}' is not permitted for this session.", tool_call.tool),
                );
                session.push_message("assistant", &content);
                session.push_message("user", &denied_result);
                session.state = SessionState::Processing;
                continue;
            }

            // Append assistant message with the tool call.
            session.push_message("assistant", &content);
            session.state = SessionState::AwaitingToolResult;

            // --- 4. Execute tool ---
            let tool_start = std::time::Instant::now();
            let tool_result = match tools.execute(&tool_call.tool, &tool_call.args_json()).await {
                Ok(output) => {
                    info!(tool = %tool_call.tool, "Tool executed successfully");
                    m.tool_calls_total.add(1, &[
                        KeyValue::new("tool", tool_call.tool.clone()),
                        KeyValue::new("status", "ok"),
                    ]);
                    format_tool_result(&tool_call.call_id, "ok", &output)
                }
                Err(e) => {
                    warn!(tool = %tool_call.tool, error = %e, "Tool execution failed");
                    m.tool_calls_total.add(1, &[
                        KeyValue::new("tool", tool_call.tool.clone()),
                        KeyValue::new("status", "error"),
                    ]);
                    format_tool_result(&tool_call.call_id, "error", &e.to_string())
                }
            };
            m.tool_duration_ms.record(
                tool_start.elapsed().as_millis() as f64,
                &[KeyValue::new("tool", tool_call.tool.clone())],
            );

            session.push_message("user", &tool_result);
            session.state = SessionState::Processing;
        } else {
            // --- 5. Final response ---
            session.push_message("assistant", &content);
            session.state = SessionState::Idle;
            final_response = content;
            break;
        }
    }

    // Persist the updated conversation to long-term memory.
    if let Some(store) = memory {
        let messages = session.conversation_history.clone();
        let sid = session.session_id.clone();
        if let Err(e) = store.store_conversation(&sid, &messages).await {
            warn!(error = %e, "Failed to persist conversation to memory store");
        }
    }

    Ok(AgentResponse::Message(final_response))
}

/// Build a system prompt listing only the tools this caller is allowed to use.
async fn build_system_prompt(tools: &Arc<ToolRegistry>, policy: &AccessPolicy) -> String {
    let schemas = tools.list_schemas().await;
    // Filter to tools the policy permits.
    let visible: Vec<_> = schemas
        .into_iter()
        .filter(|t| policy.allows_tool(&t.name))
        .collect();

    let mut prompt = String::from(
        "You are a helpful AI assistant. You may invoke tools to help the user.\n\n\
         To call a tool, emit EXACTLY this format (a fenced code block with language `tool_call`):\n\n\
         ```tool_call\n\
         {\n  \"tool\": \"<tool_name>\",\n  \"call_id\": \"<unique_id>\",\n  \"args\": { ... }\n}\n\
         ```\n\n\
         After you emit a tool_call block, you will receive a `tool_result` block with the output.\n\
         Use the result to continue your reasoning before giving your final answer.\n\n",
    );

    if visible.is_empty() {
        prompt.push_str("No tools are currently available.\n");
    } else {
        prompt.push_str("## Available Tools\n\n");
        for tool in &visible {
            prompt.push_str(&format!("### `{}`\n{}\n\n**Arguments:**\n", tool.name, tool.description));
            for arg in &tool.args {
                let req = if arg.required { "required" } else { "optional" };
                prompt.push_str(&format!(
                    "- `{}` ({}): {} [{}]\n",
                    arg.name, arg.ty, arg.description, req
                ));
            }
            prompt.push('\n');
        }
    }

    prompt
}
