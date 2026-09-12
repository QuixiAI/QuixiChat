#include <metal_stdlib>

using namespace metal;

constant float MOLECULAI_NEG_INF = -3.4028234663852886e38f;

inline float quixi_chat_lmh_f16_to_f32(ushort value) {
    const uint sign = uint(value & 0x8000) << 16;
    const uint exponent = (value >> 10) & 0x1f;
    const uint mantissa = value & 0x03ff;
    if (exponent == 0) {
        const float magnitude = ldexp(float(mantissa), -24);
        return (sign != 0) ? -magnitude : magnitude;
    }
    if (exponent == 31) {
        return as_type<float>(sign | 0x7f800000 | (mantissa << 13));
    }
    return as_type<float>(sign | ((exponent + 112) << 23) | (mantissa << 13));
}

inline float quixi_chat_q6_k_dot(
    device const uchar* row_weights,
    device const float* input,
    uint blocks_per_row) {
    float sum = 0.0f;
    for (uint block_index = 0; block_index < blocks_per_row; ++block_index) {
        device const uchar* block = row_weights + block_index * 210;
        device const uchar* ql = block;
        device const uchar* qh = block + 128;
        device const char* scales = (device const char*)(block + 192);
        const ushort d_bits = ushort(block[208]) | (ushort(block[209]) << 8);
        const float d = quixi_chat_lmh_f16_to_f32(d_bits);
        for (uint chunk = 0; chunk < 2; ++chunk) {
            for (uint group = 0; group < 4; ++group) {
                for (uint item = 0; item < 32; ++item) {
                    const uchar ql_byte = ql[chunk * 64 + item + 32 * (group & 1)];
                    const uint nibble = (group & 2) ? (ql_byte >> 4) : (ql_byte & 0x0f);
                    const uint high = (qh[chunk * 32 + item] >> (2 * group)) & 3;
                    const int quant = int(nibble | (high << 4)) - 32;
                    const uint scale_index = chunk * 8 + (item >> 4) + group * 2;
                    const uint column = block_index * 256 + chunk * 128 + group * 32 + item;
                    sum += d * float(int(scales[scale_index])) * float(quant) * input[column];
                }
            }
        }
    }
    return sum;
}

// Each SIMD group owns a vocabulary tile. Its lanes walk independent rows,
// retaining only the tile maximum instead of materializing all logits.
kernel void quixi_chat_lm_head_q6_K_argmax_partials_f32(
    device const float* input [[buffer(0)]],
    device const uchar* weights [[buffer(1)]],
    device float* partial_values [[buffer(2)]],
    device int* partial_ids [[buffer(3)]],
    device const uint* params [[buffer(4)]],
    uint tile [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_simdgroup]]) {
    const uint rows = params[0];
    const uint columns = params[1];
    const uint tile_rows = params[2];
    const uint blocks_per_row = columns / 256;
    const uint row_bytes = blocks_per_row * 210;
    const uint first = tile * tile_rows;
    const uint last = min(first + tile_rows, rows);
    float best = MOLECULAI_NEG_INF;
    uint best_id = 0xffffffffu;
    for (uint row = first + lane; row < last; row += 32) {
        const float value = quixi_chat_q6_k_dot(weights + row * row_bytes, input, blocks_per_row);
        if (value > best || (value == best && row < best_id)) {
            best = value;
            best_id = row;
        }
    }
    const float group_best = simd_max(best);
    const uint candidate = best == group_best ? best_id : 0xffffffffu;
    const uint group_id = simd_min(candidate);
    if (lane == 0) {
        partial_values[tile] = group_best;
        partial_ids[tile] = int(group_id);
    }
}

kernel void quixi_chat_lm_head_argmax_reduce_f32(
    device const float* partial_values [[buffer(0)]],
    device const int* partial_ids [[buffer(1)]],
    device int* output [[buffer(2)]],
    device const uint* params [[buffer(3)]],
    uint lane [[thread_index_in_simdgroup]]) {
    const uint tiles = params[3];
    float best = MOLECULAI_NEG_INF;
    uint best_id = 0xffffffffu;
    for (uint tile = lane; tile < tiles; tile += 32) {
        const float value = partial_values[tile];
        const uint id = uint(partial_ids[tile]);
        if (value > best || (value == best && id < best_id)) {
            best = value;
            best_id = id;
        }
    }
    const float group_best = simd_max(best);
    const uint candidate = best == group_best ? best_id : 0xffffffffu;
    const uint group_id = simd_min(candidate);
    if (lane == 0) output[0] = int(group_id);
}
