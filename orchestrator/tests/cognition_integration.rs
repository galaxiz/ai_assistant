use orchestrator::{
    cognition_client::{proto::Message, CognitionClient},
    config::CognitionEngineSettings,
};

#[tokio::test]
#[ignore = "requires running Cognition Engine"]
async fn test_count_tokens_integration() {
    let settings = CognitionEngineSettings {
        address: "http://127.0.0.1:50051".to_string(),
        connect_timeout_secs: 5,
        request_timeout_secs: 10,
        max_retries: 3,
    };

    let client = CognitionClient::connect(&settings)
        .await
        .expect("Failed to connect");

    // Send a message to count
    let messages = vec![Message {
        role: "user".to_string(),
        content: "What is the meaning of life, the universe, and everything?".to_string(),
    }];

    // BGE embedding request usually requires a model, but we'll use placeholder
    let response = client
        .count_tokens("test-session", "", messages, "placeholder-model")
        .await
        .expect("Failed to count tokens");

    // Ensure we got some length back
    assert!(response.token_count > 0);
}
