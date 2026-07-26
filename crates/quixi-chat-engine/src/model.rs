//! Pinned Gemma 4 E2B text configuration and exhaustive GGUF tensor contract.

use std::collections::BTreeSet;

use thiserror::Error;

use crate::gguf::{Gguf, GgufValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionKind {
    Local,
    Global,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LayerSpec {
    pub index: usize,
    pub attention: AttentionKind,
    pub head_dim: usize,
    pub feed_forward_size: usize,
    pub owns_kv: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Gemma4Config {
    pub vocab_size: usize,
    pub hidden_size: usize,
    pub num_hidden_layers: usize,
    pub num_attention_heads: usize,
    pub num_key_value_heads: usize,
    pub local_head_dim: usize,
    pub global_head_dim: usize,
    pub sliding_window: usize,
    pub max_position_embeddings: usize,
    pub ple_dim: usize,
    pub num_kv_shared_layers: usize,
    pub rms_norm_eps: f32,
    pub final_logit_softcap: f32,
    pub local_rope_theta: f32,
    pub global_rope_theta: f32,
    pub global_partial_rotary_factor: f32,
    pub layers: Vec<LayerSpec>,
}

#[derive(Debug, Error, PartialEq)]
pub enum ArchitectureError {
    #[error("GGUF architecture is {0:?}, expected gemma4")]
    Architecture(String),
    #[error("missing or invalid GGUF metadata {0:?}")]
    Metadata(String),
    #[error("metadata {key:?} has length {actual}, expected {expected}")]
    MetadataLength {
        key: String,
        actual: usize,
        expected: usize,
    },
    #[error("missing tensor {0:?}")]
    MissingTensor(String),
    #[error(
        "tensor {name:?} has shape/type {actual_shape:?}/{actual_type}, expected {expected_shape:?}/{expected_type}"
    )]
    Tensor {
        name: String,
        actual_shape: Vec<u64>,
        actual_type: u32,
        expected_shape: Vec<u64>,
        expected_type: u32,
    },
    #[error("GGUF has unexpected text tensors: {0:?}")]
    UnexpectedTensors(Vec<String>),
    #[error("E2B tensor/config invariant failed: {0}")]
    Invariant(String),
}

impl Gemma4Config {
    pub fn from_gguf(gguf: &Gguf) -> Result<Self, ArchitectureError> {
        let architecture = string(gguf, "general.architecture")?;
        if architecture != "gemma4" {
            return Err(ArchitectureError::Architecture(architecture.to_owned()));
        }
        let vocab_size = array(gguf, "tokenizer.ggml.tokens")?.len();
        let hidden_size = usize_value(gguf, "gemma4.embedding_length")?;
        let num_hidden_layers = usize_value(gguf, "gemma4.block_count")?;
        let num_attention_heads = usize_value(gguf, "gemma4.attention.head_count")?;
        let num_key_value_heads = usize_value(gguf, "gemma4.attention.head_count_kv")?;
        let local_head_dim = usize_value(gguf, "gemma4.attention.key_length_swa")?;
        let global_head_dim = usize_value(gguf, "gemma4.attention.key_length")?;
        let sliding_window = usize_value(gguf, "gemma4.attention.sliding_window")?;
        let max_position_embeddings = usize_value(gguf, "gemma4.context_length")?;
        let ple_dim = usize_value(gguf, "gemma4.embedding_length_per_layer_input")?;
        let num_kv_shared_layers = usize_value(gguf, "gemma4.attention.shared_kv_layers")?;
        let rms_norm_eps = f32_value(gguf, "gemma4.attention.layer_norm_rms_epsilon")?;
        let final_logit_softcap = f32_value(gguf, "gemma4.final_logit_softcapping")?;
        let local_rope_theta = f32_value(gguf, "gemma4.rope.freq_base_swa")?;
        let global_rope_theta = f32_value(gguf, "gemma4.rope.freq_base")?;
        let layer_pattern = array(gguf, "gemma4.attention.sliding_window_pattern")?;
        let feed_forward = array(gguf, "gemma4.feed_forward_length")?;
        for (key, values) in [
            ("gemma4.attention.sliding_window_pattern", layer_pattern),
            ("gemma4.feed_forward_length", feed_forward),
        ] {
            if values.len() != num_hidden_layers {
                return Err(ArchitectureError::MetadataLength {
                    key: key.to_owned(),
                    actual: values.len(),
                    expected: num_hidden_layers,
                });
            }
        }
        let first_shared = num_hidden_layers
            .checked_sub(num_kv_shared_layers)
            .ok_or_else(|| {
                ArchitectureError::Invariant("shared KV layer count exceeds layers".to_owned())
            })?;
        let layers = layer_pattern
            .iter()
            .zip(feed_forward)
            .enumerate()
            .map(|(index, (sliding, feed_forward))| {
                let attention = if sliding.as_bool().ok_or_else(|| {
                    ArchitectureError::Metadata(
                        "gemma4.attention.sliding_window_pattern".to_owned(),
                    )
                })? {
                    AttentionKind::Local
                } else {
                    AttentionKind::Global
                };
                let feed_forward_size = feed_forward
                    .as_i64()
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| {
                        ArchitectureError::Metadata("gemma4.feed_forward_length".to_owned())
                    })?;
                Ok(LayerSpec {
                    index,
                    attention,
                    head_dim: match attention {
                        AttentionKind::Local => local_head_dim,
                        AttentionKind::Global => global_head_dim,
                    },
                    feed_forward_size,
                    owns_kv: index < first_shared,
                })
            })
            .collect::<Result<Vec<_>, ArchitectureError>>()?;

        let config = Self {
            vocab_size,
            hidden_size,
            num_hidden_layers,
            num_attention_heads,
            num_key_value_heads,
            local_head_dim,
            global_head_dim,
            sliding_window,
            max_position_embeddings,
            ple_dim,
            num_kv_shared_layers,
            rms_norm_eps,
            final_logit_softcap,
            local_rope_theta,
            global_rope_theta,
            global_partial_rotary_factor: 0.25,
            layers,
        };
        config.validate_e2b_invariants()?;
        Ok(config)
    }

    fn validate_e2b_invariants(&self) -> Result<(), ArchitectureError> {
        let required = [
            (self.vocab_size == 262_144, "vocab must be 262144"),
            (self.hidden_size == 1_536, "hidden width must be 1536"),
            (self.num_hidden_layers == 35, "layer count must be 35"),
            (self.num_attention_heads == 8, "query head count must be 8"),
            (self.num_key_value_heads == 1, "KV head count must be 1"),
            (self.local_head_dim == 256, "local head width must be 256"),
            (self.global_head_dim == 512, "global head width must be 512"),
            (self.sliding_window == 512, "local window must be 512"),
            (self.ple_dim == 256, "PLE width must be 256"),
            (
                self.num_kv_shared_layers == 20,
                "shared KV layers must be 20",
            ),
        ];
        for (valid, message) in required {
            if !valid {
                return Err(ArchitectureError::Invariant(message.to_owned()));
            }
        }
        for layer in &self.layers {
            let expected_attention = if layer.index % 5 == 4 {
                AttentionKind::Global
            } else {
                AttentionKind::Local
            };
            let expected_ffn = if layer.index < 15 { 6_144 } else { 12_288 };
            if layer.attention != expected_attention
                || layer.feed_forward_size != expected_ffn
                || layer.owns_kv != (layer.index < 15)
            {
                return Err(ArchitectureError::Invariant(format!(
                    "layer {} pattern/FFN/KV ownership differs from E2B",
                    layer.index
                )));
            }
        }
        Ok(())
    }

    /// Require every staged text tensor to map to the pinned E2B forward pass.
    pub fn validate_tensor_contract(&self, gguf: &Gguf) -> Result<(), ArchitectureError> {
        let mut expected = BTreeSet::new();
        expect(
            gguf,
            &mut expected,
            "output_norm.weight",
            &[self.hidden_size],
            0,
        )?;
        expect(
            gguf,
            &mut expected,
            "per_layer_model_proj.weight",
            &[self.hidden_size, self.num_hidden_layers * self.ple_dim],
            1,
        )?;
        expect(
            gguf,
            &mut expected,
            "per_layer_proj_norm.weight",
            &[self.ple_dim],
            0,
        )?;
        expect(
            gguf,
            &mut expected,
            "per_layer_token_embd.weight",
            &[self.num_hidden_layers * self.ple_dim, self.vocab_size],
            14,
        )?;
        expect(
            gguf,
            &mut expected,
            "rope_freqs.weight",
            &[self.global_head_dim / 2],
            0,
        )?;
        expect(
            gguf,
            &mut expected,
            "token_embd.weight",
            &[self.hidden_size, self.vocab_size],
            14,
        )?;

        for layer in &self.layers {
            let prefix = format!("blk.{}", layer.index);
            let query_width = self.num_attention_heads * layer.head_dim;
            for (suffix, shape, ggml_type) in [
                ("attn_norm.weight", vec![self.hidden_size], 0),
                ("attn_output.weight", vec![query_width, self.hidden_size], 2),
                ("attn_q.weight", vec![self.hidden_size, query_width], 2),
                ("attn_q_norm.weight", vec![layer.head_dim], 0),
                (
                    "ffn_down.weight",
                    vec![layer.feed_forward_size, self.hidden_size],
                    2,
                ),
                (
                    "ffn_gate.weight",
                    vec![self.hidden_size, layer.feed_forward_size],
                    2,
                ),
                ("ffn_norm.weight", vec![self.hidden_size], 0),
                (
                    "ffn_up.weight",
                    vec![self.hidden_size, layer.feed_forward_size],
                    2,
                ),
                ("inp_gate.weight", vec![self.hidden_size, self.ple_dim], 2),
                ("layer_output_scale.weight", vec![1], 0),
                ("post_attention_norm.weight", vec![self.hidden_size], 0),
                ("post_ffw_norm.weight", vec![self.hidden_size], 0),
                ("post_norm.weight", vec![self.hidden_size], 0),
                ("proj.weight", vec![self.ple_dim, self.hidden_size], 2),
            ] {
                expect(
                    gguf,
                    &mut expected,
                    &format!("{prefix}.{suffix}"),
                    &shape,
                    ggml_type,
                )?;
            }
            if layer.owns_kv {
                for (suffix, shape, ggml_type) in [
                    ("attn_k.weight", vec![self.hidden_size, layer.head_dim], 2),
                    ("attn_k_norm.weight", vec![layer.head_dim], 0),
                    ("attn_v.weight", vec![self.hidden_size, layer.head_dim], 2),
                ] {
                    expect(
                        gguf,
                        &mut expected,
                        &format!("{prefix}.{suffix}"),
                        &shape,
                        ggml_type,
                    )?;
                }
            }
        }
        let actual = gguf.tensors.keys().cloned().collect::<BTreeSet<_>>();
        let unexpected = actual.difference(&expected).cloned().collect::<Vec<_>>();
        if !unexpected.is_empty() {
            return Err(ArchitectureError::UnexpectedTensors(unexpected));
        }
        Ok(())
    }
}

