//! Packed GGML matrix ownership and same-stream f32 GEMV dispatch.

use std::{collections::HashSet, path::Path};

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

use crate::quant::{QuantFormat, packed_row_bytes};

const SIMD_WIDTH: u32 = 32;
const MAX_GRID_DIMENSION: u32 = 65_535;
pub(crate) const ARGMAX_TILE_ROWS: u32 = 1_024;
const Q4_SOURCE: &str =
    include_str!("../../../../kernels/metal/src/quantization/qgemv/quixi_chat_q4_0_f32.metal");

/// A load-once packed Metal allocation; Burn never interprets its quantized dtype.
#[derive(Clone)]
pub struct PackedMetalMatrix {
    client: ComputeClient<WgpuRuntime>,
    handle: Handle,
    qgemv_params: Handle,
    argmax_params: Handle,
    argmax_tiles: u32,
    format: QuantFormat,
    rows: usize,
    columns: usize,
}

impl std::fmt::Debug for PackedMetalMatrix {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PackedMetalMatrix")
            .field("format", &self.format)
            .field("rows", &self.rows)
            .field("columns", &self.columns)
            .finish_non_exhaustive()
    }
}

impl PackedMetalMatrix {
    /// Upload one exact row-major packed tensor using the same CubeCL client as `reference`.
    pub fn upload(
        reference: &CubeTensor<WgpuRuntime>,
        packed: Vec<u8>,
        format: QuantFormat,
        rows: usize,
        columns: usize,
    ) -> Self {
        Self::upload_bytes(
            reference,
            Bytes::from_bytes_vec(packed),
            format,
            rows,
            columns,
        )
    }

    /// Upload a packed tensor directly from one range of a GGUF file.
    pub fn upload_file(
        reference: &CubeTensor<WgpuRuntime>,
        path: impl AsRef<Path>,
        size: u64,
        offset: u64,
        format: QuantFormat,
        rows: usize,
        columns: usize,
    ) -> Self {
        Self::upload_bytes(
            reference,
            Bytes::from_file(path.as_ref().to_path_buf(), size, offset),
            format,
            rows,
            columns,
        )
    }

    fn upload_bytes(
        reference: &CubeTensor<WgpuRuntime>,
        packed: Bytes,
        format: QuantFormat,
        rows: usize,
        columns: usize,
    ) -> Self {
        let expected = packed_row_bytes(format, columns)
            .and_then(|bytes| bytes.checked_mul(rows))
            .expect("packed matrix dimensions must align and fit usize");
        assert_eq!(packed.len(), expected);
        let client = reference.client.clone();
        let rows_u32 = u32::try_from(rows).expect("packed matrix rows exceed u32");
        let columns_u32 = u32::try_from(columns).expect("packed matrix columns exceed u32");
        let groups_x = rows_u32.min(MAX_GRID_DIMENSION);
        let mut params = Vec::with_capacity(12);
        params.extend_from_slice(&rows_u32.to_le_bytes());
        params.extend_from_slice(&columns_u32.to_le_bytes());
        params.extend_from_slice(&groups_x.to_le_bytes());
        let qgemv_params = params;
        let argmax_tiles = rows_u32.div_ceil(ARGMAX_TILE_ROWS);
        let mut params = Vec::with_capacity(16);
        params.extend_from_slice(&rows_u32.to_le_bytes());
        params.extend_from_slice(&columns_u32.to_le_bytes());
        params.extend_from_slice(&ARGMAX_TILE_ROWS.to_le_bytes());
        params.extend_from_slice(&argmax_tiles.to_le_bytes());
        let argmax_params = params;
        let allocation_client = client.clone();
        let (handle, qgemv_params, argmax_params) = client
            .memory_persistent_allocation(
                (packed, qgemv_params, argmax_params),
                move |(packed, qgemv_params, argmax_params)| {
                    (
                        allocation_client.create(packed),
                        allocation_client.create(Bytes::from_bytes_vec(qgemv_params)),
                        allocation_client.create(Bytes::from_bytes_vec(argmax_params)),
                    )
                },
            )
            .expect("persistent packed Metal allocation failed");
        Self {
            client,
            handle,
            qgemv_params,
            argmax_params,
            argmax_tiles,
            format,
            rows,
            columns,
        }
    }

    #[must_use]
    pub const fn format(&self) -> QuantFormat {
        self.format
    }

    #[must_use]
    pub const fn rows(&self) -> usize {
        self.rows
    }

    #[must_use]
    pub const fn columns(&self) -> usize {
        self.columns
    }

