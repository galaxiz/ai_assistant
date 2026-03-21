//! gRPC client for the Cognition Engine.
//!
//! Wraps the tonic-generated stub with:
//!   - Connection management + reconnect
//!   - Automatic RequestContext population (session_id + auth_token)
//!   - Retry with exponential backoff on transient errors

pub mod proto {
    tonic::include_proto!("cognition");
}

use std::time::Duration;

use proto::{
    cognition_service_client::CognitionServiceClient,
    CompleteRequest, CompleteResponse,
    CountTokensRequest, CountTokensResponse,
    Message, ParseOutputRequest, ParseOutputResponse,
    RequestContext, StreamChunk,
};
use tokio_stream::Stream;
use tonic::{transport::Channel, Request, Status};
use tonic_health::pb::health_client::HealthClient;
use tonic_health::pb::HealthCheckRequest;
use tracing::{instrument, warn};

use crate::{
    config::CognitionEngineSettings,
    errors::CognitionError,
};

/// Transient gRPC codes that are safe to retry.
fn is_retryable(code: tonic::Code) -> bool {
    matches!(
        code,
        tonic::Code::Unavailable
            | tonic::Code::ResourceExhausted
            | tonic::Code::DeadlineExceeded
            | tonic::Code::Unknown
    )
}

/// Thin wrapper around the generated gRPC client.
pub struct CognitionClient {
    inner: CognitionServiceClient<Channel>,
    /// Raw channel kept for constructing auxiliary clients (e.g. health check).
    channel: Channel,
    settings: CognitionEngineSettings,
}

impl CognitionClient {
    /// Connect to the Cognition Engine.
    pub async fn connect(settings: &CognitionEngineSettings) -> Result<Self, CognitionError> {
        let endpoint = tonic::transport::Endpoint::from_shared(settings.address.clone())
            .map_err(|e| CognitionError::Connection(e.into()))?
            .connect_timeout(Duration::from_secs(settings.connect_timeout_secs))
            .timeout(Duration::from_secs(settings.request_timeout_secs));

        let channel = endpoint.connect().await?;
        let inner = CognitionServiceClient::new(channel.clone())
            .max_decoding_message_size(64 * 1024 * 1024)
            .max_encoding_message_size(64 * 1024 * 1024);

        Ok(Self {
            inner,
            channel,
            settings: settings.clone(),
        })
    }

    /// Build a `RequestContext` for every outbound call.
    fn make_context(session_id: &str, auth_token: &str) -> RequestContext {
        RequestContext {
            session_id: session_id.to_string(),
            auth_token: auth_token.to_string(),
        }
    }

    /// Non-streaming completion — retries on transient failures.
    #[instrument(skip(self, messages), fields(session_id, model))]
    pub async fn complete(
        &self,
        session_id: &str,
        auth_token: &str,
        messages: Vec<Message>,
        model: &str,
        temperature: f32,
        max_tokens: i32,
    ) -> Result<CompleteResponse, CognitionError> {
        let req = CompleteRequest {
            context: Some(Self::make_context(session_id, auth_token)),
            messages,
            model: model.to_string(),
            temperature,
            max_tokens,
        };

        self.with_retry(|mut client: CognitionServiceClient<Channel>| {
            let req = req.clone();
            async move { client.complete(Request::new(req)).await.map(|r| r.into_inner()) }
        })
        .await
    }

    /// Server-streaming completion — no retry wrapper (caller manages backpressure).
    pub async fn stream_complete(
        &self,
        session_id: &str,
        auth_token: &str,
        messages: Vec<Message>,
        model: &str,
        temperature: f32,
        max_tokens: i32,
    ) -> Result<impl Stream<Item = Result<StreamChunk, Status>>, CognitionError> {
        let req = CompleteRequest {
            context: Some(Self::make_context(session_id, auth_token)),
            messages,
            model: model.to_string(),
            temperature,
            max_tokens,
        };
        let mut client = self.inner.clone();
        let stream = client
            .stream_complete(Request::new(req))
            .await?
            .into_inner();
        Ok(stream)
    }

    /// Token counting.
    #[instrument(skip(self, messages), fields(session_id))]
    pub async fn count_tokens(
        &self,
        session_id: &str,
        auth_token: &str,
        messages: Vec<Message>,
        model: &str,
    ) -> Result<CountTokensResponse, CognitionError> {
        let req = CountTokensRequest {
            context: Some(Self::make_context(session_id, auth_token)),
            messages,
            model: model.to_string(),
        };
        self.with_retry(|mut client| {
            let req = req.clone();
            async move { client.count_tokens(Request::new(req)).await.map(|r| r.into_inner()) }
        })
        .await
    }

    /// JSON extraction and repair.
    #[instrument(skip(self, raw_response, context_messages), fields(session_id))]
    pub async fn parse_output(
        &self,
        session_id: &str,
        auth_token: &str,
        raw_response: &str,
        schema_json: &str,
        context_messages: Vec<Message>,
    ) -> Result<ParseOutputResponse, CognitionError> {
        let req = ParseOutputRequest {
            context: Some(Self::make_context(session_id, auth_token)),
            raw_response: raw_response.to_string(),
            schema_json: schema_json.to_string(),
            context_messages,
        };
        self.with_retry(|mut client| {
            let req = req.clone();
            async move { client.parse_output(Request::new(req)).await.map(|r| r.into_inner()) }
        })
        .await
    }

    /// Health check via the standard gRPC `grpc.health.v1` protocol.
    pub async fn health_check(&self) -> Result<(), CognitionError> {
        let mut client = HealthClient::new(self.channel.clone());
        client
            .check(HealthCheckRequest { service: String::new() })
            .await
            .map(|_| ())
            .map_err(CognitionError::from)
    }

    /// Generic retry wrapper with exponential backoff.
    async fn with_retry<F, Fut, T>(&self, mut f: F) -> Result<T, CognitionError>
    where
        F: FnMut(CognitionServiceClient<Channel>) -> Fut,
        Fut: std::future::Future<Output = Result<T, tonic::Status>>,
    {
        let max = self.settings.max_retries;
        let mut attempt = 0u32;
        loop {
            match f(self.inner.clone()).await {
                Ok(v) => return Ok(v),
                Err(status) if is_retryable(status.code()) && attempt < max => {
                    attempt += 1;
                    let backoff = Duration::from_millis(200 * 2u64.pow(attempt - 1));
                    warn!(
                        attempt,
                        code = ?status.code(),
                        backoff_ms = backoff.as_millis(),
                        "Cognition Engine RPC retrying"
                    );
                    tokio::time::sleep(backoff).await;
                }
                Err(status) => return Err(status.into()),
            }
        }
    }
}
