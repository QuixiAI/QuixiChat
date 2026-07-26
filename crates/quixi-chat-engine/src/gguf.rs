//! Pure-Rust GGUF v2/v3 metadata, tensor-directory, and payload reader.

use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde::Serialize;
use thiserror::Error;

const MAGIC: &[u8; 4] = b"GGUF";
const DEFAULT_ALIGNMENT: u64 = 32;
const MAX_STRING_BYTES: u64 = 1 << 30;
const MAX_COLLECTION_ITEMS: u64 = 1 << 30;

#[derive(Debug, Error)]
pub enum GgufError {
    #[error("failed to read GGUF: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid GGUF magic {0:?}")]
    Magic([u8; 4]),
    #[error("unsupported GGUF version {0}; expected 2 or 3")]
    Version(u32),
    #[error("unknown GGUF metadata value type {0}")]
    ValueType(u32),
    #[error("GGUF string length {0} is unreasonable")]
    StringLength(u64),
    #[error("GGUF collection length {0} is unreasonable")]
    CollectionLength(u64),
    #[error("invalid UTF-8 in GGUF string: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("tensor {tensor:?} has an invalid or overflowing shape")]
    TensorShape { tensor: String },
    #[error("tensor {tensor:?} uses unsupported GGML type {ggml_type}")]
    TensorType { tensor: String, ggml_type: u32 },
    #[error(
        "tensor {tensor:?} element count {elements} is not divisible by its {block_elements}-element quantization block"
    )]
    TensorBlock {
        tensor: String,
        elements: u64,
        block_elements: u64,
    },
    #[error(
        "tensor {tensor:?} byte range [{offset}, {end}) exceeds data section length {data_bytes}"
    )]
    TensorOffset {
        tensor: String,
        offset: u64,
        end: u64,
        data_bytes: u64,
    },
    #[error("GGUF does not contain tensor {0:?}")]
    MissingTensor(String),
    #[error("tensor {tensor:?} row {row} is outside its {rows} rows")]
    TensorRow {
        tensor: String,
        row: usize,
        rows: usize,
    },
}

/// A decoded GGUF metadata value.
#[derive(Debug, Clone, PartialEq)]
pub enum GgufValue {
    U8(u8),
    I8(i8),
    U16(u16),
    I16(i16),
    U32(u32),
    I32(i32),
    F32(f32),
    Bool(bool),
    String(String),
    Array(Vec<GgufValue>),
    U64(u64),
    I64(i64),
    F64(f64),
}

impl GgufValue {
    #[must_use]
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::U8(value) => Some(u64::from(*value)),
            Self::U16(value) => Some(u64::from(*value)),
            Self::U32(value) => Some(u64::from(*value)),
            Self::U64(value) => Some(*value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::I8(value) => Some(i64::from(*value)),
            Self::I16(value) => Some(i64::from(*value)),
            Self::I32(value) => Some(i64::from(*value)),
            Self::I64(value) => Some(*value),
            _ => self.as_u64().and_then(|value| i64::try_from(value).ok()),
        }
    }

    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::F32(value) => Some(f64::from(*value)),
            Self::F64(value) => Some(*value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(value) = self {
            Some(*value)
        } else {
            None
        }
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        if let Self::String(value) = self {
            Some(value)
        } else {
            None
        }
    }

    #[must_use]
    pub fn as_array(&self) -> Option<&[Self]> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }
}

/// Block layout for one GGML storage type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GgmlBlockLayout {
    pub block_elements: u64,
    pub block_bytes: u64,
}

