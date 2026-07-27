//! In-process Gemma 4 E2B inference on Metal.
//!
//! The engine owns GGUF loading, the tokenizer and chat template, hybrid KV
//! caching, and the quantized Metal model.

// The inference and kernel code uses deliberate, bounds-checked numeric
// conversions that are clearer than per-site lint annotations.
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
