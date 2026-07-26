#include <metal_stdlib>

using namespace metal;

kernel void dequant_gather_q8_0(
    device half* output [[buffer(0)]],
    device const uchar* table [[buffer(1)]],
    device const int* ids [[buffer(2)]],
    device const uint* raw_params [[buffer(3)]],
    uint index [[thread_position_in_grid]]) {
    const uint rows = raw_params[0];
    const uint columns = raw_params[1];
    const uint tokens = raw_params[2];
    const float scale = as_type<float>(raw_params[3]);
    if (index >= tokens * columns) return;
    const uint token = index / columns;
    const uint column = index - token * columns;
    const int row = ids[token];
    if (row < 0 || uint(row) >= rows) { output[index] = half(0); return; }
    const uint blocks_per_row = columns / 32;
    const uint block_index = column / 32;
    const uint block_column = column - block_index * 32;
    device const uchar* block = table + (uint(row) * blocks_per_row + block_index) * 34;
    const ushort d_bits = ushort(block[0]) | (ushort(block[1]) << 8);
    const half d = as_type<half>(d_bits);
    const char code = ((device const char*)(block + 2))[block_column];
    output[index] = half(float(d) * float(code) * scale);
}