fn expect(
    gguf: &Gguf,
    expected: &mut BTreeSet<String>,
    name: &str,
    shape: &[usize],
    ggml_type: u32,
) -> Result<(), ArchitectureError> {
    expected.insert(name.to_owned());
    let tensor = gguf
        .tensor(name)
        .ok_or_else(|| ArchitectureError::MissingTensor(name.to_owned()))?;
    let expected_shape = shape.iter().map(|value| *value as u64).collect::<Vec<_>>();
    if tensor.shape != expected_shape || tensor.ggml_type != ggml_type {
        return Err(ArchitectureError::Tensor {
            name: name.to_owned(),
            actual_shape: tensor.shape.clone(),
            actual_type: tensor.ggml_type,
            expected_shape,
            expected_type: ggml_type,
        });
    }
    Ok(())
}

fn value<'a>(gguf: &'a Gguf, key: &str) -> Result<&'a GgufValue, ArchitectureError> {
    gguf.metadata_value(key)
        .ok_or_else(|| ArchitectureError::Metadata(key.to_owned()))
}

fn string<'a>(gguf: &'a Gguf, key: &str) -> Result<&'a str, ArchitectureError> {
    value(gguf, key)?
        .as_str()
        .ok_or_else(|| ArchitectureError::Metadata(key.to_owned()))
}

