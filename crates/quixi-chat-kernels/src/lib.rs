//! Native Metal kernels and their GGML quantization oracle.
//!
//! The focused MSL sources under `kernels/metal/` are dispatched onto Burn's
//! CubeCL/wgpu stream, so every custom kernel shares the model's device queue.

pub mod metal;
pub mod quant;
