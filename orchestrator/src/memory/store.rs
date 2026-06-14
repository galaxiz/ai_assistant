//! Qdrant-backed memory store.
//!
//! Each session gets its own Qdrant collection (named `{prefix}_{session_id}`).
//! Two categories of point are stored:
//!   - `"conversation"` — ordered conversation turns (deterministic IDs `conv_N`).
//!   - `"memory"` — arbitrary agent memories embedded on demand.

use qdrant_client::{
    qdrant::{
        Condition, CreateCollectionBuilder, Distance, Filter, PointStruct, ScrollPointsBuilder,
        SearchPointsBuilder, UpsertPointsBuilder, VectorParamsBuilder,
    },
    Qdrant,
};
use tracing::instrument;
use uuid::Uuid;

use super::embedding;
use crate::{cognition_client::proto::Message, config::QdrantSettings, errors::MemoryError};

/// Dimension of BGE-small-en-v1.5 embeddings.
const VECTOR_DIM: u64 = 384;

/// Maximum number of conversation points returned by a single scroll request.
const MAX_CONVERSATION_SCROLL: u32 = 10_000;

pub struct MemoryStore {
    client: Qdrant,
    collection_prefix: String,
}

impl MemoryStore {
    pub async fn connect(settings: &QdrantSettings) -> Result<Self, MemoryError> {
        let mut builder = Qdrant::from_url(&settings.url);
        if let Some(key) = &settings.api_key {
            builder = builder.api_key(key.clone());
        }
        let client = builder
            .build()
            .map_err(|e| MemoryError::Qdrant(e.to_string()))?;
        Ok(Self {
            client,
            collection_prefix: settings.collection_prefix.clone(),
        })
    }

    fn collection_name(&self, session_id: &str) -> String {
        format!(
            "{}_{}",
            self.collection_prefix,
            session_id.replace('-', "_")
        )
    }

    /// Ping Qdrant — used by the health check / heartbeat task.
    #[instrument(skip(self))]
    pub async fn health_check(&self) -> Result<(), MemoryError> {
        self.client
            .list_collections()
            .await
            .map(|_| ())
            .map_err(|e| MemoryError::Qdrant(e.to_string()))
    }

    /// Ensure the Qdrant collection for `session_id` exists.
    pub async fn ensure_collection(&self, session_id: &str) -> Result<(), MemoryError> {
        let name = self.collection_name(session_id);
        let collections = self
            .client
            .list_collections()
            .await
            .map_err(|e| MemoryError::Qdrant(e.to_string()))?;
        let exists = collections.collections.iter().any(|c| c.name == name);
        if !exists {
            self.client
                .create_collection(
                    CreateCollectionBuilder::new(&name)
                        .vectors_config(VectorParamsBuilder::new(VECTOR_DIM, Distance::Cosine)),
                )
                .await
                .map_err(|e| MemoryError::Qdrant(e.to_string()))?;
        }
        Ok(())
    }

    /// Embed and store an arbitrary `text` snippet for `session_id`.
    #[instrument(skip(self, text, payload), fields(session_id))]
    ///
    /// Use `payload` to attach metadata (e.g. `{"type": "note", "source": "..."}`).
    pub async fn store(
        &self,
        session_id: &str,
        text: &str,
        payload: serde_json::Value,
    ) -> Result<(), MemoryError> {
        self.ensure_collection(session_id).await?;
        let vec = embedding::embed(text)?;
        let payload_qdrant: qdrant_client::Payload =
            payload.try_into().unwrap_or_else(|_| Default::default());
        let point = PointStruct::new(Uuid::new_v4().to_string(), vec, payload_qdrant);
        self.client
            .upsert_points(UpsertPointsBuilder::new(
                self.collection_name(session_id),
                vec![point],
            ))
            .await
            .map_err(|e| MemoryError::Qdrant(e.to_string()))?;
        Ok(())
    }

    /// Semantic search for the `top_k` most similar stored texts.
    #[instrument(skip(self, query), fields(session_id, top_k))]
    pub async fn search(
        &self,
        session_id: &str,
        query: &str,
        top_k: u64,
    ) -> Result<Vec<serde_json::Value>, MemoryError> {
        self.ensure_collection(session_id).await?;
        let vec = embedding::embed(query)?;
        let results = self
            .client
            .search_points(
                SearchPointsBuilder::new(self.collection_name(session_id), vec, top_k)
                    .with_payload(true),
            )
            .await
            .map_err(|e| MemoryError::Qdrant(e.to_string()))?;

        Ok(results
            .result
            .into_iter()
            .map(|p| serde_json::to_value(&p.payload).unwrap_or_default())
            .collect())
    }

    /// Persist a full conversation snapshot for `session_id`.
    #[instrument(skip(self, messages), fields(session_id, message_count = messages.len()))]
    ///
    /// Each message is embedded and stored with a deterministic ID (`conv_N`),
    /// so repeated calls (e.g. after each new turn) safely upsert in-place.
    pub async fn store_conversation(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> Result<(), MemoryError> {
        if messages.is_empty() {
            return Ok(());
        }
        self.ensure_collection(session_id).await?;

        let texts: Vec<&str> = messages.iter().map(|m| m.content.as_str()).collect();
        let embeddings = embedding::embed_batch(&texts)?;

        let points: Vec<PointStruct> = messages
            .iter()
            .zip(embeddings)
            .enumerate()
            .map(|(seq, (msg, vec))| {
                let payload = serde_json::json!({
                    "type": "conversation",
                    "role": msg.role,
                    "content": msg.content,
                    "seq": seq as u64,
                });
                let payload_qdrant: qdrant_client::Payload =
                    payload.try_into().unwrap_or_else(|_| Default::default());
                // Deterministic ID ensures upsert is idempotent.
                PointStruct::new(format!("conv_{}", seq), vec, payload_qdrant)
            })
            .collect();

        self.client
            .upsert_points(UpsertPointsBuilder::new(
                self.collection_name(session_id),
                points,
            ))
            .await
            .map_err(|e| MemoryError::Qdrant(e.to_string()))?;

        Ok(())
    }

    /// Retrieve the full ordered conversation history for `session_id`.
    #[instrument(skip(self), fields(session_id))]
    ///
    /// Returns messages sorted by their original insertion order (`seq`).
    pub async fn get_conversation(&self, session_id: &str) -> Result<Vec<Message>, MemoryError> {
        self.ensure_collection(session_id).await?;

        let filter = Filter::must([Condition::matches("type", "conversation".to_string())]);

        let response = self
            .client
            .scroll(
                ScrollPointsBuilder::new(self.collection_name(session_id))
                    .filter(filter)
                    .with_payload(true)
                    .limit(MAX_CONVERSATION_SCROLL),
            )
            .await
            .map_err(|e| MemoryError::Qdrant(e.to_string()))?;

        let mut msgs: Vec<(u64, Message)> = response
            .result
            .into_iter()
            .filter_map(|p| {
                let payload: serde_json::Value = serde_json::to_value(&p.payload).ok()?;
                let seq = payload["seq"].as_u64()?;
                let role = payload["role"].as_str()?.to_string();
                let content = payload["content"].as_str()?.to_string();
                Some((seq, Message { role, content }))
            })
            .collect();

        msgs.sort_by_key(|(seq, _)| *seq);
        Ok(msgs.into_iter().map(|(_, m)| m).collect())
    }
}
