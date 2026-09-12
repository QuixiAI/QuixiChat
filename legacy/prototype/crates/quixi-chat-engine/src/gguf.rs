//! Pure-Rust GGUF v2/v3 metadata, tensor-directory, and payload reader.

use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

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

/// Storage formats used by the pinned Gemma checkpoint.
#[must_use]
pub const fn ggml_block_layout(ggml_type: u32) -> Option<GgmlBlockLayout> {
    let (block_elements, block_bytes) = match ggml_type {
        0 => (1, 4),      // F32
        1 => (1, 2),      // F16
        2 => (32, 18),    // Q4_0
        14 => (256, 210), // Q6_K
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
    pub fn absolute_offset(&self, gguf: &Gguf) -> u64 {
        gguf.data_offset + self.offset
    }
}

/// Parsed GGUF directory. Tensor payloads stay on disk and are read on demand.
#[derive(Debug, Clone)]
pub struct Gguf {
    path: PathBuf,
    pub data_offset: u64,
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
            data_offset,
            metadata,
            tensors,
        })
    }

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

    #[must_use]
    pub fn metadata_value(&self, key: &str) -> Option<&GgufValue> {
        self.metadata.get(key)
    }
}

fn read_value(reader: &mut impl Read, value_type: u32) -> Result<GgufValue, GgufError> {
    Ok(match value_type {
        0 => GgufValue::U8(read_u8(reader)?),
        1 => GgufValue::I8(read_u8(reader)?.cast_signed()),
        2 => GgufValue::U16(read_u16(reader)?),
        3 => GgufValue::I16(read_u16(reader)?.cast_signed()),
        4 => GgufValue::U32(read_u32(reader)?),
        5 => GgufValue::I32(read_u32(reader)?.cast_signed()),
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
        11 => GgufValue::I64(read_u64(reader)?.cast_signed()),
        12 => GgufValue::F64(f64::from_bits(read_u64(reader)?)),
        value_type => return Err(GgufError::ValueType(value_type)),
    })
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
        assert_eq!(
            ggml_block_layout(14),
            Some(GgmlBlockLayout {
                block_elements: 256,
                block_bytes: 210,
            })
        );
    }
}
