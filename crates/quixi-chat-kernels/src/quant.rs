//! GGML-compatible packed-block decoding used as the native-kernel oracle.

use half::f16;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QuantFormat {
    Q4_0,
    Q8_0,
    Q6K,
}

impl QuantFormat {
    #[must_use]
    pub const fn block_elements(self) -> usize {
        match self {
            Self::Q4_0 | Self::Q8_0 => 32,
            Self::Q6K => 256,
        }
    }

    #[must_use]
    pub const fn block_bytes(self) -> usize {
        match self {
            Self::Q4_0 => 18,
            Self::Q8_0 => 34,
            Self::Q6K => 210,
        }
    }

    #[must_use]
    pub const fn from_ggml_type(ggml_type: u32) -> Option<Self> {
        match ggml_type {
            2 => Some(Self::Q4_0),
            8 => Some(Self::Q8_0),
            14 => Some(Self::Q6K),
            _ => None,
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum QuantError {
    #[error("column count {columns} is not divisible by the {block_elements}-element block")]
    ColumnBlock {
        columns: usize,
        block_elements: usize,
    },
    #[error("packed payload has {actual} bytes; expected {expected}")]
    PayloadSize { actual: usize, expected: usize },
    #[error("row id {row} is outside table with {rows} rows")]
    RowIndex { row: u32, rows: usize },
    #[error("packed-size arithmetic overflow")]
    SizeOverflow,
}

#[must_use]
pub fn packed_row_bytes(format: QuantFormat, columns: usize) -> Option<usize> {
    if !columns.is_multiple_of(format.block_elements()) {
        return None;
    }
    (columns / format.block_elements()).checked_mul(format.block_bytes())
}

/// Decode one packed row to f32 using the GGML block equations.
pub fn dequantize_row(
    format: QuantFormat,
    packed: &[u8],
    columns: usize,
    scale: f32,
) -> Result<Vec<f32>, QuantError> {
    let row_bytes = packed_row_bytes(format, columns).ok_or(QuantError::ColumnBlock {
        columns,
        block_elements: format.block_elements(),
    })?;
    if packed.len() != row_bytes {
        return Err(QuantError::PayloadSize {
            actual: packed.len(),
            expected: row_bytes,
        });
    }

    let mut output = vec![0.0_f32; columns];
    for (block_index, block) in packed.chunks_exact(format.block_bytes()).enumerate() {
        let start = block_index * format.block_elements();
        decode_block(
            format,
            block,
            &mut output[start..start + format.block_elements()],
        );
    }
    if scale != 1.0 {
        for value in &mut output {
            *value *= scale;
        }
    }
    Ok(output)
}

/// Gather and decode selected rows from a packed row-major table.
pub fn dequantize_gather(
    format: QuantFormat,
    packed: &[u8],
    rows: usize,
    columns: usize,
    ids: &[u32],
    scale: f32,
) -> Result<Vec<f32>, QuantError> {
    let row_bytes = packed_row_bytes(format, columns).ok_or(QuantError::ColumnBlock {
        columns,
        block_elements: format.block_elements(),
    })?;
    let expected = rows
        .checked_mul(row_bytes)
        .ok_or(QuantError::SizeOverflow)?;
    if packed.len() != expected {
        return Err(QuantError::PayloadSize {
            actual: packed.len(),
            expected,
        });
    }
    let output_len = ids
        .len()
        .checked_mul(columns)
        .ok_or(QuantError::SizeOverflow)?;
    let mut output = Vec::with_capacity(output_len);
    for &id in ids {
        let row = usize::try_from(id).map_err(|_| QuantError::RowIndex { row: id, rows })?;
        if row >= rows {
            return Err(QuantError::RowIndex { row: id, rows });
        }
        let offset = row * row_bytes;
        output.extend(dequantize_row(
            format,
            &packed[offset..offset + row_bytes],
            columns,
            scale,
        )?);
    }
    Ok(output)
}

/// Reference packed matrix-vector product with f32 accumulation.
pub fn dequantize_matvec(
    format: QuantFormat,
    packed: &[u8],
    rows: usize,
    columns: usize,
    input: &[f32],
) -> Result<Vec<f32>, QuantError> {
    if input.len() != columns {
        return Err(QuantError::PayloadSize {
            actual: input.len(),
            expected: columns,
        });
    }
    let row_bytes = packed_row_bytes(format, columns).ok_or(QuantError::ColumnBlock {
        columns,
        block_elements: format.block_elements(),
    })?;
    let expected = rows
        .checked_mul(row_bytes)
        .ok_or(QuantError::SizeOverflow)?;
    if packed.len() != expected {
        return Err(QuantError::PayloadSize {
            actual: packed.len(),
            expected,
        });
    }
    packed
        .chunks_exact(row_bytes)
        .map(|row| {
            Ok(dequantize_row(format, row, columns, 1.0)?
                .iter()
                .zip(input)
                .map(|(weight, input)| weight * input)
                .sum())
        })
        .collect()
}

/// Round a reference result exactly as an fp16-output native kernel does.
#[must_use]
pub fn to_f16_bits(values: &[f32]) -> Vec<u16> {
    values
        .iter()
        .map(|value| f16::from_f32(*value).to_bits())
        .collect()
}

fn decode_block(format: QuantFormat, block: &[u8], output: &mut [f32]) {
    debug_assert_eq!(block.len(), format.block_bytes());
    debug_assert_eq!(output.len(), format.block_elements());
    match format {
        QuantFormat::Q4_0 => decode_q4_0(block, output),
        QuantFormat::Q8_0 => decode_q8_0(block, output),
        QuantFormat::Q6K => decode_q6_k(block, output),
    }
}

fn f16_at(bytes: &[u8], offset: usize) -> f32 {
    f16::from_bits(u16::from_le_bytes([bytes[offset], bytes[offset + 1]])).to_f32()
}

fn decode_q4_0(block: &[u8], output: &mut [f32]) {
    let d = f16_at(block, 0);
    let qs = &block[2..18];
    for column in 0..32 {
        let byte = qs[column % 16];
        let nibble = if column < 16 { byte & 0x0f } else { byte >> 4 };
        output[column] = d * (f32::from(nibble) - 8.0);
    }
}

fn decode_q8_0(block: &[u8], output: &mut [f32]) {
    let d = f16_at(block, 0);
    for (value, code) in output.iter_mut().zip(&block[2..34]) {
        *value = d * f32::from(i8::from_ne_bytes([*code]));
    }
}

fn decode_q6_k(block: &[u8], output: &mut [f32]) {
    let ql = &block[..128];
    let qh = &block[128..192];
    let scales = &block[192..208];
    let d = f16_at(block, 208);

    for column in 0..256 {
        let chunk = column >> 7;
        let position = column & 127;
        let group = position >> 5;
        let lane = position & 31;
        let ql_byte = ql[chunk * 64 + lane + 32 * (group & 1)];
        let nibble = if (group & 2) == 0 {
            ql_byte & 0x0f
        } else {
            ql_byte >> 4
        };
        let high = (qh[chunk * 32 + lane] >> (2 * group)) & 3;
        let quant = i32::from(nibble | (high << 4)) - 32;
        let scale_index = chunk * 8 + (lane >> 4) + group * 2;
        let sub_scale = i32::from(i8::from_ne_bytes([scales[scale_index]]));
        output[column] = d * (sub_scale * quant) as f32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q4_0_nibble_order_matches_ggml() {
        let mut block = vec![0_u8; 18];
        block[..2].copy_from_slice(&f16::from_f32(0.5).to_bits().to_le_bytes());
        for (index, byte) in block[2..].iter_mut().enumerate() {
            *byte = ((15 - index) as u8) << 4 | index as u8;
        }
        let values = dequantize_row(QuantFormat::Q4_0, &block, 32, 1.0).unwrap();
        assert_eq!(values[0], -4.0);
        assert_eq!(values[15], 3.5);
        assert_eq!(values[16], 3.5);
        assert_eq!(values[31], -4.0);
    }

    #[test]
    fn q8_0_signed_codes_are_preserved() {
        let mut block = vec![0_u8; 34];
        block[..2].copy_from_slice(&f16::from_f32(0.25).to_bits().to_le_bytes());
        block[2] = (-128_i8).to_ne_bytes()[0];
        block[3] = 127;
        let values = dequantize_row(QuantFormat::Q8_0, &block, 32, 2.0).unwrap();
        assert_eq!(values[0], -64.0);
        assert_eq!(values[1], 63.5);
    }

    #[test]
    fn q6_k_extracts_low_high_and_signed_scale_bits() {
        let mut block = vec![0_u8; 210];
        block[208..].copy_from_slice(&f16::from_f32(0.5).to_bits().to_le_bytes());
        block[0] = 0x21;
        block[32] = 0x21;
        block[128] = 0b11_10_01_00;
        block[192] = (-2_i8).to_ne_bytes()[0];
        block[194] = 3;
        block[196] = 4;
        block[198] = 5;
        let values = dequantize_row(QuantFormat::Q6K, &block, 256, 1.0).unwrap();
        assert_eq!(values[0], 31.0); // (1 - 32) * -2 * .5
        assert_eq!(values[32], -22.5); // (2 + 16 - 32) * 3 * .5
        assert_eq!(values[64], 4.0); // (2 + 32 - 32) * 4 * .5
        assert_eq!(values[96], 45.0); // (2 + 48 - 32) * 5 * .5
    }

    #[test]
    fn gather_checks_rows_and_preserves_id_order() {
        let mut row = vec![0_u8; 18];
        row[..2].copy_from_slice(&f16::from_f32(1.0).to_bits().to_le_bytes());
        let mut other = row.clone();
        other[2..].fill(0xff);
        let table = [row, other].concat();
        let values = dequantize_gather(QuantFormat::Q4_0, &table, 2, 32, &[1, 0], 1.0).unwrap();
        assert_eq!(values[0], 7.0);
        assert_eq!(values[32], -8.0);
    }
}
