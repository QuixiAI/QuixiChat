#include <metal_stdlib>

using namespace metal;

inline float quixi_chat_f16_to_f32_q6(ushort value) {
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

kernel void quixi_chat_qgemv_q6_K_f32(
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
    const uint blocks_per_row = columns / 256;
    device const uchar* row_weights = weights + row * blocks_per_row * 210;
    float sum = 0.0f;
    for (uint block_index = 0; block_index < blocks_per_row; ++block_index) {
        device const uchar* block = row_weights + block_index * 210;
        device const uchar* ql = block;
        device const uchar* qh = block + 128;
        device const char* scales = (device const char*)(block + 192);
        const ushort d_bits = ushort(block[208]) | (ushort(block[209]) << 8);
        const float d = quixi_chat_f16_to_f32_q6(d_bits);
        for (uint chunk = 0; chunk < 2; ++chunk) {
            for (uint group = 0; group < 4; ++group) {
                const uchar ql_byte = ql[chunk * 64 + lane + 32 * (group & 1)];
                const uint nibble = (group & 2) ? (ql_byte >> 4) : (ql_byte & 0x0f);
                const uint high = (qh[chunk * 32 + lane] >> (2 * group)) & 3;
                const int quant = int(nibble | (high << 4)) - 32;
                const uint scale_index = chunk * 8 + (lane >> 4) + group * 2;
                const uint column = block_index * 256 + chunk * 128 + group * 32 + lane;
                sum += d * float(int(scales[scale_index])) * float(quant) * input[column];
            }
        }
    }
    sum = simd_sum(sum);
    if (lane == 0) output[row] = sum;
}