    pub(crate) fn binding(&self) -> cubecl::server::Binding {
        self.handle.clone().binding()
    }

    pub(crate) fn client(&self) -> &ComputeClient<WgpuRuntime> {
        &self.client
    }

    fn qgemv_params_binding(&self) -> cubecl::server::Binding {
        self.qgemv_params.clone().binding()
    }

    pub(crate) fn argmax_params_binding(&self) -> cubecl::server::Binding {
        self.argmax_params.clone().binding()
    }

    pub(crate) const fn argmax_tiles(&self) -> u32 {
        self.argmax_tiles
    }
}

#[derive(Debug)]
struct QgemvTask;

impl QgemvTask {
    const fn entry_point(&self) -> &'static str {
        "quixi_chat_qgemv_q4_0_f32"
    }

    const fn source(&self) -> &'static str {
        Q4_SOURCE
    }
}

impl KernelMetadata for QgemvTask {
    fn name(&self) -> &'static str {
        self.entry_point()
    }

    fn id(&self) -> KernelId {
        KernelId::new::<Self>().cube_dim(CubeDim::new_1d(SIMD_WIDTH))
    }

    fn address_type(&self) -> StorageType {
        ElemType::UInt(UIntKind::U32).into()
    }
}

impl CubeTask<AutoCompiler> for QgemvTask {
    fn compile(
        &self,
        _compiler: &mut AutoCompiler,
        _compilation_options: &<AutoCompiler as Compiler>::CompilationOptions,
        _mode: cubecl::server::ExecutionMode,
        _address_type: StorageType,
    ) -> Result<CompiledKernel<AutoCompiler>, CompilationError> {
        let cube_dim = CubeDim::new_1d(SIMD_WIDTH);
        let f32_item = Item::<MslDialect>::scalar(Elem::F32, true);
        let f16_item = Item::<MslDialect>::scalar(Elem::F16, true);
        let u8_item = Item::<MslDialect>::scalar(Elem::U8, true);
        let u32_item = Item::<MslDialect>::scalar(Elem::U32, true);
        let mut flags = Flags::default();
        flags.cube_dim = cube_dim;
        flags.elem_f16 = true;
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
                    item: u8_item,
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
            items: HashSet::from([f32_item, f16_item, u8_item, u32_item]),
            kernel_name: self.entry_point().to_owned(),
        };
        Ok(CompiledKernel {
            entrypoint_name: self.entry_point().to_owned(),
            debug_name: Some("QuixiChat packed f32 GEMV"),
            source: self.source().to_owned(),
            repr: Some(AutoRepresentation::Msl(representation)),
            cube_dim,
            debug_info: None,
        })
    }
}

/// Compute `output = matrix * input` into an already allocated contiguous f32 vector.
pub fn qgemv_f32(
    matrix: &PackedMetalMatrix,
    input: CubeTensor<WgpuRuntime>,
    output: CubeTensor<WgpuRuntime>,
) -> CubeTensor<WgpuRuntime> {
    assert_eq!(matrix.format, QuantFormat::Q4_0);
    assert_eq!(input.meta.num_elements(), matrix.columns);
    assert_eq!(output.meta.num_elements(), matrix.rows);
    let rows = u32::try_from(matrix.rows).expect("qgemv rows exceed u32");
    let groups_x = rows.min(MAX_GRID_DIMENSION);
    let groups_y = rows.div_ceil(groups_x);
    let arguments = KernelArguments::new()
        .with_buffer(output.handle.clone().binding())
        .with_buffer(matrix.binding())
        .with_buffer(input.handle.clone().binding())
        .with_buffer(matrix.qgemv_params_binding());
    matrix.client.launch(
        Box::new(QgemvTask),
        CubeCount::Static(groups_x, groups_y, 1),
        arguments,
    );
    output
}

#[cfg(test)]
mod tests {
    use burn::{
        backend::Metal,
        tensor::{Tensor, TensorData, TensorPrimitive},
    };
    use half::f16;

    use super::*;
    use crate::quant::dequantize_matvec;

