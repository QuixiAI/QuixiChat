//! Backend selection, native Metal kernels, and the framework fallback.
//!
//! The focused MSL sources under `kernels/metal/` are dispatched onto Burn's
//! CubeCL/wgpu stream, so every custom kernel shares the model's device queue.

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

pub mod backend;
#[cfg(feature = "metal-kernels")]
pub mod metal;
pub mod quant;

pub use backend::{Backend, DeviceError, DeviceReport};

#[cfg(feature = "metal-kernels")]
pub const NATIVE_KERNELS_COMPILED: bool = true;
#[cfg(not(feature = "metal-kernels"))]
pub const NATIVE_KERNELS_COMPILED: bool = false;

use burn::tensor::{ElementConversion, Tensor};

/// Result of proving the GPU actually computes.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SmokeTest {
    pub ok: bool,
    /// Sum of squares of `[1, 2, 3, 4]` — 30.0 when the device is working.
    pub value: f32,
    pub expected: f32,
}

/// Run a tiny tensor computation on the selected device.
///
/// Called during startup for the same reason MoleculAI warms its model: the
/// first real request should never be the one that discovers the GPU is
/// missing, and CubeCL autotunes on first shape encounter.
pub fn smoke_test() -> Result<(DeviceReport, SmokeTest), DeviceError> {
    let device = backend::device()?;

    let input = Tensor::<Backend, 1>::from_floats([1.0, 2.0, 3.0, 4.0], &device);
    let value: f32 = input.clone().mul(input).sum().into_scalar().elem();

    let report = DeviceReport {
        backend: backend::name(),
        device: format!("{device:?}"),
        native_kernels: NATIVE_KERNELS_COMPILED,
    };
    let smoke = SmokeTest {
        ok: (value - 30.0).abs() < 1e-4,
        value,
        expected: 30.0,
    };

    Ok((report, smoke))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_computes_the_expected_value() {
        let (report, smoke) = smoke_test().expect("a Metal device must be available");
        assert!(smoke.ok, "{report:?} produced {} not 30.0", smoke.value);
    }
}
