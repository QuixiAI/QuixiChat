#include <metal_stdlib>

using namespace metal;

inline float quixi_chat_f16_to_f32(ushort value) {
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

kernel void quixi_chat_qgemv_q4_0_f32(
    device float* output [[buffer(0)]],
    device const uchar* weights [[buffer(1)]],
    device const float* input [[buffer(2)]],
    device const uint* params [[buffer(3)]],
    uint2 group [[threadgroup_position_in_grid]],
    uint lane [[thread_index_in_simdgroup]]) {
    const uint rows = params[0];
    const uint columns = params[1];
    const uint row = group.x + group.y * params[2];
    if (row >= rows) return;
    const uint blocks_per_row = columns / 32;
    device const uchar* row_weights = weights + row * blocks_per_row * 18;
    const uint block_offset = lane >> 1;
    const uint byte_start = (lane & 1) * 8;
    float sum = 0.0f;
    for (uint block_index = block_offset; block_index < blocks_per_row; block_index += 16) {
        device const uchar* block = row_weights + block_index * 18;
        const ushort scale_bits = ushort(block[0]) | (ushort(block[1]) << 8);
        const float scale = quixi_chat_f16_to_f32(scale_bits);
        device const uchar* qs = block + 2 + byte_start;
        const uint input_start = block_index * 32 + byte_start;
        #pragma clang loop unroll(full)
        for (uint index = 0; index < 8; ++index) {
            const uchar packed = qs[index];
            sum += scale * float(int(packed & 0x0f) - 8) * input[input_start + index];
            sum += scale * float(int(packed >> 4) - 8) * input[input_start + index + 16];
        }
    }
    sum = simd_sum(sum);
    if (lane == 0) output[row] = sum;
}
