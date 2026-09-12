//! Same-stream f32 RMSNorm dispatch.
//!
//! Replaces a six-dispatch Burn expression with one kernel. See the MSL source
//! for why that matters at 210 norms per token.

use std::collections::HashSet;

use burn_wgpu::{CubeTensor, WgpuRuntime};
use cubecl::{
    CompilationError, Compiler, CubeCount, CubeDim, CubeTask,
    bytes::Bytes,
    client::ComputeClient,
    ir::{ElemType, StorageType, UIntKind},
    prelude::{CompiledKernel, KernelId, KernelMetadata, Visibility},
    server::{Handle, KernelArguments},
    wgpu::{AutoCompiler, AutoRepresentation},
};
use cubecl_cpp::{
    metal::MslDialect,
    shared::{Body, ComputeKernel, Elem, Flags, Item, KernelArg},
};

const SIMD_WIDTH: u32 = 32;
const ENTRY_POINT: &str = "quixi_chat_rms_norm_f32";
const SOURCE: &str =
    include_str!("../../../../kernels/metal/src/norms/quixi_chat_rms_norm_f32.metal");

/// A shape-and-epsilon binding, built once so the hot path allocates nothing.
///
/// Every norm in the model has a fixed row count, width and epsilon, so the
/// parameter buffer is created at load time rather than per token.
#[derive(Debug, Clone)]
pub struct RmsNormPlan {
    params: Handle,
    rows: u32,
}

impl RmsNormPlan {
    /// `weighted` selects the `* weight` tail; `residual` folds in a trailing
    /// `+ residual`, which is how the layer's three residual adds disappear.
    #[must_use]
    pub fn new(
        client: &ComputeClient<WgpuRuntime>,
        rows: usize,
        dim: usize,
        weighted: bool,
        residual: bool,
        eps: f32,
    ) -> Self {
        let params: [u32; 4] = [
            u32::try_from(rows).expect("rms norm rows exceed u32"),
            u32::try_from(dim).expect("rms norm dim exceed u32"),
            u32::from(weighted) | (u32::from(residual) << 1),
            eps.to_bits(),
        ];
        let bytes: Vec<u8> = params
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        Self {
            params: client.create(Bytes::from_bytes_vec(bytes)),
            rows: params[0],
        }
    }
}

/// `out = rms_norm(input) * weight`, on the client's own stream.
///
/// `weight` and `residual` must be bound even when the plan does not use them;
/// the kernel does not read them in that case, so callers pass any live f32
/// buffer.
#[must_use]
pub fn rms_norm_f32(
    plan: &RmsNormPlan,
    client: &ComputeClient<WgpuRuntime>,
    out: CubeTensor<WgpuRuntime>,
    input: &CubeTensor<WgpuRuntime>,
    weight: &CubeTensor<WgpuRuntime>,
    residual: &CubeTensor<WgpuRuntime>,
) -> CubeTensor<WgpuRuntime> {
    let arguments = KernelArguments::new()
        .with_buffer(out.handle.clone().binding())
        .with_buffer(input.handle.clone().binding())
        .with_buffer(weight.handle.clone().binding())
        .with_buffer(residual.handle.clone().binding())
        .with_buffer(plan.params.clone().binding());
    client.launch(
        Box::new(RmsNormTask),
        CubeCount::Static(plan.rows, 1, 1),
        arguments,
    );
    out
}

#[derive(Debug)]
struct RmsNormTask;

impl KernelMetadata for RmsNormTask {
    fn name(&self) -> &'static str {
        ENTRY_POINT
    }

    fn id(&self) -> KernelId {
        KernelId::new::<Self>().cube_dim(CubeDim::new_1d(SIMD_WIDTH))
    }

    fn address_type(&self) -> StorageType {
        ElemType::UInt(UIntKind::U32).into()
    }
}

