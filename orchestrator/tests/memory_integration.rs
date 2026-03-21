//! Integration tests for the memory / Qdrant layer (P5).
//!
//! Requires a running Qdrant instance on localhost:6334.
//! Run with:
//!   docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant
//!   cargo test --test memory_integration -- --ignored

use orchestrator::{
    cognition_client::proto::Message,
    config::QdrantSettings,
    memory::{embedding, MemoryStore},
};

fn test_qdrant_settings() -> QdrantSettings {
    QdrantSettings {
        url: "http://127.0.0.1:6334".to_string(),
        api_key: None,
        collection_prefix: "test".to_string(),
    }
}

#[tokio::test]
#[ignore = "requires running Qdrant instance on localhost:6334"]
async fn test_health_check() {
    let store = MemoryStore::connect(&test_qdrant_settings())
        .await
        .expect("connect");
    store.health_check().await.expect("health_check");
}

#[tokio::test]
#[ignore = "requires running Qdrant instance on localhost:6334"]
async fn test_store_and_search() {
    embedding::init().expect("embedding init");

    let store = MemoryStore::connect(&test_qdrant_settings())
        .await
        .expect("connect");

    let session_id = format!("inttest_{}", uuid::Uuid::new_v4());

    store
        .store(
            &session_id,
            "The Eiffel Tower is located in Paris, France.",
            serde_json::json!({"type": "memory", "source": "test"}),
        )
        .await
        .expect("store");

    let results = store
        .search(&session_id, "Where is the Eiffel Tower?", 5)
        .await
        .expect("search");

    assert!(!results.is_empty(), "expected at least one result");
}

#[tokio::test]
#[ignore = "requires running Qdrant instance on localhost:6334"]
async fn test_store_and_get_conversation() {
    embedding::init().expect("embedding init");

    let store = MemoryStore::connect(&test_qdrant_settings())
        .await
        .expect("connect");

    let session_id = format!("inttest_{}", uuid::Uuid::new_v4());

    let messages = vec![
        Message { role: "user".to_string(), content: "Hello, how are you?".to_string() },
        Message { role: "assistant".to_string(), content: "I'm doing well, thanks!".to_string() },
        Message { role: "user".to_string(), content: "What is the capital of France?".to_string() },
        Message { role: "assistant".to_string(), content: "The capital of France is Paris.".to_string() },
    ];

    store
        .store_conversation(&session_id, &messages)
        .await
        .expect("store_conversation");

    let retrieved = store
        .get_conversation(&session_id)
        .await
        .expect("get_conversation");

    assert_eq!(retrieved.len(), messages.len(), "wrong number of messages");

    for (orig, got) in messages.iter().zip(retrieved.iter()) {
        assert_eq!(orig.role, got.role);
        assert_eq!(orig.content, got.content);
    }
}

#[tokio::test]
#[ignore = "requires running Qdrant instance on localhost:6334"]
async fn test_store_conversation_is_idempotent() {
    embedding::init().expect("embedding init");

    let store = MemoryStore::connect(&test_qdrant_settings())
        .await
        .expect("connect");

    let session_id = format!("inttest_{}", uuid::Uuid::new_v4());

    let messages = vec![
        Message { role: "user".to_string(), content: "First message".to_string() },
        Message { role: "assistant".to_string(), content: "First reply".to_string() },
    ];

    // Call twice — second call should upsert, not duplicate.
    store.store_conversation(&session_id, &messages).await.expect("first store");
    store.store_conversation(&session_id, &messages).await.expect("second store");

    let retrieved = store.get_conversation(&session_id).await.expect("get");
    assert_eq!(retrieved.len(), 2, "upsert should not create duplicates");
}