    #[test]
    fn native_q4_0_gemv_matches_cpu_reference() {
        let rows = 5;
        let columns = 64;
        let mut packed = vec![0_u8; rows * 2 * 18];
        for (block_index, block) in packed.chunks_exact_mut(18).enumerate() {
            let scale = 0.01 * (block_index + 1) as f32;
            block[..2].copy_from_slice(&f16::from_f32(scale).to_bits().to_le_bytes());
            for (index, code) in block[2..].iter_mut().enumerate() {
                *code = ((index + block_index * 3) as u8).wrapping_mul(17);
            }
        }
        let input_data = (0..columns)
            .map(|index| (index as f32 * 0.17).sin())
            .collect::<Vec<_>>();
        let expected =
            dequantize_matvec(QuantFormat::Q4_0, &packed, rows, columns, &input_data).unwrap();
        let device = Default::default();
        let input = Tensor::<Metal, 1>::from_data(TensorData::new(input_data, [columns]), &device);
        let output = Tensor::<Metal, 1>::zeros([rows], &device);
        let TensorPrimitive::Float(input) = input.into_primitive() else {
            panic!("input must be f32")
        };
        let matrix = PackedMetalMatrix::upload(&input, packed, QuantFormat::Q4_0, rows, columns);
        let TensorPrimitive::Float(output) = output.into_primitive() else {
            panic!("output must be f32")
        };
        let actual = Tensor::<Metal, 1>::from_primitive(TensorPrimitive::Float(qgemv_f32(
            &matrix, input, output,
        )))
        .to_data()
        .to_vec::<f32>()
        .unwrap();
        for (actual, expected) in actual.iter().zip(expected) {
            assert!((actual - expected).abs() <= 2e-5, "{actual} != {expected}");
        }
    }
}

/// Throughput probe for the GEMV launch geometry.
///
/// Ignored by default; this is a tuning tool, not a gate. Run with
/// `cargo test -p quixi-chat-kernels --release \
///  gemv_throughput -- --ignored --nocapture`
#[cfg(test)]
mod throughput {
    use burn::{
        backend::Metal,
        tensor::{Tensor, TensorPrimitive},
    };

    use super::*;
    use crate::quant::QuantFormat;

    fn measure(rows: usize, columns: usize, iterations: usize) -> f64 {
        let device = Default::default();
        let reference = Tensor::<Metal, 1>::zeros([1], &device);
        let TensorPrimitive::Float(reference) = reference.into_primitive() else {
            panic!("float")
        };

        let blocks = columns / 32;
        let packed = vec![0x42_u8; rows * blocks * 18];
        let matrix =
            PackedMetalMatrix::upload(&reference, packed, QuantFormat::Q4_0, rows, columns);

        let input = Tensor::<Metal, 1>::zeros([columns], &device);
        let TensorPrimitive::Float(input) = input.into_primitive() else {
            panic!("float")
        };

        // Warm up: first launch pays pipeline creation.
        for _ in 0..3 {
            let out = Tensor::<Metal, 1>::empty([rows], &device);
            let TensorPrimitive::Float(out) = out.into_primitive() else {
                panic!("float")
            };
            qgemv_f32(&matrix, input.clone(), out);
        }
        cubecl_common::future::block_on(matrix.client.sync()).expect("Metal warmup must finish");

        let started = std::time::Instant::now();
        for _ in 0..iterations {
            let out = Tensor::<Metal, 1>::empty([rows], &device);
            let TensorPrimitive::Float(out) = out.into_primitive() else {
                panic!("float")
            };
            qgemv_f32(&matrix, input.clone(), out);
        }
        cubecl_common::future::block_on(matrix.client.sync()).expect("Metal benchmark must finish");
        let elapsed = started.elapsed().as_secs_f64();

        let bytes = (rows * blocks * 18 * iterations) as f64;
        bytes / elapsed / 1e9
    }

    /// Cycle through enough distinct matrices that none stay cached, which is
    /// what the model does: every launch in a layer reads different weights.
    fn measure_cold(rows: usize, columns: usize, matrices: usize, iterations: usize) -> f64 {
        let device = Default::default();
        let reference = Tensor::<Metal, 1>::zeros([1], &device);
        let TensorPrimitive::Float(reference) = reference.into_primitive() else {
            panic!("float")
        };

        let blocks = columns / 32;
        let uploaded: Vec<_> = (0..matrices)
            .map(|index| {
                let packed = vec![(index as u8).wrapping_add(1); rows * blocks * 18];
                PackedMetalMatrix::upload(&reference, packed, QuantFormat::Q4_0, rows, columns)
            })
            .collect();

        let input = Tensor::<Metal, 1>::zeros([columns], &device);
        let TensorPrimitive::Float(input) = input.into_primitive() else {
            panic!("float")
        };

        for matrix in &uploaded {
            let out = Tensor::<Metal, 1>::empty([rows], &device);
            let TensorPrimitive::Float(out) = out.into_primitive() else {
                panic!("float")
            };
            qgemv_f32(matrix, input.clone(), out);
        }
        cubecl_common::future::block_on(uploaded[0].client.sync())
            .expect("Metal warmup must finish");

        let started = std::time::Instant::now();
        for iteration in 0..iterations {
            let matrix = &uploaded[iteration % matrices];
            let out = Tensor::<Metal, 1>::empty([rows], &device);
            let TensorPrimitive::Float(out) = out.into_primitive() else {
                panic!("float")
            };
            qgemv_f32(matrix, input.clone(), out);
        }
        cubecl_common::future::block_on(uploaded[0].client.sync())
            .expect("Metal benchmark must finish");
        let elapsed = started.elapsed().as_secs_f64();

        let bytes = (rows * blocks * 18 * iterations) as f64;
        bytes / elapsed / 1e9
    }

