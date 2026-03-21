I need to build a custom AI Agent.

The system should have following components:

* Orchestrator (Core Daemon)
  * Responsibilities: Event loop management, heartbeat scheduling, routing, and access control.
  * Language: Rust
  * Directory: orchestrator
* Cognition Engine
  * Responsibilities: Prompt formatting, token counting, structured data parsing (JSON), and fallback handling.
  * Language: Python
  * Directory: cognition_engine
* Tool Execution Sandbox
  * Responsibilities: Executing agent-generated code or pre-defined tools with strict permission scopes.
  * Language: WebAssembly
  * Directory: tool_sandbox
* Memory & State Management (Storage)
  * Responsibilities: Storing user data, document embeddings, and conversation histories for fast retrieval.
  * Language: Rust (WebAssembly)
  * Directory: memory
* Messaging Adapters
  * Responsibilities: Listening for user input, formatting Markdown responses, and handling user authentication.
  * Language: TypeScript
  * Directory: communication_adapters

Orchestrator connects with all other components.

* Orchestrator <=> Cognition Engine: gRPC (Protocol Buffers)
* Orchestrator <=> Tool Execution Sandbox: In-Process (Host Functions)
* Orchestrator <=> Memory / Vector Database: Direct TCP (Connection Pooling)
* Messaging Adapters <=> Orchestrator: WebSockets or Webhooks

Details
* Orchestrator
  * Supports multiple sessions. Each session is worked on by one thread at a time. Each session has a separate agent memory.
  * Instrument with OpenTelemetry
* Memory & State Management
  * Use Qdrant
* Tool Execution Sandbox
  * Use Wasmtime
* Cognition Engine
  * Use LiteLLM to handle retries and rate limiting
  * Use tiktoken to predict prompt sizes
