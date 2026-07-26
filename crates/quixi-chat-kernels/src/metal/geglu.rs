//! Same-stream fused GeGLU dispatch.
//!
//! Collapses the FFN's slice/GELU/multiply chain — about ten dispatches per
//! layer — into one kernel over the stacked gate/up buffer. See the MSL source.

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

const THREADS: u32 = 256;
const ENTRY_POINT: &str = "quixi_chat_geglu_f32";
const SOURCE: &str =
    include_str!("../../../../kernels/metal/src/activations/quixi_chat_geglu_f32.metal");

/// A width binding, built once per FFN width so the hot path allocates nothing.
#[derive(Debug, Clone)]
pub struct GegluPlan {
    params: Handle,
    groups: u32,
}

impl GegluPlan {
    pub fn new(client: &ComputeClient<WgpuRuntime>, width: usize) -> Self {
        let params: [u32; 1] = [u32::try_from(width).expect("geglu width exceeds u32")];
        let bytes: Vec<u8> = params
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        Self {
            params: client.create(Bytes::from_bytes_vec(bytes)),
            groups: params[0].div_ceil(THREADS),
        }
    }
}

/// `out = gelu(gate_up[..width]) * gate_up[width..]`, on the client's own stream.
pub fn geglu_f32(
    plan: &GegluPlan,
    client: &ComputeClient<WgpuRuntime>,
    out: CubeTensor<WgpuRuntime>,
    gate_up: &CubeTensor<WgpuRuntime>,
) -> CubeTensor<WgpuRuntime> {
    let arguments = KernelArguments::new()
        .with_buffer(out.handle.clone().binding())
        .with_buffer(gate_up.handle.clone().binding())
        .with_buffer(plan.params.clone().binding());
    client.launch(
        Box::new(GegluTask),
        CubeCount::Static(plan.groups, 1, 1),
        arguments,
    );
    out
}

#[derive(Debug)]
struct GegluTask;

impl KernelMetadata for GegluTask {
    fn name(&self) -> &'static str {
        ENTRY_POINT
    }

    fn id(&self) -> KernelId {
        KernelId::new::<Self>().cube_dim(CubeDim::new_1d(THREADS))
    }

    fn address_type(&self) -> StorageType {
        ElemType::UInt(UIntKind::U32).into()
    }
}

impl CubeTask<AutoCompiler> for GegluTask {
    fn compile(
        &self,
        _compiler: &mut AutoCompiler,
        _compilation_options: &<AutoCompiler as Compiler>::CompilationOptions,
        _mode: cubecl::server::ExecutionMode,
        _address_type: StorageType,
    ) -> Result<CompiledKernel<AutoCompiler>, CompilationError> {
        let cube_dim = CubeDim::new_1d(THREADS);
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
    use burn::{
        backend::Metal,
        tensor::{Tensor, TensorPrimitive, activation},
    };

    use super::*;

    /// Asserts the kernel reproduces `gelu_approximate(gate) * up` as burn
    /// computes it — the constant and the term order both matter, since a
    /// mismatch here shifts every FFN output slightly.
    fn check(width: usize) {
        let device = Default::default();
        let values: Vec<f32> = (0..width * 2)
            .map(|i| ((i % 53) as f32 - 26.0) * 0.17)
            .collect();

        let stacked = Tensor::<Metal, 1>::from_floats(values.as_slice(), &device);
        let expected = activation::gelu_approximate(stacked.clone().slice([0..width]))
            * stacked.clone().slice([width..2 * width]);
        let expected = expected.into_data().to_vec::<f32>().expect("f32");

        let out = Tensor::<Metal, 1>::empty([width], &device);
        let TensorPrimitive::Float(stacked_p) = stacked.into_primitive() else {
            panic!("float")
        };
        let TensorPrimitive::Float(out_p) = out.into_primitive() else {
            panic!("float")
        };
        let client = stacked_p.client.clone();
        let plan = GegluPlan::new(&client, width);
        let out_p = geglu_f32(&plan, &client, out_p, &stacked_p);
        let actual = Tensor::<Metal, 1>::from_primitive(TensorPrimitive::Float(out_p))
            .into_data()
            .to_vec::<f32>()
            .expect("f32");

        for (index, want) in expected.iter().enumerate() {
            let got = actual[index];
            assert!(
                (got - want).abs() <= 1e-3 * want.abs().max(1.0),
                "index {index}: got {got}, want {want}"
            );
        }
    }

    #[test]
    fn matches_burn_geglu_at_the_narrow_ffn_width() {
        check(6144);
    }

    #[test]
    fn matches_burn_geglu_at_the_wide_ffn_width() {
        check(12288);
    }

    /// A width that is not a multiple of the threadgroup exercises the guard.
    #[test]
    fn ragged_width_is_bounds_checked() {
        check(1000);
    }
}
