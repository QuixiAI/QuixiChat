//! Vendored Metal library and Burn/CubeCL dispatch boundary.

mod dequant_gather;
mod geglu;
mod q6_argmax;
mod qgemv;
mod rms_norm;
mod rope;

pub use burn_wgpu::{CubeTensor, WgpuRuntime};
pub use cubecl::client::ComputeClient;

pub use dequant_gather::{dequant_gather, dequant_gather_matrix};
pub use geglu::{GegluPlan, geglu_f32};
pub use q6_argmax::q6_k_argmax_f32;
pub use qgemv::{PackedMetalMatrix, qgemv_f32};
pub use rms_norm::{RmsNormPlan, rms_norm_f32};
pub use rope::{RopePlan, RopeTables, rope_f32};

pub const BACKEND: &str = "metal";
