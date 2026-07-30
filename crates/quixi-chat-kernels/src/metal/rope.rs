//! Same-stream f32 rotary-embedding dispatch.
//!
//! Replaces a nine-dispatch framework expression with one kernel. The position
//! is applied by offsetting the cos/sin bindings on the host, so nothing here
//! varies per token. See the MSL source.

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
const ENTRY_POINT: &str = "quixi_chat_rope_f32";
const SOURCE: &str = include_str!("../../../../kernels/metal/src/norms/quixi_chat_rope_f32.metal");

/// A shape binding, built once per (rows, dim) so the hot path allocates
/// nothing. The step position rides in the table offsets instead.
#[derive(Debug, Clone)]
pub struct RopePlan {
    params: Handle,
    rows: u32,
}

impl RopePlan {
    #[must_use]
    pub fn new(client: &ComputeClient<WgpuRuntime>, rows: usize, dim: usize) -> Self {
        let params: [u32; 2] = [
            u32::try_from(rows).expect("rope rows exceed u32"),
            u32::try_from(dim).expect("rope dim exceed u32"),
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

/// Apply rotary embedding for `position`, on the client's own stream.
///
/// `cos`/`sin` are the full `[context, dim]` tables; this offsets each binding
/// to the row for `position`, which is why the kernel needs no step parameter.
pub struct RopeTables<'a> {
    pub cos: &'a CubeTensor<WgpuRuntime>,
    pub sin: &'a CubeTensor<WgpuRuntime>,
    /// Step index; selects the table row via a binding offset.
    pub position: usize,
    pub dim: usize,
}

#[must_use]
pub fn rope_f32(
    plan: &RopePlan,
    client: &ComputeClient<WgpuRuntime>,
    out: CubeTensor<WgpuRuntime>,
    input: &CubeTensor<WgpuRuntime>,
    tables: &RopeTables<'_>,
) -> CubeTensor<WgpuRuntime> {
    let RopeTables {
        cos,
        sin,
        position,
        dim,
    } = *tables;
    let row_bytes = (position * dim * std::mem::size_of::<f32>()) as u64;
    let arguments = KernelArguments::new()
        .with_buffer(out.handle.clone().binding())
        .with_buffer(input.handle.clone().binding())
        .with_buffer(cos.handle.clone().offset_start(row_bytes).binding())
        .with_buffer(sin.handle.clone().offset_start(row_bytes).binding())
        .with_buffer(plan.params.clone().binding());
    client.launch(
        Box::new(RopeTask),
        CubeCount::Static(plan.rows, 1, 1),
        arguments,
    );
    out
}

#[derive(Debug)]
struct RopeTask;

impl KernelMetadata for RopeTask {
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

impl CubeTask<AutoCompiler> for RopeTask {
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