impl CubeTask<AutoCompiler> for RmsNormTask {
    fn compile(
        &self,
        _compiler: &mut AutoCompiler,
        _compilation_options: &<AutoCompiler as Compiler>::CompilationOptions,
        _mode: cubecl::server::ExecutionMode,
        _address_type: StorageType,
    ) -> Result<CompiledKernel<AutoCompiler>, CompilationError> {
        let cube_dim = CubeDim::new_1d(SIMD_WIDTH);
        let f32_item = Item::<MslDialect>::scalar(Elem::F32, true);
        let u32_item = Item::<MslDialect>::scalar(Elem::U32, true);
        let mut flags = Flags::default();
        flags.cube_dim = cube_dim;
        let representation = ComputeKernel {
            tensor_maps: Vec::new(),
            buffers: vec![
                KernelArg {
                    id: 0,
                    item: f32_item,
                    size: None,
                    vis: Visibility::ReadWrite,
                },
                KernelArg {
                    id: 1,
                    item: f32_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 2,
                    item: f32_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 3,
                    item: f32_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 4,
                    item: u32_item,
                    size: None,
                    vis: Visibility::Read,
                },
            ],
            scalars: Vec::new(),
            info: Default::default(),
            meta_static_len: 0,
            body: Body {
                instructions: Vec::new(),
                shared_memories: Vec::new(),
                pipelines: Vec::new(),
                barriers: Vec::new(),
                const_arrays: Vec::new(),
                local_arrays: Vec::new(),
                info_by_ptr: false,
                has_dynamic_meta: false,
                address_type: u32_item,
            },
            cube_dim,
            cluster_dim: None,
            extensions: Vec::new(),
            flags,
            items: HashSet::from([f32_item, u32_item]),
            kernel_name: ENTRY_POINT.to_owned(),
        };
        Ok(CompiledKernel {
            entrypoint_name: ENTRY_POINT.to_owned(),
            debug_name: Some(ENTRY_POINT),
            source: SOURCE.to_owned(),
            repr: Some(AutoRepresentation::Msl(representation)),
            cube_dim,
            debug_info: None,
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::cast_precision_loss)]

    use burn::{
        backend::Metal,
        tensor::{Tensor, TensorPrimitive},
    };

    use super::*;

    /// The expression this kernel replaces, evaluated with framework ops.
    fn reference(
        input: &[f32],
        weight: &[f32],
        residual: &[f32],
        eps: f32,
        weighted: bool,
        with_residual: bool,
    ) -> Vec<f32> {
        let mean = input.iter().map(|v| v * v).sum::<f32>() / input.len() as f32;
        let inverse = (mean + eps).powf(-0.5);
        input
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let mut scaled = value * inverse;
                if weighted {
                    scaled *= weight[index];
                }
                if with_residual {
                    scaled += residual[index];
                }
                scaled
            })
            .collect()
    }

    fn run(rows: usize, dim: usize, weighted: bool, with_residual: bool) {
        let device = Default::default();
        let eps = 1e-6_f32;

        let input: Vec<f32> = (0..rows * dim)
            .map(|i| ((i % 37) as f32 - 18.0) * 0.11)
            .collect();
        let weight: Vec<f32> = (0..dim).map(|i| 1.0 + (i % 11) as f32 * 0.03).collect();
        let residual: Vec<f32> = (0..rows * dim)
            .map(|i| ((i % 7) as f32 - 3.0) * 0.25)
            .collect();

        let input_tensor = Tensor::<Metal, 1>::from_floats(input.as_slice(), &device);
        let weight_tensor = Tensor::<Metal, 1>::from_floats(weight.as_slice(), &device);
        let residual_tensor = Tensor::<Metal, 1>::from_floats(residual.as_slice(), &device);
        let out_tensor = Tensor::<Metal, 1>::zeros([rows * dim], &device);

        let TensorPrimitive::Float(input_p) = input_tensor.into_primitive() else {
            panic!("float tensor")
        };
        let TensorPrimitive::Float(weight_p) = weight_tensor.into_primitive() else {
            panic!("float tensor")
        };
        let TensorPrimitive::Float(residual_p) = residual_tensor.into_primitive() else {
            panic!("float tensor")
        };
        let TensorPrimitive::Float(out_p) = out_tensor.into_primitive() else {
            panic!("float tensor")
        };

        let client = input_p.client.clone();
        let plan = RmsNormPlan::new(&client, rows, dim, weighted, with_residual, eps);
        let out_p = rms_norm_f32(&plan, &client, out_p, &input_p, &weight_p, &residual_p);
        let actual = Tensor::<Metal, 1>::from_primitive(TensorPrimitive::Float(out_p))
            .into_data()
            .to_vec::<f32>()
            .expect("f32 output");

        for row in 0..rows {
            let span = row * dim..(row + 1) * dim;
            let expected = reference(
                &input[span.clone()],
                &weight,
                &residual[span.clone()],
                eps,
                weighted,
                with_residual,
            );
            for (index, want) in expected.iter().enumerate() {
                let got = actual[row * dim + index];
                assert!(
                    (got - want).abs() <= 1e-4 * want.abs().max(1.0),
                    "row {row} index {index}: got {got}, want {want}"
                );
            }
        }
    }

    #[test]
    fn weighted_matches_the_framework_expression() {
        run(1, 1536, true, false);
    }

    #[test]
    fn unweighted_matches_the_framework_expression() {
        run(1, 256, false, false);
    }

    /// Head-wise norms run one row per attention head.
    #[test]
    fn multi_row_normalizes_each_row_independently() {
        run(8, 256, true, false);
    }

    /// A width that is not a multiple of the simdgroup exercises the tail.
    #[test]
    fn ragged_width_folds_correctly() {
        run(3, 100, true, false);
    }

    /// The fused `residual + norm(x) * weight` used three times per layer.
    #[test]
    fn residual_is_added_after_scaling() {
        run(1, 1536, true, true);
    }

    #[test]
    fn residual_with_ragged_width() {
        run(2, 100, true, true);
    }
}
