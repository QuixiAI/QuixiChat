//! In-process Gemma 4 E2B inference on Metal.
//!
//! The engine — GGUF reader, architecture config, tokenizer, hybrid KV cache and
//! the quantized Metal model — is ported from MoleculAI's `moleculai-llm`
//! unchanged. MoleculAI's chemistry-extraction layer is replaced by `chat`,
//! since QuixiChat wants a conversation rather than structured chemical output.

// Ported from MoleculAI. These files are kept byte-identical to their source
// so the two trees stay diffable and fixes flow both ways; the pedantic lints
// below fire on deliberate, bounds-checked numeric conversions in quantization
// and kernel-dispatch code. Silencing them per-site would be the change that
// makes the port drift.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::default_trait_access,
    clippy::float_cmp,
    clippy::must_use_candidate,
    clippy::needless_pass_by_value,
    clippy::needless_range_loop,
    clippy::needless_raw_string_hashes,
    clippy::struct_excessive_bools,
    clippy::too_many_lines,
    clippy::items_after_statements,
    clippy::unreadable_literal,
    clippy::match_same_arms,
    clippy::len_without_is_empty,
    clippy::cast_lossless,
    clippy::manual_assert,
    clippy::field_reassign_with_default,
    clippy::redundant_closure_for_method_calls,
    clippy::missing_const_for_fn,
    clippy::single_match_else,
    clippy::unused_self,
    clippy::doc_markdown,
    clippy::return_self_not_must_use,
    clippy::similar_names,
    clippy::used_underscore_binding,
    clippy::wildcard_imports,
    clippy::explicit_iter_loop,
    clippy::inline_always,
    clippy::range_plus_one,
    clippy::trivially_copy_pass_by_ref
)]

pub mod cache;
pub mod chat;
pub mod gguf;
pub mod model;
#[cfg(feature = "metal-kernels")]
pub mod quant_model;
pub mod template;
pub mod tokenizer;

pub use cache::{CacheError, CachePlan, LayerCacheMode, LayerKvCache};
pub use chat::{
    COMPACTION_TRIGGER_TOKENS, ChatError, ChatMessage, ChatRole, Compaction, GeneratedReply,
    GenerationEvent, GenerationOptions, MAX_NEW_TOKENS,
};
pub use gguf::{GgufAudit, GgufError, audit_gguf};
pub use model::{ArchitectureError, AttentionKind, Gemma4Config, LayerSpec};
#[cfg(feature = "metal-kernels")]
pub use quant_model::{Gemma4QuantizedMetal, QuantGenerationState, QuantModelError};
pub use template::{TURN_CLOSE, TemplateError, TemplateMessage};
pub use tokenizer::{Gemma4Tokenizer, TokenizerError, tokenizer_json};

#[cfg(feature = "metal-kernels")]
pub use chat::ChatEngine;
