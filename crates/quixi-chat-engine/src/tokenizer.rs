//! Offline Gemma 4 byte-fallback BPE, reconstructed from GGUF metadata.

use serde_json::{Map, Value, json};
use thiserror::Error;
use tokenizers::Tokenizer;

use crate::gguf::{Gguf, GgufError, GgufValue};

const SPECIAL_TOKEN_IDS: &[usize] = &[
    0, 1, 2, 3, 4, 46, 47, 48, 49, 50, 51, 52, 98, 100, 101, 105, 106, 255_999, 256_000, 258_880,
    258_881, 258_882, 258_883, 258_884,
];

#[derive(Debug, Error)]
pub enum TokenizerError {
    #[error(transparent)]
    Gguf(#[from] GgufError),
    #[error("GGUF tokenizer metadata {0:?} is missing or has the wrong type")]
    Metadata(String),
    #[error("GGUF tokenizer arrays disagree: {tokens} tokens, {scores} scores, {types} types")]
    ArrayLengths {
        tokens: usize,
        scores: usize,
        types: usize,
    },
    #[error("invalid GGUF BPE merge at index {index}: {merge:?}")]
    Merge { index: usize, merge: String },
    #[error("failed to serialize tokenizer: {0}")]
    Json(#[from] serde_json::Error),
    #[error("failed to construct tokenizer: {0}")]
    Tokenizers(String),
}

/// Gemma's text tokenizer and the generation-critical special token policy.
pub struct Gemma4Tokenizer {
    inner: Tokenizer,
    pub bos_token_id: u32,
    pub eos_token_id: u32,
    pub chat_template: String,
}

impl Gemma4Tokenizer {
    pub fn from_gguf(gguf: &Gguf) -> Result<Self, TokenizerError> {
        let bytes = tokenizer_json(gguf)?;
        let inner = Tokenizer::from_bytes(&bytes)
            .map_err(|error| TokenizerError::Tokenizers(error.to_string()))?;
        Ok(Self {
            inner,
            bos_token_id: metadata_u32(gguf, "tokenizer.ggml.bos_token_id")?,
            eos_token_id: metadata_u32(gguf, "tokenizer.ggml.eos_token_id")?,
            chat_template: metadata_string(gguf, "tokenizer.chat_template")?.to_owned(),
        })
    }

    pub fn encode(&self, text: &str, add_bos: bool) -> Result<Vec<u32>, TokenizerError> {
        let encoding = self
            .inner
            .encode(text, true)
            .map_err(|error| TokenizerError::Tokenizers(error.to_string()))?;
        let mut ids = encoding.get_ids().to_vec();
        if add_bos && ids.first().copied() != Some(self.bos_token_id) {
            ids.insert(0, self.bos_token_id);
        }
        Ok(ids)
    }

    pub fn decode(&self, ids: &[u32], skip_special_tokens: bool) -> Result<String, TokenizerError> {
        self.inner
            .decode(ids, skip_special_tokens)
            .map_err(|error| TokenizerError::Tokenizers(error.to_string()))
    }

    #[must_use]
    pub fn inner(&self) -> &Tokenizer {
        &self.inner
    }
}

/// Materialize a standard Hugging Face `tokenizer.json` from GGUF metadata.
fn tokenizer_json(gguf: &Gguf) -> Result<Vec<u8>, TokenizerError> {
    let tokens = metadata_array(gguf, "tokenizer.ggml.tokens")?;
    let scores = metadata_array(gguf, "tokenizer.ggml.scores")?;
    let token_types = metadata_array(gguf, "tokenizer.ggml.token_type")?;
    if tokens.len() != scores.len() || tokens.len() != token_types.len() {
        return Err(TokenizerError::ArrayLengths {
            tokens: tokens.len(),
            scores: scores.len(),
            types: token_types.len(),
        });
    }

    let token_strings = tokens
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| TokenizerError::Metadata("tokenizer.ggml.tokens".to_owned()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut vocab = Map::with_capacity(token_strings.len());
    for (id, token) in token_strings.iter().enumerate() {
        vocab.insert(token.clone(), json!(id));
    }

    let merges = metadata_array(gguf, "tokenizer.ggml.merges")?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let merge = value
                .as_str()
                .ok_or_else(|| TokenizerError::Metadata("tokenizer.ggml.merges".to_owned()))?;
            let (left, right) = merge
                .rsplit_once(' ')
                .ok_or_else(|| TokenizerError::Merge {
                    index,
                    merge: merge.to_owned(),
                })?;
            if left.is_empty() || right.is_empty() {
                return Err(TokenizerError::Merge {
                    index,
                    merge: merge.to_owned(),
                });
            }
            Ok(json!([left, right]))
        })
        .collect::<Result<Vec<_>, TokenizerError>>()?;

    let added_tokens = SPECIAL_TOKEN_IDS
        .iter()
        .map(|&id| {
            let content = token_strings
                .get(id)
                .ok_or_else(|| TokenizerError::Metadata("tokenizer.ggml.tokens".to_owned()))?;
            Ok(json!({
                "id": id,
                "content": content,
                "single_word": false,
                "lstrip": false,
                "rstrip": false,
                "normalized": false,
                "special": true
            }))
        })
        .collect::<Result<Vec<_>, TokenizerError>>()?;

    let root = json!({
        "version": "1.0",
        "truncation": null,
        "padding": null,
        "added_tokens": added_tokens,
        "normalizer": {
            "type": "Replace",
            "pattern": {"String": " "},
            "content": "▁"
        },
        "pre_tokenizer": {
            "type": "Split",
            "pattern": {"String": " "},
            "behavior": "MergedWithPrevious",
            "invert": false
        },
        "post_processor": {
            "type": "TemplateProcessing",
            "single": [{"Sequence": {"id": "A", "type_id": 0}}],
            "pair": [
                {"Sequence": {"id": "A", "type_id": 0}},
                {"Sequence": {"id": "B", "type_id": 1}}
            ],
            "special_tokens": {}
        },
        "decoder": {
            "type": "Sequence",
            "decoders": [
                {"type": "Replace", "pattern": {"String": "▁"}, "content": " "},
                {"type": "ByteFallback"},
                {"type": "Fuse"}
            ]
        },
        "model": {
            "type": "BPE",
            "dropout": null,
            "unk_token": "<unk>",
            "continuing_subword_prefix": null,
            "end_of_word_suffix": null,
            "fuse_unk": true,
            "byte_fallback": true,
            "ignore_merges": false,
            "vocab": Value::Object(vocab),
            "merges": merges
        }
    });
    Ok(serde_json::to_vec(&root)?)
}

fn metadata_array<'a>(gguf: &'a Gguf, key: &str) -> Result<&'a [GgufValue], TokenizerError> {
    gguf.metadata_value(key)
        .and_then(GgufValue::as_array)
        .ok_or_else(|| TokenizerError::Metadata(key.to_owned()))
}

fn metadata_string<'a>(gguf: &'a Gguf, key: &str) -> Result<&'a str, TokenizerError> {
    gguf.metadata_value(key)
        .and_then(GgufValue::as_str)
        .ok_or_else(|| TokenizerError::Metadata(key.to_owned()))
}

fn metadata_u32(gguf: &Gguf, key: &str) -> Result<u32, TokenizerError> {
    gguf.metadata_value(key)
        .and_then(GgufValue::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| TokenizerError::Metadata(key.to_owned()))
}
