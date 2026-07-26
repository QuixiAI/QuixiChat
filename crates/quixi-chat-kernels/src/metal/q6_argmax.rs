//! Fused Q6_K tied vocabulary projection and greedy argmax.

use std::collections::HashSet;

use burn_wgpu::{CubeTensor, WgpuRuntime};
use cubecl::{
    CompilationError, Compiler, CubeCount, CubeDim, CubeTask,
    client::ComputeClient,
    ir::{ElemType, StorageType, UIntKind},
    prelude::{CompiledKernel, KernelId, KernelMetadata, Visibility},
    server::KernelArguments,
    wgpu::{AutoCompiler, AutoRepresentation},
};
use cubecl_cpp::{
    metal::MslDialect,
    shared::{Body, ComputeKernel, Elem, Flags, Item, KernelArg},
};

use crate::quant::QuantFormat;

use super::qgemv::PackedMetalMatrix;

const SIMD_WIDTH: u32 = 32;
const SOURCE: &str = include_str!(
    "../../../../kernels/metal/src/quantization/lm_head/quixi_chat_q6_k_argmax_f32.metal"
);

#[derive(Debug)]
struct PartialsTask;

#[derive(Debug)]
struct ReduceTask;

fn representation(
    entrypoint: &str,
    buffers: Vec<KernelArg<MslDialect>>,
) -> ComputeKernel<MslDialect> {
    let f32_item = Item::<MslDialect>::scalar(Elem::F32, true);
    let u8_item = Item::<MslDialect>::scalar(Elem::U8, true);
    let i32_item = Item::<MslDialect>::scalar(Elem::I32, true);
    let u32_item = Item::<MslDialect>::scalar(Elem::U32, true);
    let cube_dim = CubeDim::new_1d(SIMD_WIDTH);
    let mut flags = Flags::default();
    flags.cube_dim = cube_dim;
    ComputeKernel {
        tensor_maps: Vec::new(),
        buffers,
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
        items: HashSet::from([f32_item, u8_item, i32_item, u32_item]),
        kernel_name: entrypoint.to_owned(),
    }
}

fn compiled(entrypoint: &str, buffers: Vec<KernelArg<MslDialect>>) -> CompiledKernel<AutoCompiler> {
    let cube_dim = CubeDim::new_1d(SIMD_WIDTH);
    CompiledKernel {
        entrypoint_name: entrypoint.to_owned(),
        debug_name: Some("QuixiChat fused Q6_K LM-head argmax"),
        source: SOURCE.to_owned(),
        repr: Some(AutoRepresentation::Msl(representation(entrypoint, buffers))),
        cube_dim,
        debug_info: None,
    }
}

impl KernelMetadata for PartialsTask {
    fn name(&self) -> &'static str {
        "quixi_chat_lm_head_q6_K_argmax_partials_f32"
    }

    fn id(&self) -> KernelId {
        KernelId::new::<Self>().cube_dim(CubeDim::new_1d(SIMD_WIDTH))
    }

    fn address_type(&self) -> StorageType {
        ElemType::UInt(UIntKind::U32).into()
    }
}

impl CubeTask<AutoCompiler> for PartialsTask {
    fn compile(
        &self,
        _compiler: &mut AutoCompiler,
        _compilation_options: &<AutoCompiler as Compiler>::CompilationOptions,
        _mode: cubecl::server::ExecutionMode,
        _address_type: StorageType,
    ) -> Result<CompiledKernel<AutoCompiler>, CompilationError> {
        let f32_item = Item::<MslDialect>::scalar(Elem::F32, true);
        let u8_item = Item::<MslDialect>::scalar(Elem::U8, true);
        let i32_item = Item::<MslDialect>::scalar(Elem::I32, true);
        let u32_item = Item::<MslDialect>::scalar(Elem::U32, true);
        Ok(compiled(
            self.name(),
            vec![
                KernelArg {
                    id: 0,
                    item: f32_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 1,
                    item: u8_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 2,
                    item: f32_item,
                    size: None,
                    vis: Visibility::ReadWrite,
                },
                KernelArg {
                    id: 3,
                    item: i32_item,
                    size: None,
                    vis: Visibility::ReadWrite,
                },
                KernelArg {
                    id: 4,
                    item: u32_item,
                    size: None,
                    vis: Visibility::Read,
                },
            ],
        ))
    }
}

impl KernelMetadata for ReduceTask {
    fn name(&self) -> &'static str {
        "quixi_chat_lm_head_argmax_reduce_f32"
    }

    fn id(&self) -> KernelId {
        KernelId::new::<Self>().cube_dim(CubeDim::new_1d(SIMD_WIDTH))
    }

    fn address_type(&self) -> StorageType {
        ElemType::UInt(UIntKind::U32).into()
    }
}