    /// The LM head's argmax over the full 262k-row tied embedding, cold.
    #[test]
    #[ignore = "throughput probe; run explicitly with --ignored"]
    fn argmax_throughput_cold() {
        use crate::metal::q6_k_argmax_f32;

        let device = Default::default();
        let reference = Tensor::<Metal, 1>::zeros([1], &device);
        let TensorPrimitive::Float(reference) = reference.into_primitive() else {
            panic!("float")
        };

        // Real LM head shape: 262,144 rows of 1,536 q6_k columns (~330 MB).
        let rows = 262_144;
        let columns = 1_536;
        let blocks = columns / 256;
        let packed = vec![0x21_u8; rows * blocks * 210];
        let bytes = packed.len();
        let matrix = PackedMetalMatrix::upload(&reference, packed, QuantFormat::Q6K, rows, columns);

        let input = Tensor::<Metal, 1>::zeros([columns], &device);
        let TensorPrimitive::Float(input) = input.into_primitive() else {
            panic!("float")
        };

        let tiles = usize::try_from(matrix.argmax_tiles()).expect("tiles");
        let call = || {
            let pv = Tensor::<Metal, 1>::empty([tiles], &device);
            let pi = Tensor::<Metal, 1, burn::tensor::Int>::empty([tiles], &device);
            let out = Tensor::<Metal, 1, burn::tensor::Int>::empty([1], &device);
            let TensorPrimitive::Float(pv) = pv.into_primitive() else {
                panic!("float")
            };
            q6_k_argmax_f32(
                &matrix,
                input.clone(),
                pv,
                pi.into_primitive(),
                out.into_primitive(),
            );
        };

        for _ in 0..2 {
            call();
        }
        cubecl_common::future::block_on(matrix.client.sync()).expect("Metal warmup must finish");

        let iterations = 20;
        let started = std::time::Instant::now();
        for _ in 0..iterations {
            call();
        }
        cubecl_common::future::block_on(matrix.client.sync()).expect("Metal benchmark must finish");
        let elapsed = started.elapsed().as_secs_f64();

        let gbs = (bytes * iterations) as f64 / elapsed / 1e9;
        println!(
            "  ARGMAX tile_rows={ARGMAX_TILE_ROWS} tiles={}  {:.2} ms/call  {gbs:.1} GB/s",
            matrix.argmax_tiles(),
            elapsed / iterations as f64 * 1000.0
        );
    }

    #[test]
    #[ignore = "throughput probe; run explicitly with --ignored"]
    fn gemv_throughput_cold() {
        // ~40 x 10.6 MB = 425 MB of distinct weights, far past any cache.
        for (rows, columns, matrices, iters) in [(12288, 1536, 40, 200), (2048, 1536, 200, 400)] {
            let gbs = measure_cold(rows, columns, matrices, iters);
            println!("  COLD {rows:>6} x {columns:<6} ({matrices} matrices)  {gbs:>7.1} GB/s");
        }
    }

    #[test]
    #[ignore = "throughput probe; run explicitly with --ignored"]
    fn gemv_throughput() {
        // Shapes the model actually launches, plus a large one to separate
        // launch overhead from streaming bandwidth.
        for (rows, columns, iters) in [
            (2048, 1536, 400),  // attention Q projection
            (1536, 2048, 400),  // attention output projection
            (6144, 1536, 200),  // narrow FFN
            (12288, 1536, 100), // wide FFN
            (1536, 12288, 100), // wide FFN down projection
        ] {
            let gbs = measure(rows, columns, iters);
            println!("  {rows:>6} x {columns:<6}  {gbs:>7.1} GB/s");
        }
    }
}
