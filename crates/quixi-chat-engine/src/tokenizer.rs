//! Offline Gemma 4 byte-fallback BPE, reconstructed from GGUF metadata.

use std::{collections::BTreeMap, path::Path};

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
    pub pad_token_id: u32,
    pub unknown_token_id: u32,
    pub add_bos_token: bool,
    pub chat_template: String,
}

impl Gemma4Tokenizer {
    pub fn from_gguf_path(path: impl AsRef<Path>) -> Result<Self, TokenizerError> {
        let gguf = Gguf::open(path)?;
        Self::from_gguf(&gguf)
    }

    pub fn from_gguf(gguf: &Gguf) -> Result<Self, TokenizerError> {
        let bytes = tokenizer_json(gguf)?;
        let inner = Tokenizer::from_bytes(&bytes)
            .map_err(|error| TokenizerError::Tokenizers(error.to_string()))?;
        Ok(Self {
            inner,
            bos_token_id: metadata_u32(gguf, "tokenizer.ggml.bos_token_id")?,
            eos_token_id: metadata_u32(gguf, "tokenizer.ggml.eos_token_id")?,
            pad_token_id: metadata_u32(gguf, "tokenizer.ggml.padding_token_id")?,
            unknown_token_id: metadata_u32(gguf, "tokenizer.ggml.unknown_token_id")?,
            add_bos_token: metadata_bool(gguf, "tokenizer.ggml.add_bos_token")?,
            chat_template: metadata_string(gguf, "tokenizer.chat_template")?.to_owned(),
        })
    }

    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, TokenizerError> {
        let inner = Tokenizer::from_bytes(bytes)
            .map_err(|error| TokenizerError::Tokenizers(error.to_string()))?;
        Ok(Self {
            inner,
            bos_token_id: 2,
            eos_token_id: 1,
            pad_token_id: 0,
            unknown_token_id: 3,
            add_bos_token: true,
            chat_template: String::new(),
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

    /// Apply the text-only subset of Google's checked-in Gemma 4 chat template.
    #[must_use]
    pub fn format_chat(system: Option<&str>, user: &str) -> String {
        let mut prompt = String::from("<bos>");
        if let Some(system) = system {
            prompt.push_str("<|turn>system\n");
            prompt.push_str(system.trim());
            prompt.push_str("<turn|>\n");
        }
        prompt.push_str("<|turn>user\n");
        prompt.push_str(user.trim());
        prompt.push_str("<turn|>\n<|turn>model\n");
        prompt
    }

    pub fn encode_chat(
        &self,
        system: Option<&str>,
        user: &str,
    ) -> Result<Vec<u32>, TokenizerError> {
        self.encode(&Self::format_chat(system, user), false)
    }

    #[must_use]
    pub fn inner(&self) -> &Tokenizer {
        &self.inner
    }
}

/// Materialize a standard Hugging Face `tokenizer.json` from GGUF metadata.
pub fn tokenizer_json(gguf: &Gguf) -> Result<Vec<u8>, TokenizerError> {
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

fn metadata_bool(gguf: &Gguf, key: &str) -> Result<bool, TokenizerError> {
    gguf.metadata_value(key)
        .and_then(GgufValue::as_bool)
        .ok_or_else(|| TokenizerError::Metadata(key.to_owned()))
}

#[derive(Debug, serde::Serialize)]
pub struct TokenizerAudit {
    pub vocabulary: usize,
    pub merges: usize,
    pub special_tokens: BTreeMap<u32, String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_template_subset_has_exact_turn_boundaries() {
        assert_eq!(
            Gemma4Tokenizer::format_chat(Some(" system "), " aspirin "),
            "<bos><|turn>system\nsystem<turn|>\n<|turn>user\naspirin<turn|>\n<|turn>model\n"
        );
    }

    #[test]
    #[ignore = "requires the staged Gemma GGUF"]
    fn reconstructed_staged_tokenizer_round_trips_unicode_and_special_tokens() {
        let tokenizer =
            Gemma4Tokenizer::from_gguf_path("../../models/gemma-4-E2B_q4_0-it.gguf").unwrap();
        let text = "Aspirin (C₉H₈O₄) inhibits COX-1. 🧪";
        let ids = tokenizer.encode(text, true).unwrap();
        assert_eq!(ids[0], 2);
        assert_eq!(tokenizer.decode(&ids[1..], true).unwrap(), text);
        let chat = tokenizer
            .encode_chat(Some("Extract chemistry."), text)
            .unwrap();
        assert_eq!(chat[0], 2);
        assert!(chat.contains(&105));
        assert!(chat.contains(&106));

        // Frozen from llama.cpp over this exact staged GGUF.
        assert_eq!(
            tokenizer.encode("Aspirin inhibits COX-1.", true).unwrap(),
            [
                2, 236_776, 17_859, 495, 65_889, 117_012, 236_772, 236_770, 236_761,
            ]
        );
        assert_eq!(
            tokenizer
                .encode("Aspirin (C₉H₈O₄) inhibits COX-1. 🧪", true)
                .unwrap(),
            [
                2, 236_776, 17_859, 495, 568, 236_780, 464, 368, 375, 236_814, 464, 368, 374,
                236_806, 246_579, 236_768, 65_889, 117_012, 236_772, 236_770, 236_761, 236_743,
                251_646,
            ]
        );
        assert_eq!(
            tokenizer
                .encode_chat(Some("Extract chemistry."), "Aspirin inhibits COX-1.")
                .unwrap(),
            [
                2, 105, 9_731, 107, 82_138, 20_133, 236_761, 106, 107, 105, 2_364, 107, 236_776,
                17_859, 495, 65_889, 117_012, 236_772, 236_770, 236_761, 106, 107, 105, 4_368, 107,
            ]
        );
    }
}
