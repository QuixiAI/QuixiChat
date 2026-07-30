//! Hybrid local-ring/global KV cache for Gemma 4 decoding.

use burn::tensor::{Tensor, backend::Backend};
use thiserror::Error;

use crate::model::{AttentionKind, Gemma4Config};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerCacheMode {
    Local { window: usize },
    Global { capacity: usize },
    Shared { producer: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachePlan {
    pub layers: Vec<LayerCacheMode>,
}

impl CachePlan {
    #[must_use]
    pub fn for_config(config: &Gemma4Config, context_limit: usize) -> Self {
        let first_shared = config.num_hidden_layers - config.num_kv_shared_layers;
        let local_producer = config.layers[..first_shared]
            .iter()
            .rposition(|layer| layer.attention == AttentionKind::Local)
            .expect("E2B must have a local KV producer");
        let global_producer = config.layers[..first_shared]
            .iter()
            .rposition(|layer| layer.attention == AttentionKind::Global)
            .expect("E2B must have a global KV producer");
        let layers = config
            .layers
            .iter()
            .map(|layer| {
                if layer.owns_kv {
                    match layer.attention {
                        AttentionKind::Local => LayerCacheMode::Local {
                            window: config.sliding_window,
                        },
                        AttentionKind::Global => LayerCacheMode::Global {
                            capacity: context_limit.min(config.max_position_embeddings),
                        },
                    }
                } else {
                    LayerCacheMode::Shared {
                        producer: match layer.attention {
                            AttentionKind::Local => local_producer,
                            AttentionKind::Global => global_producer,
                        },
                    }
                }
            })
            .collect();
        Self { layers }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CacheError {
    #[error("cannot allocate tensor storage for a shared KV layer")]
    SharedLayer,
    #[error("KV cache expected [batch={batch}, heads={heads}, *, dim={head_dim}], got {actual:?}")]
    Shape {
        batch: usize,
        heads: usize,
        head_dim: usize,
        actual: [usize; 4],
    },
    #[error("global KV cache capacity {capacity} exceeded by sequence length {requested}")]
    Capacity { capacity: usize, requested: usize },
}

/// Owned KV storage for one non-sharing layer.
pub struct LayerKvCache<B: Backend> {
    mode: LayerCacheMode,
    keys: Tensor<B, 4>,
    values: Tensor<B, 4>,
    batch: usize,
    heads: usize,
    head_dim: usize,
    len: usize,
    cursor: usize,
}

impl<B: Backend> LayerKvCache<B> {
    pub fn new(
        mode: LayerCacheMode,
        batch: usize,
        heads: usize,
        head_dim: usize,
        device: &B::Device,
    ) -> Result<Self, CacheError> {
        let capacity = match mode {
            LayerCacheMode::Local { window } => window,
            LayerCacheMode::Global { capacity } => capacity,
            LayerCacheMode::Shared { .. } => return Err(CacheError::SharedLayer),
        };
        Ok(Self {
            mode,
            keys: Tensor::zeros([batch, heads, capacity, head_dim], device),
            values: Tensor::zeros([batch, heads, capacity, head_dim], device),
            batch,
            heads,
            head_dim,
            len: 0,
            cursor: 0,
        })
    }

    /// Append a prefill chunk or decode token and return chronological K/V views.
    pub fn push(
        &mut self,
        keys: Tensor<B, 4>,
        values: Tensor<B, 4>,
    ) -> Result<(Tensor<B, 4>, Tensor<B, 4>), CacheError> {
        let key_dims = keys.dims();
        let value_dims = values.dims();
        let expected = |actual: [usize; 4]| CacheError::Shape {
            batch: self.batch,
            heads: self.heads,
            head_dim: self.head_dim,
            actual,
        };
        if key_dims[0] != self.batch
            || key_dims[1] != self.heads
            || key_dims[3] != self.head_dim
            || value_dims != key_dims
        {
            return Err(expected(key_dims));
        }
        let steps = key_dims[2];
        match self.mode {
            LayerCacheMode::Local { window } => {
                for step in 0..steps {
                    let slot = self.cursor;
                    self.keys = self.keys.clone().slice_assign(
                        [
                            0..self.batch,
                            0..self.heads,
                            slot..slot + 1,
                            0..self.head_dim,
                        ],
                        keys.clone().slice([
                            0..self.batch,
                            0..self.heads,
                            step..step + 1,
                            0..self.head_dim,
                        ]),
                    );
                    self.values = self.values.clone().slice_assign(
                        [
                            0..self.batch,
                            0..self.heads,
                            slot..slot + 1,
                            0..self.head_dim,
                        ],
                        values.clone().slice([
                            0..self.batch,
                            0..self.heads,
                            step..step + 1,
                            0..self.head_dim,
                        ]),
                    );
                    self.cursor = (self.cursor + 1) % window;
                    self.len = (self.len + 1).min(window);
                }
                Ok((
                    self.ordered_local(self.keys.clone()),
                    self.ordered_local(self.values.clone()),
                ))
            }
            LayerCacheMode::Global { capacity } => {
                let requested = self.len + steps;
                if requested > capacity {
                    return Err(CacheError::Capacity {
                        capacity,
                        requested,
                    });
                }
                self.keys = self.keys.clone().slice_assign(
                    [
                        0..self.batch,
                        0..self.heads,
                        self.len..requested,
                        0..self.head_dim,
                    ],
                    keys,
                );
                self.values = self.values.clone().slice_assign(
                    [
                        0..self.batch,
                        0..self.heads,
                        self.len..requested,
                        0..self.head_dim,
                    ],
                    values,
                );
                self.len = requested;
                Ok((
                    self.keys.clone().slice([
                        0..self.batch,
                        0..self.heads,
                        0..self.len,
                        0..self.head_dim,
                    ]),
                    self.values.clone().slice([
                        0..self.batch,
                        0..self.heads,
                        0..self.len,
                        0..self.head_dim,
                    ]),
                ))
            }
            LayerCacheMode::Shared { .. } => Err(CacheError::SharedLayer),
        }
    }

    fn ordered_local(&self, tensor: Tensor<B, 4>) -> Tensor<B, 4> {
        if self.len == 0 {
            return tensor.slice([0..self.batch, 0..self.heads, 0..0, 0..self.head_dim]);
        }
        let LayerCacheMode::Local { window } = self.mode else {
            unreachable!()
        };
        if self.len < window {
            tensor.slice([0..self.batch, 0..self.heads, 0..self.len, 0..self.head_dim])
        } else if self.cursor == 0 {
            tensor
        } else {
            Tensor::cat(
                vec![
                    tensor.clone().slice([
                        0..self.batch,
                        0..self.heads,
                        self.cursor..window,
                        0..self.head_dim,
                    ]),
                    tensor.slice([
                        0..self.batch,
                        0..self.heads,
                        0..self.cursor,
                        0..self.head_dim,
                    ]),
                ],
                2,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::cast_precision_loss, clippy::default_trait_access)]

    use burn::{
        backend::NdArray,
        tensor::{Tensor, TensorData},
    };

    use super::*;

    type B = NdArray<f32>;

    #[test]
    fn local_ring_returns_chronological_window_after_wrap() {
        let device = Default::default();
        let mut cache =
            LayerKvCache::<B>::new(LayerCacheMode::Local { window: 3 }, 1, 1, 1, &device).unwrap();
        let mut latest = None;
        for value in 0..5 {
            let tensor = Tensor::<B, 4>::from_data(
                TensorData::new(vec![value as f32], [1, 1, 1, 1]),
                &device,
            );
            latest = Some(cache.push(tensor.clone(), tensor).unwrap().0);
        }
        assert_eq!(
            latest.unwrap().to_data().to_vec::<f32>().unwrap(),
            [2.0, 3.0, 4.0]
        );
    }

    #[test]
    fn global_cache_appends_and_checks_capacity() {
        let device = Default::default();
        let mut cache =
            LayerKvCache::<B>::new(LayerCacheMode::Global { capacity: 3 }, 1, 1, 1, &device)
                .unwrap();
        let chunk =
            Tensor::<B, 4>::from_data(TensorData::new(vec![1.0, 2.0], [1, 1, 2, 1]), &device);
        let (keys, _) = cache.push(chunk.clone(), chunk).unwrap();
        assert_eq!(keys.to_data().to_vec::<f32>().unwrap(), [1.0, 2.0]);
        let overflow = Tensor::<B, 4>::zeros([1, 1, 2, 1], &device);
        assert_eq!(
            cache.push(overflow.clone(), overflow).unwrap_err(),
            CacheError::Capacity {
                capacity: 3,
                requested: 4
            }
        );
    }
}
