//! Burn-hosted Gemma 4 E2B decode using packed GGUF weights and native Metal GEMV.

use std::{collections::HashMap, path::Path};

use burn::{
    backend::Metal,
    tensor::{DType, Int, Tensor, TensorData, TensorPrimitive, activation, backend::BackendTypes},
};
use half::f16;
use quixi_chat_kernels::{
    metal::{
        ComputeClient, GegluPlan, PackedMetalMatrix, RmsNormPlan, RopePlan, RopeTables,
        WgpuRuntime, dequant_gather_matrix, geglu_f32, q6_k_argmax_f32, qgemv_f32, rms_norm_f32,
        rope_f32,
    },
    quant::QuantFormat,
};
use thiserror::Error;

use crate::{
    cache::{CacheError, CachePlan, LayerCacheMode, LayerKvCache},
    gguf::{Gguf, GgufError},
    model::{ArchitectureError, AttentionKind, Gemma4Config, LayerSpec},
    tokenizer::{Gemma4Tokenizer, TokenizerError},
};

#[derive(Debug, Error)]
pub enum QuantModelError {
    #[error(transparent)]
    Gguf(#[from] GgufError),
    #[error(transparent)]
    Architecture(#[from] ArchitectureError),
    #[error(transparent)]
    Tokenizer(#[from] TokenizerError),
    #[error(transparent)]
    Cache(#[from] CacheError),
    #[error("tensor {name:?} cannot be loaded as {expected}")]
    Tensor {
        name: String,
        expected: &'static str,
    },
    #[error("prompt is empty")]
    EmptyPrompt,
    #[error("context limit {limit} exceeded at position {position}")]
    Context { limit: usize, position: usize },
}

struct QuantLinear {
    weight: PackedMetalMatrix,
}

impl QuantLinear {
    fn forward(
        &self,
        input: Tensor<Metal, 1>,
        device: &<Metal as BackendTypes>::Device,
    ) -> Tensor<Metal, 1> {
        assert_eq!(input.dims()[0], self.weight.columns());
        // `zeros` would dispatch a fill kernel that the GEMV overwrites in full.
        let output = Tensor::<Metal, 1>::empty([self.weight.rows()], device);
        let TensorPrimitive::Float(input) = input.into_primitive() else {
            panic!("quantized linear input must be a float tensor")
        };
        let TensorPrimitive::Float(output) = output.into_primitive() else {
            panic!("quantized linear output must be a float tensor")
        };
        Tensor::from_primitive(TensorPrimitive::Float(qgemv_f32(
            &self.weight,
            input,
            output,
        )))
    }
}

struct QuantAttention {
    q: QuantLinear,
    k: Option<QuantLinear>,
    v: Option<QuantLinear>,
    output: QuantLinear,
    q_norm: Tensor<Metal, 1>,
    k_norm: Option<Tensor<Metal, 1>>,
}

struct QuantLayer {
    spec: LayerSpec,
    attention: QuantAttention,
    input_norm: Tensor<Metal, 1>,
    post_attention_norm: Tensor<Metal, 1>,
    pre_ffn_norm: Tensor<Metal, 1>,
    post_ffn_norm: Tensor<Metal, 1>,
    post_ple_norm: Tensor<Metal, 1>,
    /// `ffn_gate` and `ffn_up` stacked into one matrix; see `load_packed_pair`.
    ffn_gate_up: QuantLinear,
    ffn_down: QuantLinear,
    ple_gate: QuantLinear,
    ple_projection: QuantLinear,
    layer_scalar: f32,
}

pub struct QuantGenerationState {
    caches: Vec<Option<LayerKvCache<Metal>>>,
    shared_local: Option<(Tensor<Metal, 4>, Tensor<Metal, 4>)>,
    shared_global: Option<(Tensor<Metal, 4>, Tensor<Metal, 4>)>,
    position: usize,
}

impl QuantGenerationState {
    #[must_use]
    pub const fn position(&self) -> usize {
        self.position
    }
}

/// Text-only Gemma 4 E2B QAT model. Burn owns activations/cache; packed weights stay opaque.
pub struct Gemma4QuantizedMetal {
    config: Gemma4Config,
    tokenizer: Gemma4Tokenizer,
    token_embedding: PackedMetalMatrix,
    ple_embedding: PackedMetalMatrix,
    ple_model_projection: Tensor<Metal, 2>,
    ple_projection_norm: Tensor<Metal, 1>,
    layers: Vec<QuantLayer>,
    output_norm: Tensor<Metal, 1>,
    local_cos: Tensor<Metal, 2>,
    local_sin: Tensor<Metal, 2>,
    global_cos: Tensor<Metal, 2>,
    global_sin: Tensor<Metal, 2>,
    local_producer: usize,
    global_producer: usize,
    context_limit: usize,
    device: <Metal as BackendTypes>::Device,
    /// One parameter buffer per distinct norm shape, built at load so the hot
    /// path allocates nothing. The set is tiny: hidden width, the two head
    /// widths weighted and unweighted, and the PLE projection.
    norm_plans: HashMap<(usize, usize, bool, bool), RmsNormPlan>,
    rope_plans: HashMap<(usize, usize), RopePlan>,
    geglu_plans: HashMap<usize, GegluPlan>,
    client: ComputeClient<WgpuRuntime>,
}

impl Gemma4QuantizedMetal {
    /// Fused RMSNorm over `rows` rows of `dim`, optionally scaled by `weight`.
    ///
    /// Replaces a six-dispatch framework expression. `weight` is bound even when
    /// unweighted — the kernel ignores it — so callers pass the input itself.
    /// Fused `gelu(gate) * up` over the stacked projection output.
    fn geglu(&self, gate_up: Tensor<Metal, 1>, width: usize) -> Tensor<Metal, 1> {
        let plan = self
            .geglu_plans
            .get(&width)
            .expect("every FFN width is planned at load");
        let output = Tensor::<Metal, 1>::empty([width], &self.device);
        let TensorPrimitive::Float(input_p) = gate_up.into_primitive() else {
            panic!("geglu input must be a float tensor")
        };
        let TensorPrimitive::Float(output_p) = output.into_primitive() else {
            panic!("geglu output must be a float tensor")
        };
        let result = geglu_f32(plan, &self.client, output_p, &input_p);
        Tensor::from_primitive(TensorPrimitive::Float(result))
    }

    fn norm<const D: usize>(
        &self,
        input: Tensor<Metal, D>,
        weight: Option<&Tensor<Metal, 1>>,
        rows: usize,
        dim: usize,
    ) -> Tensor<Metal, D> {
        self.norm_inner(input, weight, None, rows, dim)
    }

    /// `residual + norm(input) * weight` in one launch.
    fn norm_residual(
        &self,
        input: Tensor<Metal, 1>,
        weight: &Tensor<Metal, 1>,
        residual: Tensor<Metal, 1>,
        dim: usize,
    ) -> Tensor<Metal, 1> {
        self.norm_inner(input, Some(weight), Some(residual), 1, dim)
    }

    fn norm_inner<const D: usize>(
        &self,
        input: Tensor<Metal, D>,
        weight: Option<&Tensor<Metal, 1>>,
        residual: Option<Tensor<Metal, D>>,
        rows: usize,
        dim: usize,
    ) -> Tensor<Metal, D> {
        let plan = self
            .norm_plans
            .get(&(rows, dim, weight.is_some(), residual.is_some()))
            .expect("every norm shape is planned at load");
        let shape = input.shape();
        let output = Tensor::<Metal, D>::empty(shape, &self.device);

        let TensorPrimitive::Float(input_p) = input.into_primitive() else {
            panic!("norm input must be a float tensor")
        };
        let TensorPrimitive::Float(output_p) = output.into_primitive() else {
            panic!("norm output must be a float tensor")
        };
        let weight_p = weight.map(|weight| match weight.clone().into_primitive() {
            TensorPrimitive::Float(handle) => handle,
            TensorPrimitive::QFloat(_) => panic!("norm weight must be a float tensor"),
        });

        let residual_p = residual.map(|residual| match residual.into_primitive() {
            TensorPrimitive::Float(handle) => handle,
            TensorPrimitive::QFloat(_) => panic!("norm residual must be a float tensor"),
        });

        let weight_bound = weight_p.as_ref().unwrap_or(&input_p);
        let residual_bound = residual_p.as_ref().unwrap_or(&input_p);
        let result = rms_norm_f32(
            plan,
            &self.client,
            output_p,
            &input_p,
            weight_bound,
            residual_bound,
        );
        Tensor::from_primitive(TensorPrimitive::Float(result))
    }
}

impl Gemma4QuantizedMetal {
    pub fn load(path: impl AsRef<Path>, context_limit: usize) -> Result<Self, QuantModelError> {
        let gguf = Gguf::open(path)?;
        let config = Gemma4Config::from_gguf(&gguf)?;
        config.validate_tensor_contract(&gguf)?;
        let tokenizer = Gemma4Tokenizer::from_gguf(&gguf)?;
        let context_limit = context_limit.min(config.max_position_embeddings).max(1);
        let device = Default::default();
        let reference = Tensor::<Metal, 1>::zeros([1], &device);
        let TensorPrimitive::Float(reference) = reference.into_primitive() else {
            panic!("Metal reference must be a float primitive")
        };

        let token_embedding = load_packed(&gguf, "token_embd.weight", &reference)?;
        let ple_embedding = load_packed(&gguf, "per_layer_token_embd.weight", &reference)?;
        let ple_model_projection = load_f16_matrix(&gguf, "per_layer_model_proj.weight", &device)?;
        let ple_projection_norm = load_f32_vector(&gguf, "per_layer_proj_norm.weight", &device)?;
        let output_norm = load_f32_vector(&gguf, "output_norm.weight", &device)?;

        let mut layers = Vec::with_capacity(config.num_hidden_layers);
        for spec in &config.layers {
            let prefix = format!("blk.{}", spec.index);
            layers.push(QuantLayer {
                spec: spec.clone(),
                attention: QuantAttention {
                    q: load_linear(&gguf, &format!("{prefix}.attn_q.weight"), &reference)?,
                    k: spec
                        .owns_kv
                        .then(|| load_linear(&gguf, &format!("{prefix}.attn_k.weight"), &reference))
                        .transpose()?,
                    v: spec
                        .owns_kv
                        .then(|| load_linear(&gguf, &format!("{prefix}.attn_v.weight"), &reference))
                        .transpose()?,
                    output: load_linear(
                        &gguf,
                        &format!("{prefix}.attn_output.weight"),
                        &reference,
                    )?,
                    q_norm: load_f32_vector(
                        &gguf,
                        &format!("{prefix}.attn_q_norm.weight"),
                        &device,
                    )?,
                    k_norm: spec
                        .owns_kv
                        .then(|| {
                            load_f32_vector(&gguf, &format!("{prefix}.attn_k_norm.weight"), &device)
                        })
                        .transpose()?,
                },
                input_norm: load_f32_vector(&gguf, &format!("{prefix}.attn_norm.weight"), &device)?,
                post_attention_norm: load_f32_vector(
                    &gguf,
                    &format!("{prefix}.post_attention_norm.weight"),
                    &device,
                )?,
                pre_ffn_norm: load_f32_vector(
                    &gguf,
                    &format!("{prefix}.ffn_norm.weight"),
                    &device,
                )?,
                post_ffn_norm: load_f32_vector(
                    &gguf,
                    &format!("{prefix}.post_ffw_norm.weight"),
                    &device,
                )?,
                post_ple_norm: load_f32_vector(
                    &gguf,
                    &format!("{prefix}.post_norm.weight"),
                    &device,
                )?,
                ffn_gate_up: QuantLinear {
                    weight: load_packed_pair(
                        &gguf,
                        &format!("{prefix}.ffn_gate.weight"),
                        &format!("{prefix}.ffn_up.weight"),
                        &reference,
                    )?,
                },
                ffn_down: load_linear(&gguf, &format!("{prefix}.ffn_down.weight"), &reference)?,
                ple_gate: load_linear(&gguf, &format!("{prefix}.inp_gate.weight"), &reference)?,
                ple_projection: load_linear(&gguf, &format!("{prefix}.proj.weight"), &reference)?,
                layer_scalar: load_f32_vector_values(
                    &gguf,
                    &format!("{prefix}.layer_output_scale.weight"),
                )?[0],
            });
        }

        let first_shared = config.num_hidden_layers - config.num_kv_shared_layers;
        let local_producer = config.layers[..first_shared]
            .iter()
            .rposition(|layer| layer.attention == AttentionKind::Local)
            .expect("validated E2B has a local producer");
        let global_producer = config.layers[..first_shared]
            .iter()
            .rposition(|layer| layer.attention == AttentionKind::Global)
            .expect("validated E2B has a global producer");
        let (local_cos, local_sin) = rope_table(
            context_limit,
            config.local_head_dim,
            config.local_rope_theta,
            1.0,
            &device,
        );
        let (global_cos, global_sin) = rope_table(
            context_limit,
            config.global_head_dim,
            config.global_rope_theta,
            config.global_partial_rotary_factor,
            &device,
        );

        // One parameter buffer per distinct norm shape. Enumerated rather than
        // discovered so a missing plan is a panic at load, not mid-generation.
        let client = reference.client.clone();
        let eps = config.rms_norm_eps;
        let mut norm_plans = HashMap::new();
        let mut plan = |rows: usize, dim: usize, weighted: bool, residual: bool| {
            norm_plans
                .entry((rows, dim, weighted, residual))
                .or_insert_with(|| RmsNormPlan::new(&client, rows, dim, weighted, residual, eps));
        };
        plan(1, config.hidden_size, true, false);
        plan(1, config.hidden_size, true, true);
        let mut rope_plans = HashMap::new();
        {
            let mut rope_plan = |rows: usize, dim: usize| {
                rope_plans
                    .entry((rows, dim))
                    .or_insert_with(|| RopePlan::new(&client, rows, dim));
            };
            for spec in &config.layers {
                rope_plan(config.num_attention_heads, spec.head_dim);
                rope_plan(1, spec.head_dim);
            }
        }
        let mut geglu_plans = HashMap::new();
        for spec in &config.layers {
            let width = spec.feed_forward_size;
            geglu_plans
                .entry(width)
                .or_insert_with(|| GegluPlan::new(&client, width));
        }
        plan(config.num_hidden_layers, config.ple_dim, true, false);
        for spec in &config.layers {
            plan(config.num_attention_heads, spec.head_dim, true, false);
            plan(1, spec.head_dim, true, false);
            plan(1, spec.head_dim, false, false);
        }

        Ok(Self {
            config,
            tokenizer,
            token_embedding,
            ple_embedding,
            ple_model_projection,
            ple_projection_norm,
            layers,
            output_norm,
            local_cos,
            local_sin,
            global_cos,
            global_sin,
            local_producer,
            global_producer,
            context_limit,
            device,
            norm_plans,
            rope_plans,
            geglu_plans,
            client,
        })
    }

    #[must_use]
    pub fn config(&self) -> &Gemma4Config {
        &self.config
    }

    #[must_use]
    pub const fn context_limit(&self) -> usize {
        self.context_limit
    }

    #[must_use]
    pub fn tokenizer(&self) -> &Gemma4Tokenizer {
        &self.tokenizer
    }

    pub fn new_state(&self) -> Result<QuantGenerationState, QuantModelError> {
        let plan = CachePlan::for_config(&self.config, self.context_limit);
        let caches = plan
            .layers
            .into_iter()
            .zip(&self.config.layers)
            .map(|(mode, layer)| match mode {
                LayerCacheMode::Shared { .. } => Ok(None),
                mode => LayerKvCache::new(mode, 1, 1, layer.head_dim, &self.device).map(Some),
            })
            .collect::<Result<Vec<_>, CacheError>>()?;
        Ok(QuantGenerationState {
            caches,
            shared_local: None,
            shared_global: None,
            position: 0,
        })
    }

    /// Consume one token and return its next-token logits.
    pub fn forward_token(
        &self,
        token_id: u32,
        state: &mut QuantGenerationState,
    ) -> Result<Tensor<Metal, 1>, QuantModelError> {
        let hidden = self.forward_hidden(token_id, state)?;
        let logits = self.token_embedding_matvec(hidden);
        Ok(
            (logits.clone() / self.config.final_logit_softcap as f64).tanh()
                * self.config.final_logit_softcap as f64,
        )
    }

    /// Consume a prompt token without evaluating the unused tied vocabulary head.
    pub fn consume_token(
        &self,
        token_id: u32,
        state: &mut QuantGenerationState,
    ) -> Result<(), QuantModelError> {
        drop(self.forward_hidden(token_id, state)?);
        Ok(())
    }

    /// One greedy decode step that never leaves the GPU.
    ///
    /// Chaining the argmax result into the next step's embedding lookup lets a
    /// caller batch the device-to-host reads instead of stalling every step.
    /// Measured worth +2.8% decode on its own — but batching means speculating
    /// past the stop token, which leaves the KV cache ahead of the recorded
    /// token stream and breaks the cross-turn prefix reuse in `ChatEngine`,
    /// which is worth far more. Wiring this up needs a cache that can rewind by
    /// up to one batch; until then `reply` reads every step.
    pub fn forward_token_greedy_device(
        &self,
        ids: &Tensor<Metal, 1, Int>,
        state: &mut QuantGenerationState,
    ) -> Result<Tensor<Metal, 1, Int>, QuantModelError> {
        let hidden = self.forward_hidden_ids(ids, state)?;
        Ok(self.token_embedding_argmax_device(hidden))
    }

    /// Wrap a host token id for `forward_token_greedy_device`.
    #[must_use]
    pub fn device_token(&self, token_id: u32) -> Tensor<Metal, 1, Int> {
        Tensor::<Metal, 1, Int>::from_data(
            TensorData::new(vec![token_id as i32], [1]),
            &self.device,
        )
    }

    /// Consume one token and select the next token in the fused Q6_K head.
    pub fn forward_token_greedy(
        &self,
        token_id: u32,
        state: &mut QuantGenerationState,
    ) -> Result<u32, QuantModelError> {
        let hidden = self.forward_hidden(token_id, state)?;
        Ok(self.token_embedding_argmax(hidden))
    }

    fn forward_hidden(
        &self,
        token_id: u32,
        state: &mut QuantGenerationState,
    ) -> Result<Tensor<Metal, 1>, QuantModelError> {
        let ids = Tensor::<Metal, 1, Int>::from_data(
            TensorData::new(vec![token_id as i32], [1]),
            &self.device,
        );
        self.forward_hidden_ids(&ids, state)
    }

    fn forward_hidden_ids(
        &self,
        ids: &Tensor<Metal, 1, Int>,
        state: &mut QuantGenerationState,
    ) -> Result<Tensor<Metal, 1>, QuantModelError> {
        if state.position >= self.context_limit {
            return Err(QuantModelError::Context {
                limit: self.context_limit,
                position: state.position,
            });
        }
        let mut hidden = self.gather_ids(
            &self.token_embedding,
            ids,
            (self.config.hidden_size as f32).sqrt(),
        );
        let token_ple = self.gather_ids(
            &self.ple_embedding,
            ids,
            (self.config.ple_dim as f32).sqrt(),
        );
        let projected_ple = self
            .ple_model_projection
            .clone()
            .matmul(hidden.clone().reshape([self.config.hidden_size, 1]))
            .reshape([self.config.num_hidden_layers, self.config.ple_dim])
            * (self.config.hidden_size as f64).sqrt().recip();
        let projected_ple = self.norm(
            projected_ple,
            Some(&self.ple_projection_norm),
            self.config.num_hidden_layers,
            self.config.ple_dim,
        );
        let all_ple = (projected_ple
            + token_ple.reshape([self.config.num_hidden_layers, self.config.ple_dim]))
            * std::f64::consts::FRAC_1_SQRT_2;

        state.shared_local = None;
        state.shared_global = None;
        for (index, layer) in self.layers.iter().enumerate() {
            let ple = all_ple
                .clone()
                .slice([index..index + 1, 0..self.config.ple_dim])
                .reshape([self.config.ple_dim]);
            hidden = self.forward_layer(layer, hidden, ple, state)?;
        }
        state.position += 1;
        Ok(self.norm(hidden, Some(&self.output_norm), 1, self.config.hidden_size))
    }

    pub fn greedy_next(logits: Tensor<Metal, 1>) -> u32 {
        let value = logits
            .argmax(0)
            .to_data()
            .convert::<i64>()
            .to_vec::<i64>()
            .expect("argmax must return an integer")[0];
        u32::try_from(value).expect("Gemma token id must fit u32")
    }

    pub fn generate_ids(
        &self,
        prompt: &[u32],
        max_new_tokens: usize,
    ) -> Result<Vec<u32>, QuantModelError> {
        if prompt.is_empty() {
            return Err(QuantModelError::EmptyPrompt);
        }
        let mut state = self.new_state()?;
        for &token in &prompt[..prompt.len() - 1] {
            self.consume_token(token, &mut state)?;
        }
        let mut next = self.forward_token_greedy(prompt[prompt.len() - 1], &mut state)?;
        let mut generated = Vec::new();
        for _ in 0..max_new_tokens {
            generated.push(next);
            if next == self.tokenizer.eos_token_id {
                break;
            }
            next = self.forward_token_greedy(next, &mut state)?;
        }
        Ok(generated)
    }

    fn forward_layer(
        &self,
        layer: &QuantLayer,
        hidden: Tensor<Metal, 1>,
        ple: Tensor<Metal, 1>,
        state: &mut QuantGenerationState,
    ) -> Result<Tensor<Metal, 1>, QuantModelError> {
        let residual = hidden.clone();
        let normalized = self.norm(hidden, Some(&layer.input_norm), 1, self.config.hidden_size);
        let query = layer
            .attention
            .q
            .forward(normalized.clone(), &self.device)
            .reshape([self.config.num_attention_heads, layer.spec.head_dim]);
        let query = self.norm(
            query,
            Some(&layer.attention.q_norm),
            self.config.num_attention_heads,
            layer.spec.head_dim,
        );
        let query = self.apply_rope(query, layer.spec.attention, state.position);

        let (keys, values) = if layer.spec.owns_kv {
            let key = layer
                .attention
                .k
                .as_ref()
                .expect("owned layer has K")
                .forward(normalized.clone(), &self.device)
                .reshape([1, layer.spec.head_dim]);
            let key = self.norm(
                key,
                Some(
                    layer
                        .attention
                        .k_norm
                        .as_ref()
                        .expect("owned layer has K norm"),
                ),
                1,
                layer.spec.head_dim,
            );
            let key = self
                .apply_rope(key, layer.spec.attention, state.position)
                .reshape([1, 1, 1, layer.spec.head_dim]);
            let value = layer
                .attention
                .v
                .as_ref()
                .expect("owned layer has V")
                .forward(normalized, &self.device)
                .reshape([1, layer.spec.head_dim]);
            let value = self.norm(value, None, 1, layer.spec.head_dim).reshape([
                1,
                1,
                1,
                layer.spec.head_dim,
            ]);
            let cache = state.caches[layer.spec.index]
                .as_mut()
                .expect("owned layer has cache");
            let kv = cache.push(key, value)?;
            if layer.spec.index == self.local_producer {
                state.shared_local = Some((kv.0.clone(), kv.1.clone()));
            }
            if layer.spec.index == self.global_producer {
                state.shared_global = Some((kv.0.clone(), kv.1.clone()));
            }
            kv
        } else {
            match layer.spec.attention {
                AttentionKind::Local => state
                    .shared_local
                    .as_ref()
                    .expect("local shared KV producer runs first")
                    .clone(),
                AttentionKind::Global => state
                    .shared_global
                    .as_ref()
                    .expect("global shared KV producer runs first")
                    .clone(),
            }
        };

        let query = query.reshape([1, self.config.num_attention_heads, 1, layer.spec.head_dim]);
        let keys = keys.repeat_dim(1, self.config.num_attention_heads);
        let values = values.repeat_dim(1, self.config.num_attention_heads);
        let scores = query.matmul(keys.swap_dims(2, 3));
        let attention = activation::softmax(scores, 3);
        let attended = attention
            .matmul(values)
            .reshape([self.config.num_attention_heads * layer.spec.head_dim]);
        let attention_output = layer.attention.output.forward(attended, &self.device);
        let hidden = self.norm_residual(
            attention_output,
            &layer.post_attention_norm,
            residual,
            self.config.hidden_size,
        );

        let residual = hidden.clone();
        let ffn_input = self.norm(
            hidden,
            Some(&layer.pre_ffn_norm),
            1,
            self.config.hidden_size,
        );
        // One launch produces gate and up stacked, one more applies GeGLU
        // straight out of that buffer — no slicing, no intermediate copies.
        let width = layer.ffn_gate_up.weight.rows() / 2;
        let gate_up = layer.ffn_gate_up.forward(ffn_input, &self.device);
        let ffn = layer
            .ffn_down
            .forward(self.geglu(gate_up, width), &self.device);
        let hidden =
            self.norm_residual(ffn, &layer.post_ffn_norm, residual, self.config.hidden_size);

        let residual = hidden.clone();
        let ple_gate = activation::gelu_approximate(layer.ple_gate.forward(hidden, &self.device));
        let ple_hidden = layer.ple_projection.forward(ple_gate * ple, &self.device);
        let hidden = residual
            + self.norm(
                ple_hidden,
                Some(&layer.post_ple_norm),
                1,
                self.config.hidden_size,
            );
        Ok(hidden * layer.layer_scalar as f64)
    }

    /// Gather using an id that is already on the device.
    ///
    /// This is what lets greedy decode stay on the GPU: the argmax writes its
    /// result to a device tensor and the next step's embedding lookup reads it
    /// directly, so no step has to stall on a device-to-host copy.
    fn gather_ids(
        &self,
        table: &PackedMetalMatrix,
        ids: &Tensor<Metal, 1, Int>,
        scale: f32,
    ) -> Tensor<Metal, 1> {
        let ids = ids.clone();
        let output = Tensor::<Metal, 2>::zeros([1, table.columns()], &self.device).cast(DType::F16);
        let ids = ids.into_primitive();
        let TensorPrimitive::Float(output) = output.into_primitive() else {
            panic!("embedding output must be a float primitive")
        };
        Tensor::<Metal, 2>::from_primitive(TensorPrimitive::Float(dequant_gather_matrix(
            table, ids, output, scale,
        )))
        .cast(DType::F32)
        .reshape([table.columns()])
    }

    fn token_embedding_matvec(&self, hidden: Tensor<Metal, 1>) -> Tensor<Metal, 1> {
        let output = Tensor::<Metal, 1>::zeros([self.config.vocab_size], &self.device);
        let TensorPrimitive::Float(hidden) = hidden.into_primitive() else {
            panic!("LM head input must be a float primitive")
        };
        let TensorPrimitive::Float(output) = output.into_primitive() else {
            panic!("LM head output must be a float primitive")
        };
        Tensor::from_primitive(TensorPrimitive::Float(qgemv_f32(
            &self.token_embedding,
            hidden,
            output,
        )))
    }

    fn token_embedding_argmax(&self, hidden: Tensor<Metal, 1>) -> u32 {
        let token = self.token_embedding_argmax_device(hidden);
        let token = token
            .to_data()
            .to_vec::<i32>()
            .expect("argmax output must be i32")[0];
        u32::try_from(token).expect("Gemma token id must fit u32")
    }

    /// Argmax over the tied embedding, leaving the winning id on the device.
    fn token_embedding_argmax_device(&self, hidden: Tensor<Metal, 1>) -> Tensor<Metal, 1, Int> {
        let tiles = self.token_embedding.rows().div_ceil(1_024);
        let partial_values = Tensor::<Metal, 1>::zeros([tiles], &self.device);
        let partial_ids = Tensor::<Metal, 1, Int>::zeros([tiles], &self.device);
        let output = Tensor::<Metal, 1, Int>::zeros([1], &self.device);
        let TensorPrimitive::Float(hidden) = hidden.into_primitive() else {
            panic!("LM head input must be a float primitive")
        };
        let TensorPrimitive::Float(partial_values) = partial_values.into_primitive() else {
            panic!("LM head partials must be float primitives")
        };
        let partial_ids = partial_ids.into_primitive();
        let output = output.into_primitive();
        let output = q6_k_argmax_f32(
            &self.token_embedding,
            hidden,
            partial_values,
            partial_ids,
            output,
        );
        Tensor::<Metal, 1, Int>::from_primitive(output)
    }

    fn apply_rope(
        &self,
        input: Tensor<Metal, 2>,
        kind: AttentionKind,
        position: usize,
    ) -> Tensor<Metal, 2> {
        let (cos, sin, dim) = match kind {
            AttentionKind::Local => (
                self.local_cos.clone(),
                self.local_sin.clone(),
                self.config.local_head_dim,
            ),
            AttentionKind::Global => (
                self.global_cos.clone(),
                self.global_sin.clone(),
                self.config.global_head_dim,
            ),
        };
        let rows = input.dims()[0];
        let plan = self
            .rope_plans
            .get(&(rows, dim))
            .expect("every rope shape is planned at load");
        let output = Tensor::<Metal, 2>::empty(input.shape(), &self.device);

        let TensorPrimitive::Float(input_p) = input.into_primitive() else {
            panic!("rope input must be a float tensor")
        };
        let TensorPrimitive::Float(output_p) = output.into_primitive() else {
            panic!("rope output must be a float tensor")
        };
        let TensorPrimitive::Float(cos_p) = cos.into_primitive() else {
            panic!("rope cos table must be a float tensor")
        };
        let TensorPrimitive::Float(sin_p) = sin.into_primitive() else {
            panic!("rope sin table must be a float tensor")
        };

        let result = rope_f32(
            plan,
            &self.client,
            output_p,
            &input_p,
            &RopeTables {
                cos: &cos_p,
                sin: &sin_p,
                position,
                dim,
            },
        );
        Tensor::from_primitive(TensorPrimitive::Float(result))
    }
}

fn rope_table(
    context: usize,
    head_dim: usize,
    theta: f32,
    rotary_factor: f32,
    device: &<Metal as BackendTypes>::Device,
) -> (Tensor<Metal, 2>, Tensor<Metal, 2>) {
    let half = head_dim / 2;
    let rotary_angles = (rotary_factor * head_dim as f32 / 2.0) as usize;
    let mut cos = Vec::with_capacity(context * head_dim);
    let mut sin = Vec::with_capacity(context * head_dim);
    for position in 0..context {
        let frequencies = (0..half)
            .map(|index| {
                if index < rotary_angles {
                    position as f32 / theta.powf((2 * index) as f32 / head_dim as f32)
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>();
        for repeat in 0..2 {
            let _ = repeat;
            cos.extend(frequencies.iter().map(|value| value.cos()));
            sin.extend(frequencies.iter().map(|value| value.sin()));
        }
    }
    (
        Tensor::from_data(TensorData::new(cos, [context, head_dim]), device),
        Tensor::from_data(TensorData::new(sin, [context, head_dim]), device),
    )
}

fn load_linear(
    gguf: &Gguf,
    name: &str,
    reference: &<Metal as BackendTypes>::FloatTensorPrimitive,
) -> Result<QuantLinear, QuantModelError> {
    Ok(QuantLinear {
        weight: load_packed(gguf, name, reference)?,
    })
}

/// Concatenate two row-major packed matrices into one.
///
/// `ffn_gate` and `ffn_up` read the same input and differ only in weights, so
/// they can be a single GEMV over a matrix of twice the rows. Packed rows are
/// contiguous, so stacking them is byte concatenation. This halves the number of
/// FFN launches and doubles the bytes each one streams, which is what the memory
/// system wants — the FFN is where most of the model's weights live.
fn load_packed_pair(
    gguf: &Gguf,
    first: &str,
    second: &str,
    reference: &<Metal as BackendTypes>::FloatTensorPrimitive,
) -> Result<PackedMetalMatrix, QuantModelError> {
    let (format_a, rows_a, columns_a, bytes_a) = packed_layout(gguf, first)?;
    let (format_b, rows_b, columns_b, bytes_b) = packed_layout(gguf, second)?;
    if format_a != format_b || columns_a != columns_b {
        return Err(QuantModelError::Tensor {
            name: format!("{first}+{second}"),
            expected: "matching packed format and column count",
        });
    }

    let mut packed = Vec::with_capacity(bytes_a.len() + bytes_b.len());
    packed.extend_from_slice(&bytes_a);
    packed.extend_from_slice(&bytes_b);

    Ok(PackedMetalMatrix::upload(
        reference,
        packed,
        format_a,
        rows_a + rows_b,
        columns_a,
    ))
}

fn packed_layout(
    gguf: &Gguf,
    name: &str,
) -> Result<(QuantFormat, usize, usize, Vec<u8>), QuantModelError> {
    let tensor = gguf
        .tensor(name)
        .ok_or_else(|| GgufError::MissingTensor(name.to_owned()))?;
    if tensor.shape.len() != 2 {
        return Err(QuantModelError::Tensor {
            name: name.to_owned(),
            expected: "rank-2 packed matrix",
        });
    }
    let format =
        QuantFormat::from_ggml_type(tensor.ggml_type).ok_or_else(|| QuantModelError::Tensor {
            name: name.to_owned(),
            expected: "Q4_0/Q6_K packed matrix",
        })?;
    let columns = usize::try_from(tensor.shape[0]).map_err(|_| QuantModelError::Tensor {
        name: name.to_owned(),
        expected: "usize matrix dimensions",
    })?;
    let rows = usize::try_from(tensor.shape[1]).map_err(|_| QuantModelError::Tensor {
        name: name.to_owned(),
        expected: "usize matrix dimensions",
    })?;
    let bytes = gguf
        .read_tensor_bytes(tensor)
        .map_err(QuantModelError::Gguf)?;
    Ok((format, rows, columns, bytes))
}

fn load_packed(
    gguf: &Gguf,
    name: &str,
    reference: &<Metal as BackendTypes>::FloatTensorPrimitive,
) -> Result<PackedMetalMatrix, QuantModelError> {
    let tensor = gguf
        .tensor(name)
        .ok_or_else(|| GgufError::MissingTensor(name.to_owned()))?;
    if tensor.shape.len() != 2 {
        return Err(QuantModelError::Tensor {
            name: name.to_owned(),
            expected: "rank-2 packed matrix",
        });
    }
    let format =
        QuantFormat::from_ggml_type(tensor.ggml_type).ok_or_else(|| QuantModelError::Tensor {
            name: name.to_owned(),
            expected: "Q4_0/Q6_K packed matrix",
        })?;
    let columns = usize::try_from(tensor.shape[0]).map_err(|_| QuantModelError::Tensor {
        name: name.to_owned(),
        expected: "usize matrix dimensions",
    })?;
    let rows = usize::try_from(tensor.shape[1]).map_err(|_| QuantModelError::Tensor {
        name: name.to_owned(),
        expected: "usize matrix dimensions",
    })?;
    Ok(PackedMetalMatrix::upload_file(
        reference,
        gguf.path(),
        tensor.bytes,
        tensor.absolute_offset(gguf),
        format,
        rows,
        columns,
    ))
}

fn load_f32_vector(
    gguf: &Gguf,
    name: &str,
    device: &<Metal as BackendTypes>::Device,
) -> Result<Tensor<Metal, 1>, QuantModelError> {
    let values = load_f32_vector_values(gguf, name)?;
    let length = values.len();
    Ok(Tensor::from_data(TensorData::new(values, [length]), device))
}

fn load_f32_vector_values(gguf: &Gguf, name: &str) -> Result<Vec<f32>, QuantModelError> {
    let tensor = gguf
        .tensor(name)
        .ok_or_else(|| GgufError::MissingTensor(name.to_owned()))?;
    if tensor.ggml_type != 0 || tensor.shape.len() != 1 {
        return Err(QuantModelError::Tensor {
            name: name.to_owned(),
            expected: "rank-1 F32",
        });
    }
    Ok(gguf
        .read_tensor(name)?
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
        .collect())
}

fn load_f16_matrix(
    gguf: &Gguf,
    name: &str,
    device: &<Metal as BackendTypes>::Device,
) -> Result<Tensor<Metal, 2>, QuantModelError> {
    let tensor = gguf
        .tensor(name)
        .ok_or_else(|| GgufError::MissingTensor(name.to_owned()))?;
    if tensor.ggml_type != 1 || tensor.shape.len() != 2 {
        return Err(QuantModelError::Tensor {
            name: name.to_owned(),
            expected: "rank-2 F16",
        });
    }
    let columns = usize::try_from(tensor.shape[0]).map_err(|_| QuantModelError::Tensor {
        name: name.to_owned(),
        expected: "usize matrix dimensions",
    })?;
    let rows = usize::try_from(tensor.shape[1]).map_err(|_| QuantModelError::Tensor {
        name: name.to_owned(),
        expected: "usize matrix dimensions",
    })?;
    let values = gguf
        .read_tensor(name)?
        .chunks_exact(2)
        .map(|bytes| f16::from_bits(u16::from_le_bytes([bytes[0], bytes[1]])).to_f32())
        .collect::<Vec<_>>();
    Ok(Tensor::from_data(
        TensorData::new(values, [rows, columns]),
        device,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proportional_rope_leaves_global_tail_unrotated() {
        let device = Default::default();
        let (cos, sin) = rope_table(2, 512, 1_000_000.0, 0.25, &device);
        let cos = cos.to_data().to_vec::<f32>().unwrap();
        let sin = sin.to_data().to_vec::<f32>().unwrap();
        assert_eq!(cos[512 + 64], 1.0);
        assert_eq!(sin[512 + 64], 0.0);
        assert_ne!(cos[512], 1.0);
        assert_eq!(cos[512], cos[512 + 256]);
    }

    #[test]
    #[ignore = "loads the staged 3.35 GB model and runs a full Metal decode step"]
    fn staged_model_loads_and_produces_finite_logits() {
        let model =
            Gemma4QuantizedMetal::load("../../models/gemma-4-E2B_q4_0-it.gguf", 32).unwrap();
        let mut state = model.new_state().unwrap();
        let logits = model.forward_token(2, &mut state).unwrap();
        assert_eq!(logits.dims(), [262_144]);
        assert_eq!(Gemma4QuantizedMetal::greedy_next(logits.clone()), 236_761);
        let values = logits.to_data().to_vec::<f32>().unwrap();
        assert!(values.iter().all(|value| value.is_finite()));
        assert_eq!(state.position(), 1);
    }

    #[test]
    #[ignore = "loads the staged model and runs eight greedy Metal decode steps"]
    fn staged_greedy_tokens_match_llama_cpp() {
        let model =
            Gemma4QuantizedMetal::load("../../models/gemma-4-E2B_q4_0-it.gguf", 32).unwrap();
        assert_eq!(
            model.generate_ids(&[2], 8).unwrap(),
            [
                236_761, 108, 1_408, 236_743, 244_549, 236_743, 236_770, 236_761
            ]
        );
    }
}
