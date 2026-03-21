//! Bearer token auth middleware.
//!
//! Validates `Authorization: Bearer <token>` against config.
//! On success, inserts a `ValidatedUser` (with its `AccessPolicy`) into the
//! request extensions so downstream handlers can enforce per-resource rules.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};

use crate::{
    access_control::{AccessPolicy, ValidatedUser},
    config::AuthSettings,
};

/// State carried by the auth middleware layer.
#[derive(Clone)]
pub struct AuthConfig(pub AuthSettings);

pub async fn auth_middleware(
    State(auth): State<AuthConfig>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let settings = &auth.0;

    let token = if let Some(expected) = &settings.token {
        let provided = req
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));

        match provided {
            Some(t) if t == expected => t.to_string(),
            _ => return Err(StatusCode::UNAUTHORIZED),
        }
    } else {
        // Auth disabled — use an empty token and allow-all policy.
        String::new()
    };

    req.extensions_mut().insert(ValidatedUser {
        token,
        policy: AccessPolicy::from_settings(settings),
    });

    Ok(next.run(req).await)
}