fn array<'a>(gguf: &'a Gguf, key: &str) -> Result<&'a [GgufValue], ArchitectureError> {
    value(gguf, key)?
        .as_array()
        .ok_or_else(|| ArchitectureError::Metadata(key.to_owned()))
}

fn usize_value(gguf: &Gguf, key: &str) -> Result<usize, ArchitectureError> {
    value(gguf, key)?
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| ArchitectureError::Metadata(key.to_owned()))
}

fn f32_value(gguf: &Gguf, key: &str) -> Result<f32, ArchitectureError> {
    value(gguf, key)?
        .as_f64()
        .map(|value| value as f32)
        .ok_or_else(|| ArchitectureError::Metadata(key.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires the staged Gemma GGUF"]
    fn staged_e2b_has_exhaustive_pinned_tensor_contract() {
        let gguf = Gguf::open("../../models/gemma-4-E2B_q4_0-it.gguf").unwrap();
        let config = Gemma4Config::from_gguf(&gguf).unwrap();
        config.validate_tensor_contract(&gguf).unwrap();
        assert_eq!(
            config.layers.iter().filter(|layer| layer.owns_kv).count(),
            15
        );
        assert_eq!(
            config
                .layers
                .iter()
                .filter(|layer| layer.attention == AttentionKind::Global)
                .map(|layer| layer.index)
                .collect::<Vec<_>>(),
            [4, 9, 14, 19, 24, 29, 34]
        );
        assert_eq!(config.layers[14].feed_forward_size, 6_144);
        assert_eq!(config.layers[15].feed_forward_size, 12_288);
    }

    #[cfg(feature = "metal-kernels")]
    #[test]
    #[ignore = "requires the staged Gemma GGUF and Apple Metal"]
    fn staged_q4_attention_projection_matches_native_metal() {
        use burn::{
            backend::Metal,
            tensor::{Tensor, TensorData, TensorPrimitive},
        };
        use quixi_chat_kernels::{
            metal::{PackedMetalMatrix, qgemv_f32},
            quant::{QuantFormat, dequantize_matvec},
        };

        let gguf = Gguf::open("../../models/gemma-4-E2B_q4_0-it.gguf").unwrap();
        let packed = gguf.read_tensor("blk.0.attn_q.weight").unwrap();
        let input_data = (0..1_536)
            .map(|index| (index as f32 * 0.013).sin() * 0.2)
            .collect::<Vec<_>>();
        let expected =
            dequantize_matvec(QuantFormat::Q4_0, &packed, 2_048, 1_536, &input_data).unwrap();
        let device = Default::default();
        let input = Tensor::<Metal, 1>::from_data(TensorData::new(input_data, [1_536]), &device);
        let output = Tensor::<Metal, 1>::zeros([2_048], &device);
        let TensorPrimitive::Float(input) = input.into_primitive() else {
            panic!("input must be f32")
        };
        let matrix = PackedMetalMatrix::upload(&input, packed, QuantFormat::Q4_0, 2_048, 1_536);
        let TensorPrimitive::Float(output) = output.into_primitive() else {
            panic!("output must be f32")
        };
        let actual = Tensor::<Metal, 1>::from_primitive(TensorPrimitive::Float(qgemv_f32(
            &matrix, input, output,
        )))
        .to_data()
        .to_vec::<f32>()
        .unwrap();
        let max_error = actual
            .iter()
            .zip(&expected)
            .map(|(actual, expected)| (actual - expected).abs())
            .fold(0.0_f32, f32::max);
        assert!(max_error <= 2e-5, "max error was {max_error}");
    }
}
