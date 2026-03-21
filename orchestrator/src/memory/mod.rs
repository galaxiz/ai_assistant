//! Memory & vector store integration (P5 — stub with interface).
//!
//! Full implementation wires `qdrant-client` and `fastembed` (BGE).
//! This module defines the public interface so other modules can depend on it
//! without the implementation being required for P0 compilation.

pub mod embedding;
pub mod store;

pub use store::MemoryStore;
