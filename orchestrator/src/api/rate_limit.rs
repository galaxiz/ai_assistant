//! Token-bucket rate limiting, keyed per session ID.
//!
//! Uses `governor`'s `DefaultKeyedRateLimiter` (backed by DashMap) so each
//! session gets its own independent bucket.
//!
//! A `rate_limit_rpm` of 0 in config disables rate limiting entirely.

use std::num::NonZeroU32;

use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};

pub struct SessionRateLimiter {
    /// `None` when rate limiting is disabled (rpm == 0).
    inner: Option<DefaultKeyedRateLimiter<String>>,
}

impl SessionRateLimiter {
    /// Create a limiter allowing up to `requests_per_minute` per session.
    /// Pass `0` to disable rate limiting.
    pub fn new(requests_per_minute: u32) -> Self {
        let inner = NonZeroU32::new(requests_per_minute)
            .map(|rpm| RateLimiter::keyed(Quota::per_minute(rpm)));
        Self { inner }
    }

    /// Returns `true` if the request for `session_id` is within the rate limit.
    pub fn check(&self, session_id: &str) -> bool {
        match &self.inner {
            None => true,
            Some(limiter) => limiter.check_key(&session_id.to_string()).is_ok(),
        }
    }
}