/// Storage formats needed by the staged Gemma checkpoint plus scalar GGUF types.
#[must_use]
pub const fn ggml_block_layout(ggml_type: u32) -> Option<GgmlBlockLayout> {
    let (block_elements, block_bytes) = match ggml_type {
        0 => (1, 4),       // F32
        1 | 30 => (1, 2),  // F16 / BF16
        2 => (32, 18),     // Q4_0
        3 => (32, 20),     // Q4_1
        6 => (32, 22),     // Q5_0
        7 => (32, 24),     // Q5_1
        8 => (32, 34),     // Q8_0
        9 => (32, 40),     // Q8_1
        10 => (256, 84),   // Q2_K
        11 => (256, 110),  // Q3_K
        12 => (256, 144),  // Q4_K
        13 => (256, 176),  // Q5_K
        14 => (256, 210),  // Q6_K
        15 => (256, 292),  // Q8_K
        24 => (1, 1),      // I8
        25 => (1, 2),      // I16
        26 => (1, 4),      // I32
        27 | 28 => (1, 8), // I64 / F64
        _ => return None,
    };
    Some(GgmlBlockLayout {
        block_elements,
        block_bytes,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GgufTensor {
    pub name: String,
    /// GGUF dimension order (`ne[0]` first), as stored in the file.
    pub shape: Vec<u64>,
    pub ggml_type: u32,
    /// Byte offset relative to the start of the GGUF data section.
    pub offset: u64,
    /// Exact payload bytes, excluding alignment before the following tensor.
    pub bytes: u64,
}

impl GgufTensor {
    #[must_use]
    pub fn elements(&self) -> u64 {
        self.shape.iter().product()
    }

    #[must_use]
    pub fn absolute_offset(&self, gguf: &Gguf) -> u64 {
        gguf.data_offset + self.offset
    }
}

/// Parsed GGUF directory. Tensor payloads stay on disk and are read on demand.
#[derive(Debug, Clone)]
pub struct Gguf {
    path: PathBuf,
    pub version: u32,
    pub file_bytes: u64,
    pub data_offset: u64,
    pub alignment: u64,
    pub metadata: BTreeMap<String, GgufValue>,
    pub tensors: BTreeMap<String, GgufTensor>,
}

impl Gguf {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GgufError> {
        let path = path.as_ref().to_path_buf();
        let file = File::open(&path)?;
        let file_bytes = file.metadata()?.len();
        let mut reader = BufReader::new(file);
        let mut magic = [0_u8; 4];
        reader.read_exact(&mut magic)?;
        if &magic != MAGIC {
            return Err(GgufError::Magic(magic));
        }
        let version = read_u32(&mut reader)?;
        if !matches!(version, 2 | 3) {
            return Err(GgufError::Version(version));
        }
        let tensor_count = checked_len(read_u64(&mut reader)?)?;
        let metadata_count = checked_len(read_u64(&mut reader)?)?;
        let mut metadata = BTreeMap::new();
        for _ in 0..metadata_count {
            let key = read_string(&mut reader)?;
            let value_type = read_u32(&mut reader)?;
            metadata.insert(key, read_value(&mut reader, value_type)?);
        }

        let mut raw_tensors = Vec::with_capacity(tensor_count);
        for _ in 0..tensor_count {
            let name = read_string(&mut reader)?;
            let dimensions = checked_len(u64::from(read_u32(&mut reader)?))?;
            let mut shape = Vec::with_capacity(dimensions);
            for _ in 0..dimensions {
                shape.push(read_u64(&mut reader)?);
            }
            let ggml_type = read_u32(&mut reader)?;
            let offset = read_u64(&mut reader)?;
            raw_tensors.push((name, shape, ggml_type, offset));
        }

        let alignment = metadata
            .get("general.alignment")
            .and_then(GgufValue::as_u64)
            .unwrap_or(DEFAULT_ALIGNMENT)
            .max(1);
        let directory_end = reader.stream_position()?;
        let data_offset = directory_end.div_ceil(alignment) * alignment;
        let data_bytes = file_bytes.saturating_sub(data_offset);
        let mut tensors = BTreeMap::new();

        for (name, shape, ggml_type, offset) in raw_tensors {
            let elements = shape
                .iter()
                .try_fold(1_u64, |acc, value| acc.checked_mul(*value))
                .ok_or_else(|| GgufError::TensorShape {
                    tensor: name.clone(),
                })?;
            let layout = ggml_block_layout(ggml_type).ok_or_else(|| GgufError::TensorType {
                tensor: name.clone(),
                ggml_type,
            })?;
            if elements % layout.block_elements != 0 {
                return Err(GgufError::TensorBlock {
                    tensor: name,
                    elements,
                    block_elements: layout.block_elements,
                });
            }
            let bytes = (elements / layout.block_elements)
                .checked_mul(layout.block_bytes)
                .ok_or_else(|| GgufError::TensorShape {
                    tensor: name.clone(),
                })?;
            let end = offset
                .checked_add(bytes)
                .ok_or_else(|| GgufError::TensorOffset {
                    tensor: name.clone(),
                    offset,
                    end: u64::MAX,
                    data_bytes,
                })?;
            if end > data_bytes {
                return Err(GgufError::TensorOffset {
                    tensor: name,
                    offset,
                    end,
                    data_bytes,
                });
            }
            let tensor = GgufTensor {
                name: name.clone(),
                shape,
                ggml_type,
                offset,
                bytes,
            };
            tensors.insert(name, tensor);
        }

        Ok(Self {
            path,
            version,
            file_bytes,
            data_offset,
            alignment,
            metadata,
            tensors,
        })
    }

    #[must_use]
    /// Read one tensor's packed bytes from the file.
    ///
    /// Normal loading streams straight from disk into device memory; this exists
    /// for the few weights that are stacked before upload (see `load_packed_pair`).
    pub fn read_tensor_bytes(&self, tensor: &GgufTensor) -> Result<Vec<u8>, GgufError> {
        use std::io::{Read as _, Seek as _, SeekFrom};
        let mut file = std::fs::File::open(self.path())?;
        file.seek(SeekFrom::Start(tensor.absolute_offset(self)))?;
        let mut bytes = vec![0_u8; usize::try_from(tensor.bytes).unwrap_or(0)];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn tensor(&self, name: &str) -> Option<&GgufTensor> {
        self.tensors.get(name)
    }

    /// Read one exact packed tensor payload, without any following alignment bytes.
    pub fn read_tensor(&self, name: &str) -> Result<Vec<u8>, GgufError> {
        let tensor = self
            .tensor(name)
            .ok_or_else(|| GgufError::MissingTensor(name.to_owned()))?;
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.data_offset + tensor.offset))?;
        let length = usize::try_from(tensor.bytes).map_err(|_| GgufError::TensorShape {
            tensor: name.to_owned(),
        })?;
        let mut data = vec![0_u8; length];
        file.read_exact(&mut data)?;
        Ok(data)
    }

    /// Read one row from a tensor whose first GGUF dimension is the row width.
    pub fn read_tensor_row(&self, name: &str, row: usize) -> Result<Vec<u8>, GgufError> {
        let tensor = self
            .tensor(name)
            .ok_or_else(|| GgufError::MissingTensor(name.to_owned()))?;
        let rows = tensor
            .shape
            .iter()
            .skip(1)
            .try_fold(1_u64, |acc, value| acc.checked_mul(*value))
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| GgufError::TensorShape {
                tensor: name.to_owned(),
            })?;
        if row >= rows {
            return Err(GgufError::TensorRow {
                tensor: name.to_owned(),
                row,
                rows,
            });
        }
        let row_bytes = usize::try_from(tensor.bytes).map_err(|_| GgufError::TensorShape {
            tensor: name.to_owned(),
        })? / rows;
        let offset = tensor
            .offset
            .checked_add(
                u64::try_from(row.checked_mul(row_bytes).ok_or_else(|| {
                    GgufError::TensorShape {
                        tensor: name.to_owned(),
                    }
                })?)
                .map_err(|_| GgufError::TensorShape {
                    tensor: name.to_owned(),
                })?,
            )
            .ok_or_else(|| GgufError::TensorShape {
                tensor: name.to_owned(),
            })?;
        let mut file = File::open(&self.path)?;
        file.seek(SeekFrom::Start(self.data_offset + offset))?;
        let mut data = vec![0_u8; row_bytes];
        file.read_exact(&mut data)?;
        Ok(data)
    }

    #[must_use]
    pub fn metadata_value(&self, key: &str) -> Option<&GgufValue> {
        self.metadata.get(key)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MetadataSummary {
    pub value_type: &'static str,
    pub display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TensorAudit {
    pub name: String,
    pub shape: Vec<u64>,
    pub ggml_type: u32,
    pub type_name: &'static str,
    pub offset: u64,
    pub bytes: u64,
    pub namespace: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GgufAudit {
    pub version: u32,
    pub file_bytes: u64,
    pub data_offset: u64,
    pub metadata_count: usize,
    pub tensor_count: usize,
    pub architecture: Option<String>,
    pub quantization_version: Option<u64>,
    pub alignment: u64,
    pub namespace_counts: BTreeMap<String, usize>,
    pub metadata: BTreeMap<String, MetadataSummary>,
    pub tensors: Vec<TensorAudit>,
}

pub fn audit_gguf(path: impl AsRef<Path>) -> Result<GgufAudit, GgufError> {
    let gguf = Gguf::open(path)?;
    let mut namespace_counts = BTreeMap::new();
    let tensors = gguf
        .tensors
        .values()
        .map(|tensor| {
            let namespace = tensor_namespace(&tensor.name);
            *namespace_counts.entry(namespace.clone()).or_insert(0) += 1;
            TensorAudit {
                name: tensor.name.clone(),
                shape: tensor.shape.clone(),
                ggml_type: tensor.ggml_type,
                type_name: ggml_type_name(tensor.ggml_type),
                offset: tensor.offset,
                bytes: tensor.bytes,
                namespace,
            }
        })
        .collect();
    let architecture = gguf
        .metadata_value("general.architecture")
        .and_then(GgufValue::as_str)
        .map(str::to_owned);
    let quantization_version = gguf
        .metadata_value("general.quantization_version")
        .and_then(GgufValue::as_u64);
    let metadata_count = gguf.metadata.len();
    let tensor_count = gguf.tensors.len();
    let metadata = gguf
        .metadata
        .iter()
        .map(|(key, value)| (key.clone(), summarize(value)))
        .collect();

    Ok(GgufAudit {
        version: gguf.version,
        file_bytes: gguf.file_bytes,
        data_offset: gguf.data_offset,
        metadata_count,
        tensor_count,
        architecture,
        quantization_version,
        alignment: gguf.alignment,
        namespace_counts,
        metadata,
        tensors,
    })
}

fn read_value(reader: &mut impl Read, value_type: u32) -> Result<GgufValue, GgufError> {
    Ok(match value_type {
        0 => GgufValue::U8(read_u8(reader)?),
        1 => GgufValue::I8(read_u8(reader)? as i8),
        2 => GgufValue::U16(read_u16(reader)?),
        3 => GgufValue::I16(read_u16(reader)? as i16),
        4 => GgufValue::U32(read_u32(reader)?),
        5 => GgufValue::I32(read_u32(reader)? as i32),
        6 => GgufValue::F32(f32::from_bits(read_u32(reader)?)),
        7 => GgufValue::Bool(read_u8(reader)? != 0),
        8 => GgufValue::String(read_string(reader)?),
        9 => {
            let element_type = read_u32(reader)?;
            let length = checked_len(read_u64(reader)?)?;
            let mut values = Vec::with_capacity(length);
            for _ in 0..length {
                values.push(read_value(reader, element_type)?);
            }
            GgufValue::Array(values)
        }
        10 => GgufValue::U64(read_u64(reader)?),
        11 => GgufValue::I64(read_u64(reader)? as i64),
        12 => GgufValue::F64(f64::from_bits(read_u64(reader)?)),
        value_type => return Err(GgufError::ValueType(value_type)),
    })
}

fn summarize(value: &GgufValue) -> MetadataSummary {
    let (value_type, display, length) = match value {
        GgufValue::U8(value) => ("u8", value.to_string(), None),
        GgufValue::I8(value) => ("i8", value.to_string(), None),
        GgufValue::U16(value) => ("u16", value.to_string(), None),
        GgufValue::I16(value) => ("i16", value.to_string(), None),
        GgufValue::U32(value) => ("u32", value.to_string(), None),
        GgufValue::I32(value) => ("i32", value.to_string(), None),
        GgufValue::F32(value) => ("f32", value.to_string(), None),
        GgufValue::Bool(value) => ("bool", value.to_string(), None),
        GgufValue::String(value) => ("string", value.clone(), Some(value.len())),
        GgufValue::Array(values) => {
            let sample = values
                .iter()
                .take(8)
                .map(scalar_display)
                .collect::<Vec<_>>()
                .join(", ");
            let suffix = if values.len() > 8 { ", …" } else { "" };
            ("array", format!("[{sample}{suffix}]"), Some(values.len()))
        }
        GgufValue::U64(value) => ("u64", value.to_string(), None),
        GgufValue::I64(value) => ("i64", value.to_string(), None),
        GgufValue::F64(value) => ("f64", value.to_string(), None),
    };
    MetadataSummary {
        value_type,
        display,
        length,
    }
}

fn scalar_display(value: &GgufValue) -> String {
    match value {
        GgufValue::String(value) => format!("{value:?}"),
        GgufValue::Array(values) => format!("array({})", values.len()),
        value => summarize(value).display,
    }
}

fn tensor_namespace(name: &str) -> String {
    if name.starts_with("blk.") {
        "text.block".to_owned()
    } else if name.starts_with("v.") {
        "vision".to_owned()
    } else if name.starts_with("a.") {
        "audio".to_owned()
    } else if name.starts_with("mm.") {
        "multimodal_projector".to_owned()
    } else {
        name.split('.').next().unwrap_or("other").to_owned()
    }
}

#[must_use]
pub const fn ggml_type_name(value: u32) -> &'static str {
    match value {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        6 => "Q5_0",
        7 => "Q5_1",
        8 => "Q8_0",
        9 => "Q8_1",
        10 => "Q2_K",
        11 => "Q3_K",
        12 => "Q4_K",
        13 => "Q5_K",
        14 => "Q6_K",
        15 => "Q8_K",
        16 => "IQ2_XXS",
        17 => "IQ2_XS",
        18 => "IQ3_XXS",
        19 => "IQ1_S",
        20 => "IQ4_NL",
        21 => "IQ3_S",
        22 => "IQ2_S",
        23 => "IQ4_XS",
        24 => "I8",
        25 => "I16",
        26 => "I32",
        27 => "I64",
        28 => "F64",
        29 => "IQ1_M",
        30 => "BF16",
        34 => "TQ1_0",
        35 => "TQ2_0",
        _ => "UNKNOWN",
    }
}

fn checked_len(value: u64) -> Result<usize, GgufError> {
    if value > MAX_COLLECTION_ITEMS {
        return Err(GgufError::CollectionLength(value));
    }
    usize::try_from(value).map_err(|_| GgufError::CollectionLength(value))
}

fn read_string(reader: &mut impl Read) -> Result<String, GgufError> {
    let length = read_u64(reader)?;
    if length > MAX_STRING_BYTES {
        return Err(GgufError::StringLength(length));
    }
    let mut bytes =
        vec![0_u8; usize::try_from(length).map_err(|_| GgufError::StringLength(length))?];
    reader.read_exact(&mut bytes)?;
    Ok(String::from_utf8(bytes)?)
}

fn read_u8(reader: &mut impl Read) -> Result<u8, std::io::Error> {
    let mut bytes = [0_u8; 1];
    reader.read_exact(&mut bytes)?;
    Ok(bytes[0])
}

fn read_u16(reader: &mut impl Read) -> Result<u16, std::io::Error> {
    let mut bytes = [0_u8; 2];
    reader.read_exact(&mut bytes)?;
    Ok(u16::from_le_bytes(bytes))
}

fn read_u32(reader: &mut impl Read) -> Result<u32, std::io::Error> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> Result<u64, std::io::Error> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_quantization_layouts_are_stable() {
        assert_eq!(ggml_type_name(2), "Q4_0");
        assert_eq!(ggml_type_name(14), "Q6_K");
        assert_eq!(ggml_type_name(30), "BF16");
        assert_eq!(
            ggml_block_layout(14),
            Some(GgmlBlockLayout {
                block_elements: 256,
                block_bytes: 210,
            })
        );
    }

    #[test]
    fn namespace_classifier_separates_modal_weights() {
        assert_eq!(tensor_namespace("blk.2.attn_q.weight"), "text.block");
        assert_eq!(tensor_namespace("v.patch_embd.weight"), "vision");
        assert_eq!(tensor_namespace("a.conv.weight"), "audio");
    }

    #[test]
    #[ignore = "requires the staged 3.35 GB Gemma GGUF"]
    fn staged_gemma_directory_and_exact_tensor_size_are_valid() {
        let gguf = Gguf::open("../../models/gemma-4-E2B_q4_0-it.gguf").unwrap();
        assert_eq!(gguf.version, 3);
        assert_eq!(gguf.tensors.len(), 541);
        let embedding = gguf.tensor("token_embd.weight").unwrap();
        assert_eq!(embedding.shape, [1536, 262_144]);
        assert_eq!(embedding.ggml_type, 14);
        assert_eq!(embedding.bytes, 330_301_440);
        assert_eq!(
            gguf.read_tensor_row("token_embd.weight", 2).unwrap().len(),
            1_260
        );
    }

    #[cfg(feature = "metal-kernels")]
    #[test]
    #[ignore = "requires the staged Gemma GGUF and Apple Metal"]
    fn staged_q6_k_embedding_rows_match_native_metal_exactly() {
        use burn::{
            backend::Metal,
            tensor::{DType, Int, Tensor, TensorData, TensorPrimitive},
        };
        use half::f16;
        use quixi_chat_kernels::{
            metal::dequant_gather,
            quant::{QuantFormat, dequantize_gather},
        };

        let gguf = Gguf::open("../../models/gemma-4-E2B_q4_0-it.gguf").unwrap();
        let source_rows = [2_usize, 105, 65_537, 262_143];
        let packed = source_rows
            .iter()
            .flat_map(|row| gguf.read_tensor_row("token_embd.weight", *row).unwrap())
            .collect::<Vec<_>>();
        let ids_data = vec![3_i32, 0, 2, 1];
        let ids_cpu = [3_u32, 0, 2, 1];
        let scale = 1_536_f32.sqrt();
        let expected = dequantize_gather(
            QuantFormat::Q6K,
            &packed,
            source_rows.len(),
            1_536,
            &ids_cpu,
            scale,
        )
        .unwrap()
        .into_iter()
        .map(|value| f16::from_f32(value).to_f32())
        .collect::<Vec<_>>();

        let device = Default::default();
        let table = Tensor::<Metal, 1, Int>::from_data(
            TensorData::new(packed.clone(), [packed.len()]),
            &device,
        )
        .cast(DType::U8)
        .into_primitive();
        let ids = Tensor::<Metal, 1, Int>::from_data(TensorData::new(ids_data, [4]), &device)
            .into_primitive();
        let output = Tensor::<Metal, 2>::zeros([4, 1_536], &device).cast(DType::F16);
        let TensorPrimitive::Float(output) = output.into_primitive() else {
            panic!("fp16 output must have a float primitive")
        };
        let output = dequant_gather(
            table,
            ids,
            output,
            QuantFormat::Q6K,
            source_rows.len(),
            1_536,
            scale,
        );
        let actual = Tensor::<Metal, 2>::from_primitive(TensorPrimitive::Float(output))
            .to_data()
            .convert::<f32>()
            .to_vec::<f32>()
            .unwrap();
        assert_eq!(actual, expected);
    }
}
