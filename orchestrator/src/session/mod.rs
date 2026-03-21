//! Session model and concurrent session store.
//!
//! Design constraints:
//!   - Multiple sessions can be active simultaneously.
//!   - Each session is worked on by **one task at a time** (Mutex guarantee).
//!   - Each session has its own conversation history and state.

use std::{
    collections::HashMap,
    sync::Arc,
    time::Instant,
};

use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::cognition_client::proto::Message;

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    Idle,
    Processing,
    AwaitingToolResult,
    Error(String),
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// All state associated with a single user session.
///
/// Protected by `Mutex` to ensure only one agent task runs at a time.
#[derive(Debug)]
pub struct Session {
    pub session_id: String,
    pub created_at: Instant,
    pub last_active: Instant,
    pub state: SessionState,
    pub conversation_history: Vec<Message>,
    /// Arbitrary metadata (e.g. user_id, channel info).
    pub metadata: HashMap<String, String>,
}

impl Session {
    pub fn new(metadata: HashMap<String, String>) -> Self {
        let now = Instant::now();
        Self {
            session_id: Uuid::new_v4().to_string(),
            created_at: now,
            last_active: now,
            state: SessionState::Idle,
            conversation_history: Vec::new(),
            metadata,
        }
    }

    pub fn touch(&mut self) {
        self.last_active = Instant::now();
    }

    /// Append a message to the conversation history.
    pub fn push_message(&mut self, role: impl Into<String>, content: impl Into<String>) {
        self.conversation_history.push(Message {
            role: role.into(),
            content: content.into(),
        });
        self.touch();
    }

    /// Elapsed seconds since last activity.
    pub fn idle_secs(&self) -> u64 {
        self.last_active.elapsed().as_secs()
    }
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

/// Thread-safe registry of all active sessions.
///
/// Sessions are stored behind `Arc<Mutex<Session>>` — the inner Mutex ensures
/// only one agent task operates on a session at a time.  The outer RwLock on
/// the map allows many readers (lookups) while writes (create/remove) are rare.
pub struct SessionStore {
    sessions: RwLock<HashMap<String, Arc<Mutex<Session>>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Create a new session and return its ID.
    pub async fn create(&self, metadata: HashMap<String, String>) -> String {
        let session = Session::new(metadata);
        let id = session.session_id.clone();
        let mut map = self.sessions.write().await;
        map.insert(id.clone(), Arc::new(Mutex::new(session)));
        id
    }

    /// Retrieve the Arc for a session (caller must lock before access).
    pub async fn get(&self, session_id: &str) -> Option<Arc<Mutex<Session>>> {
        let map = self.sessions.read().await;
        map.get(session_id).cloned()
    }

    /// Remove a session.
    pub async fn remove(&self, session_id: &str) {
        let mut map = self.sessions.write().await;
        map.remove(session_id);
    }

    /// Count of active sessions.
    pub async fn len(&self) -> usize {
        self.sessions.read().await.len()
    }

    /// List all active session IDs.
    pub async fn list_active(&self) -> Vec<String> {
        let map = self.sessions.read().await;
        map.keys().cloned().collect()
    }

    /// Remove all sessions that have been idle longer than `threshold_secs`.
    /// Returns the number of sessions cleaned up.
    pub async fn cleanup_expired(&self, threshold_secs: u64) -> usize {
        let mut map = self.sessions.write().await;
        let before = map.len();
        map.retain(|_, arc| {
            // If the session is locked by an active task, keep it unconditionally.
            if let Ok(s) = arc.try_lock() {
                s.idle_secs() < threshold_secs
            } else {
                true
            }
        });
        before - map.len()
    }
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn create_and_get() {
        let store = SessionStore::new();
        let id = store.create(HashMap::new()).await;
        assert!(!id.is_empty());
        let arc = store.get(&id).await;
        assert!(arc.is_some());
    }

    #[tokio::test]
    async fn remove_session() {
        let store = SessionStore::new();
        let id = store.create(HashMap::new()).await;
        store.remove(&id).await;
        assert!(store.get(&id).await.is_none());
    }

    #[tokio::test]
    async fn conversation_history() {
        let store = SessionStore::new();
        let id = store.create(HashMap::new()).await;
        let arc = store.get(&id).await.unwrap();
        {
            let mut s = arc.lock().await;
            s.push_message("user", "Hello");
            s.push_message("assistant", "Hi there!");
        }
        let s = arc.lock().await;
        assert_eq!(s.conversation_history.len(), 2);
    }
}
