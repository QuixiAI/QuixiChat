//! Same-stream dispatch for the native GGUF embedding gather.

use std::collections::HashSet;

use burn_wgpu::{CubeTensor, WgpuRuntime};
use cubecl::{
    CompilationError, Compiler, CubeCount, CubeDim, CubeTask,
    bytes::Bytes,
    ir::{ElemType, StorageType, UIntKind},
    prelude::{CompiledKernel, KernelId, KernelMetadata, Visibility},
    server::KernelArguments,
    wgpu::{AutoCompiler, AutoRepresentation},
};
use cubecl_cpp::{
    metal::MslDialect,
    shared::{Body, ComputeKernel, Elem, Flags, Item, KernelArg},
};

use crate::quant::{QuantFormat, packed_row_bytes};

use super::qgemv::PackedMetalMatrix;

const WORKGROUP_SIZE: u32 = 256;
const Q4_0_SOURCE: &str =
    include_str!("../../../../kernels/metal/src/quantization/dequant_gather/q4_0.metal");
const Q6_K_SOURCE: &str =
    include_str!("../../../../kernels/metal/src/quantization/dequant_gather/q6_k.metal");

#[derive(Debug)]
struct DequantGatherTask {
    format: QuantFormat,
}

impl DequantGatherTask {
    const fn entry_point(&self) -> &'static str {
        match self.format {
            QuantFormat::Q4_0 => "dequant_gather_q4_0",
            QuantFormat::Q6K => "dequant_gather_q6_K",
        }
    }

    const fn source(&self) -> &'static str {
        match self.format {
            QuantFormat::Q4_0 => Q4_0_SOURCE,
            QuantFormat::Q6K => Q6_K_SOURCE,
        }
    }
}

impl KernelMetadata for DequantGatherTask {
    fn name(&self) -> &'static str {
        self.entry_point()
    }

    fn id(&self) -> KernelId {
        KernelId::new::<Self>()
            .cube_dim(CubeDim::new_1d(WORKGROUP_SIZE))
            .info(self.format)
    }

    fn address_type(&self) -> StorageType {
        ElemType::UInt(UIntKind::U32).into()
    }
}

