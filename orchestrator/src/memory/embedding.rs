//! BGE embedding engine — wraps `fastembed-rs` for in-process ONNX inference.
//!
//! Model: BAAI/bge-small-en-v1.5 (384-dim, 33M params).
//! Upgrade path: swap `EmbeddingModel::BGESmallENV15` for `BGEBaseENV15` (768-dim).

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use once_cell::sync::OnceCell;

use crate::errors::MemoryError;

static ENGINE: OnceCell<TextEmbedding> = OnceCell::new();

/// Initialise the BGE embedding model (call once at startup).
pub fn init() -> Result<(), MemoryError> {
    ENGINE.get_or_try_init(|| {
        TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::BGESmallENV15).with_show_download_progress(true),
        )
        .map_err(MemoryError::Embedding)
    })?;
    Ok(())
}

/// Embed a single text using BGE.
pub fn embed(text: &str) -> Result<Vec<f32>, MemoryError> {
    let engine = ENGINE.get().ok_or_else(|| {
        MemoryError::Embedding(anyhow::anyhow!(
            "EmbeddingEngine not initialised — call init() first"
        ))
    })?;
    let mut result = engine
        .embed(vec![text], None)
        .map_err(MemoryError::Embedding)?;
    Ok(result.remove(0))
}

/// Embed a batch of texts.
pub fn embed_batch(texts: &[&str]) -> Result<Vec<Vec<f32>>, MemoryError> {
    let engine = ENGINE.get().ok_or_else(|| {
        MemoryError::Embedding(anyhow::anyhow!("EmbeddingEngine not initialised"))
    })?;
    engine
        .embed(texts.to_vec(), None)
        .map_err(MemoryError::Embedding)
}
