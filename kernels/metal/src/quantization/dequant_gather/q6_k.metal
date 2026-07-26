#include <metal_stdlib>

using namespace metal;

kernel void dequant_gather_q6_K(
    device half* output [[buffer(0)]],
    device const uchar* table [[buffer(1)]],
    device const int* ids [[buffer(2)]],
    device const uint* raw_params [[buffer(3)]],
    uint index [[thread_position_in_grid]]) {
    const uint rows = raw_params[0];
    const uint columns = raw_params[1];
    const uint tokens = raw_params[2];
    const float scale = as_type<float>(raw_params[3]);
    const uint count = tokens * columns;
    if (index >= count) return;

    const uint token = index / columns;
    const uint column = index - token * columns;
    const int row = ids[token];
    if (row < 0 || uint(row) >= rows) {
        output[index] = half(0);
        return;
    }

    const uint blocks_per_row = columns / 256;
    const uint block_index = column / 256;
    const uint block_column = column - block_index * 256;
    device const uchar* block =
        table + (uint(row) * blocks_per_row + block_index) * 210;
    device const uchar* ql = block;
    device const uchar* qh = block + 128;
    device const char* sub_scales = (device const char*)(block + 192);
    const ushort d_bits = ushort(block[208]) | (ushort(block[209]) << 8);
    const half d = as_type<half>(d_bits);
    const uint chunk = block_column >> 7;
    const uint position = block_column & 127;
    const uint group = position >> 5;
    const uint lane = position & 31;
    const uchar ql_byte = ql[chunk * 64 + lane + 32 * (group & 1)];
    const uint nibble = (group & 2) ? (ql_byte >> 4) : (ql_byte & 0x0f);
    const uint high = (qh[chunk * 32 + lane] >> (2 * group)) & 3;
    const int quant = int(nibble | (high << 4)) - 32;
    const uint scale_index = chunk * 8 + (lane >> 4) + group * 2;
    const float value = float(d) * float(int(sub_scales[scale_index])) * float(quant);
    output[index] = half(value * scale);
}
