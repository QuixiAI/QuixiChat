// Fused f32 rotary position embedding.
//
// Replaces the framework expression
//   first = x[.., ..half]; second = x[.., half..]
//   rotated = cat(-second, first)
//   x * cos + rotated * sin
// which is two table slices, two input slices, a negate, a concat, two
// multiplies and an add — nine dispatches and seven intermediates, run once per
// attention projection. Across 35 layers that is ~50 calls and ~450 dispatches
// per token for an operation that reads and writes each row once.
//
// The position is baked into the cos/sin bindings by the host, which offsets
// each table to the row for this step. The kernel therefore takes no
// per-token parameters and its parameter buffer is built once at load.

#include <metal_stdlib>
using namespace metal;

// params: [rows, dim]
kernel void quixi_chat_rope_f32(
    device float *out [[buffer(0)]],
    device const float *input [[buffer(1)]],
    device const float *cos_row [[buffer(2)]],
    device const float *sin_row [[buffer(3)]],
    device const uint *params [[buffer(4)]],
    uint row [[threadgroup_position_in_grid]],
    uint lane [[thread_position_in_threadgroup]],
    uint lanes [[threads_per_threadgroup]])
{
    const uint dim = params[1];
    const uint half_dim = dim >> 1;

    device const float *x = input + (ulong)row * dim;
    device float *y = out + (ulong)row * dim;

    for (uint i = lane; i < dim; i += lanes) {
        // cat(-second, first): the lower half pairs with the upper half negated,
        // the upper half pairs with the lower half as-is.
        const float paired = (i < half_dim) ? -x[i + half_dim] : x[i - half_dim];
        y[i] = fma(x[i], cos_row[i], paired * sin_row[i]);
    }
}
