//! In-process Gemma 4 E2B inference on Metal.
//!
//! The engine owns GGUF loading, the tokenizer and chat template, hybrid KV
//! caching, and the quantized Metal model.

mod cache;
mod chat;
mod gguf;
mod model;
mod quant_model;
mod template;
mod tokenizer;

pub use chat::{
    Bench, COMPACTION_TRIGGER_TOKENS, ChatEngine, ChatError, ChatMessage, ChatRole, Compaction,
    GeneratedReply, GenerationEvent,
};
