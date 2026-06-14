//! Access control — policy model and validated-user identity.
//!
//! An `AccessPolicy` is attached to every authenticated request.
//! It restricts which tools and models the caller may use.
//! `None` in either field means "all permitted" (allow-all default).

use std::collections::HashSet;

use crate::config::AuthSettings;

/// Per-request access policy derived from the caller's auth token.
#[derive(Debug, Clone)]
pub struct AccessPolicy {
    /// If `Some`, only tools whose names are in this set may be invoked.
    pub allowed_tools: Option<HashSet<String>>,
    /// If `Some`, only models whose names are in this set may be requested.
    pub allowed_models: Option<HashSet<String>>,
}

impl AccessPolicy {
    /// Build from config; empty Vec means "allow all".
    pub fn from_settings(settings: &AuthSettings) -> Self {
        let allowed_tools = if settings.allowed_tools.is_empty() {
            None
        } else {
            Some(settings.allowed_tools.iter().cloned().collect())
        };
        let allowed_models = if settings.allowed_models.is_empty() {
            None
        } else {
            Some(settings.allowed_models.iter().cloned().collect())
        };
        Self {
            allowed_tools,
            allowed_models,
        }
    }

    /// An unrestricted policy — grants access to all tools and models.
    pub fn allow_all() -> Self {
        Self {
            allowed_tools: None,
            allowed_models: None,
        }
    }

    /// Returns `true` if `tool_name` is permitted under this policy.
    pub fn allows_tool(&self, tool_name: &str) -> bool {
        match &self.allowed_tools {
            None => true,
            Some(set) => set.contains(tool_name),
        }
    }

    /// Returns `true` if `model` is permitted under this policy.
    pub fn allows_model(&self, model: &str) -> bool {
        match &self.allowed_models {
            None => true,
            Some(set) => set.contains(model),
        }
    }
}

/// Authenticated caller identity, inserted into request extensions by the
/// auth middleware and read by handlers.
#[derive(Debug, Clone)]
pub struct ValidatedUser {
    /// The raw bearer token (forwarded as `RequestContext.auth_token`).
    pub token: String,
    pub policy: AccessPolicy,
}