impl CubeTask<AutoCompiler> for DequantGatherTask {
    fn compile(
        &self,
        _compiler: &mut AutoCompiler,
        _compilation_options: &<AutoCompiler as Compiler>::CompilationOptions,
        _mode: cubecl::server::ExecutionMode,
        _address_type: StorageType,
    ) -> Result<CompiledKernel<AutoCompiler>, CompilationError> {
        let cube_dim = CubeDim::new_1d(WORKGROUP_SIZE);
        let f16_item = Item::<MslDialect>::scalar(Elem::F16, true);
        let u8_item = Item::<MslDialect>::scalar(Elem::U8, true);
        let i32_item = Item::<MslDialect>::scalar(Elem::I32, true);
        let u32_item = Item::<MslDialect>::scalar(Elem::U32, true);
        let mut flags = Flags::default();
        flags.cube_dim = cube_dim;
        let representation = ComputeKernel {
            tensor_maps: Vec::new(),
            buffers: vec![
                KernelArg {
                    id: 0,
                    item: f16_item,
                    size: None,
                    vis: Visibility::ReadWrite,
                },
                KernelArg {
                    id: 1,
                    item: u8_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 2,
                    item: i32_item,
                    size: None,
                    vis: Visibility::Read,
                },
                KernelArg {
                    id: 3,
                    item: u8_item,
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
            items: HashSet::from([f16_item, u8_item, i32_item, u32_item]),
            kernel_name: self.entry_point().to_owned(),
        };
        Ok(CompiledKernel {
            entrypoint_name: self.entry_point().to_owned(),
            debug_name: Some("QuixiChat packed embedding gather"),
            source: self.source().to_owned(),
            repr: Some(AutoRepresentation::Msl(representation)),
            cube_dim,
            debug_info: None,
        })
    }
}

/// Gather packed table rows into an already allocated contiguous fp16 output tensor.
///
/// `table` must be U8, `ids` must be I32, and `output` must be fp16 with
/// `ids.num_elements() * columns` elements. The returned tensor owns the same Burn allocation.
pub fn dequant_gather(
    table: CubeTensor<WgpuRuntime>,
    ids: CubeTensor<WgpuRuntime>,
    output: CubeTensor<WgpuRuntime>,
    format: QuantFormat,
    rows: usize,
    columns: usize,
    scale: f32,
) -> CubeTensor<WgpuRuntime> {
    let tokens = ids.meta.num_elements();
    let row_bytes = packed_row_bytes(format, columns)
        .expect("dequant_gather columns must align to the quantization block");
    assert_eq!(table.meta.num_elements(), rows * row_bytes);
    assert_eq!(output.meta.num_elements(), tokens * columns);
    let rows_u32 = u32::try_from(rows).expect("dequant_gather rows exceed u32");
    let columns_u32 = u32::try_from(columns).expect("dequant_gather columns exceed u32");
    let tokens_u32 = u32::try_from(tokens).expect("dequant_gather token count exceeds u32");

    let mut params = Vec::with_capacity(16);
    params.extend_from_slice(&rows_u32.to_le_bytes());
    params.extend_from_slice(&columns_u32.to_le_bytes());
    params.extend_from_slice(&tokens_u32.to_le_bytes());
    params.extend_from_slice(&scale.to_bits().to_le_bytes());
    let params = table.client.create(Bytes::from_bytes_vec(params));
    let arguments = KernelArguments::new()
        .with_buffer(output.handle.clone().binding())
        .with_buffer(table.handle.clone().binding())
        .with_buffer(ids.handle.clone().binding())
        .with_buffer(params.binding());
    let elements = tokens_u32
        .checked_mul(columns_u32)
        .expect("dequant_gather output grid exceeds u32");
    let workgroups = elements.div_ceil(WORKGROUP_SIZE);
    table.client.launch(
        Box::new(DequantGatherTask { format }),
        CubeCount::Static(workgroups, 1, 1),
        arguments,
    );
    output
}

/// Gather from a load-once packed matrix owned by the native kernels crate.
pub fn dequant_gather_matrix(
    table: &PackedMetalMatrix,
    ids: CubeTensor<WgpuRuntime>,
    output: CubeTensor<WgpuRuntime>,
    scale: f32,
) -> CubeTensor<WgpuRuntime> {
    let tokens = ids.meta.num_elements();
    assert_eq!(output.meta.num_elements(), tokens * table.columns());
    let rows = u32::try_from(table.rows()).expect("dequant_gather rows exceed u32");
    let columns = u32::try_from(table.columns()).expect("dequant_gather columns exceed u32");
    let tokens = u32::try_from(tokens).expect("dequant_gather token count exceeds u32");
    let mut params = Vec::with_capacity(16);
    params.extend_from_slice(&rows.to_le_bytes());
    params.extend_from_slice(&columns.to_le_bytes());
    params.extend_from_slice(&tokens.to_le_bytes());
    params.extend_from_slice(&scale.to_bits().to_le_bytes());
    let params = table.client().create(Bytes::from_bytes_vec(params));
    let arguments = KernelArguments::new()
        .with_buffer(output.handle.clone().binding())
        .with_buffer(table.binding())
        .with_buffer(ids.handle.clone().binding())
        .with_buffer(params.binding());
    let elements = tokens
        .checked_mul(columns)
        .expect("dequant_gather output grid exceeds u32");
    table.client().launch(
        Box::new(DequantGatherTask {
            format: table.format(),
        }),
        CubeCount::Static(elements.div_ceil(WORKGROUP_SIZE), 1, 1),
        arguments,
    );
    output
}

#[cfg(test)]
mod tests {
    use burn::{
        backend::Metal,
        tensor::{DType, Int, Tensor, TensorData, TensorPrimitive},
    };
    use half::f16;

    use super::*;
    use crate::quant::dequantize_gather as cpu_gather;

    #[test]
    fn q6_k_native_gather_matches_cpu_fp16_bits() {
        let mut row0 = vec![0_u8; QuantFormat::Q6K.block_bytes()];
        row0[208..].copy_from_slice(&f16::from_f32(0.125).to_bits().to_le_bytes());
        for (index, value) in row0[..128].iter_mut().enumerate() {
            *value = index as u8;
        }
        for (index, value) in row0[128..192].iter_mut().enumerate() {
            *value = (index * 3) as u8;
        }
        for (index, value) in row0[192..208].iter_mut().enumerate() {
            *value = (index as i8 - 8).to_ne_bytes()[0];
        }
        let mut row1 = row0.clone();
        row1[208..].copy_from_slice(&f16::from_f32(-0.0625).to_bits().to_le_bytes());
        let packed = [row0, row1].concat();
        let ids_data = vec![1_i32, 0_i32, 1_i32];
        let expected = cpu_gather(QuantFormat::Q6K, &packed, 2, 256, &[1, 0, 1], 16.0)
            .unwrap()
            .into_iter()
            .map(|value| f16::from_f32(value).to_f32())
            .collect::<Vec<_>>();

        let device = Default::default();
        let table = Tensor::<Metal, 1, Int>::from_data(
            TensorData::new(packed.clone(), [packed.len()]),
            &device,
        )
        .cast(DType::U8);
        let ids = Tensor::<Metal, 1, Int>::from_data(TensorData::new(ids_data, [3]), &device);
        let output = Tensor::<Metal, 2>::zeros([3, 256], &device).cast(DType::F16);
        let table = table.into_primitive();
        let ids = ids.into_primitive();
        let TensorPrimitive::Float(output) = output.into_primitive() else {
            panic!("fp16 output must have a float primitive")
        };
        assert_eq!(table.dtype, DType::U8);
        assert_eq!(ids.dtype, DType::I32);
        assert_eq!(output.dtype, DType::F16);
        let output = dequant_gather(table, ids, output, QuantFormat::Q6K, 2, 256, 16.0);
        let actual = Tensor::<Metal, 2>::from_primitive(TensorPrimitive::Float(output))
            .to_data()
            .convert::<f32>()
            .to_vec::<f32>()
            .unwrap();
        assert_eq!(actual, expected);
    }
}