impl CubeTask<AutoCompiler> for ReduceTask {
    fn compile(
        &self,
        _compiler: &mut AutoCompiler,
        _compilation_options: &<AutoCompiler as Compiler>::CompilationOptions,
        _mode: cubecl::server::ExecutionMode,
        _address_type: StorageType,
    ) -> Result<CompiledKernel<AutoCompiler>, CompilationError> {
        let f32_item = Item::<MslDialect>::scalar(Elem::F32, true);
        let i32_item = Item::<MslDialect>::scalar(Elem::I32, true);
        let u32_item = Item::<MslDialect>::scalar(Elem::U32, true);
        Ok(compiled(
            self.name(),
            vec![
                KernelArg {
                    id: 0,
                    item: f32_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 1,
                    item: i32_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 2,
                    item: i32_item,
                    size: None,
                    vis: Visibility::ReadWrite,
                },
                KernelArg {
                    id: 3,
                    item: u32_item,
                    size: None,
                    vis: Visibility::Read,
                },
            ],
        ))
    }
}

/// Return the exact greedy token for `matrix * input` without allocating logits.
pub fn q6_k_argmax_f32(
    matrix: &PackedMetalMatrix,
    input: CubeTensor<WgpuRuntime>,
    partial_values: CubeTensor<WgpuRuntime>,
    partial_ids: CubeTensor<WgpuRuntime>,
    output: CubeTensor<WgpuRuntime>,
) -> CubeTensor<WgpuRuntime> {
    assert_eq!(matrix.format(), QuantFormat::Q6K);
    assert_eq!(input.meta.num_elements(), matrix.columns());
    let tiles = usize::try_from(matrix.argmax_tiles()).expect("tile count fits usize");
    assert_eq!(partial_values.meta.num_elements(), tiles);
    assert_eq!(partial_ids.meta.num_elements(), tiles);
    assert_eq!(output.meta.num_elements(), 1);
    let client: &ComputeClient<WgpuRuntime> = matrix.client();
    let partial_arguments = KernelArguments::new()
        .with_buffer(input.handle.clone().binding())
        .with_buffer(matrix.binding())
        .with_buffer(partial_values.handle.clone().binding())
        .with_buffer(partial_ids.handle.clone().binding())
        .with_buffer(matrix.argmax_params_binding());
    client.launch(
        Box::new(PartialsTask),
        CubeCount::Static(matrix.argmax_tiles(), 1, 1),
        partial_arguments,
    );
    let reduce_arguments = KernelArguments::new()
        .with_buffer(partial_values.handle.clone().binding())
        .with_buffer(partial_ids.handle.clone().binding())
        .with_buffer(output.handle.clone().binding())
        .with_buffer(matrix.argmax_params_binding());
    client.launch(
        Box::new(ReduceTask),
        CubeCount::Static(1, 1, 1),
        reduce_arguments,
    );
    output
}

#[cfg(test)]
mod tests {
    use burn::{
        backend::Metal,
        tensor::{Int, Tensor, TensorData, TensorPrimitive},
    };
    use half::f16;

    use super::*;
    use crate::quant::dequantize_matvec;

    #[test]
    fn fused_q6_k_argmax_matches_cpu_across_multiple_tiles() {
        let rows = 2_050;
        let columns = 256;
        let mut packed = vec![0_u8; rows * 210];
        for (row, block) in packed.chunks_exact_mut(210).enumerate() {
            for (index, value) in block[..192].iter_mut().enumerate() {
                *value = (index * 17 + row * 13) as u8;
            }
            for (index, value) in block[192..208].iter_mut().enumerate() {
                *value = (index as i8 - 7 + (row % 5) as i8).to_ne_bytes()[0];
            }
            block[208..].copy_from_slice(
                &f16::from_f32(0.001 + row as f32 * 0.000_001)
                    .to_bits()
                    .to_le_bytes(),
            );
        }
        let input_data = (0..columns)
            .map(|index| (index as f32 * 0.031).cos())
            .collect::<Vec<_>>();
        let expected = dequantize_matvec(QuantFormat::Q6K, &packed, rows, columns, &input_data)
            .unwrap()
            .iter()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(right.1).then_with(|| right.0.cmp(&left.0)))
            .unwrap()
            .0 as i32;

        let device = Default::default();
        let input = Tensor::<Metal, 1>::from_data(TensorData::new(input_data, [columns]), &device);
        let TensorPrimitive::Float(input) = input.into_primitive() else {
            panic!("input must be f32")
        };
        let matrix = PackedMetalMatrix::upload(&input, packed, QuantFormat::Q6K, rows, columns);
        let tiles = matrix.argmax_tiles() as usize;
        let partial_values = Tensor::<Metal, 1>::zeros([tiles], &device);
        let partial_ids = Tensor::<Metal, 1, Int>::zeros([tiles], &device);
        let output = Tensor::<Metal, 1, Int>::zeros([1], &device);
        let TensorPrimitive::Float(partial_values) = partial_values.into_primitive() else {
            panic!("partials must be f32")
        };
        let partial_ids = partial_ids.into_primitive();
        let output = output.into_primitive();
        let output = q6_k_argmax_f32(&matrix, input, partial_values, partial_ids, output);
        let actual = Tensor::<Metal, 1, Int>::from_primitive(output)
            .to_data()
            .to_vec::<i32>()
            .unwrap()[0];
        assert_eq!(actual, expected);
    }
}
