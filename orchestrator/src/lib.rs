//! Orchestrator — Core daemon for the AI Agent system.
//!
//! Connects to:
//!   - Cognition Engine (gRPC)
//!   - Tool Execution Sandbox (Wasmtime, in-process)
//!   - Memory / Qdrant (TCP)
//!   - Messaging Adapters (WebSocket / Webhook, via Axum)

pub mod config;
pub mod errors;
pub mod access_control;
pub mod cognition_client;
pub mod session;
pub mod tool_registry;
pub mod memory;
pub mod agent_loop;
pub mod api;
pub mod health;
pub mod heartbeat;
pub mod telemetry;
