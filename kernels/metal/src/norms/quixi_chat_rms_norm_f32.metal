// Fused f32 RMSNorm.
//
// The vendored `norms/rms_norm` is bf16; Gemma's residual stream here is f32,
// and the Burn expression it replaces —
//   (x^2).mean() + eps  ->  ^-0.5  ->  * x  ->  * weight
// — is six dispatches and five intermediate allocations. Gemma 4 E2B runs six
// norms per layer across 35 layers, so that is ~1,260 dispatches per token
// spent on an operation that reads and writes each row exactly once.
//
// One threadgroup per row, one simdgroup per threadgroup: the reduction is a
// single `simd_sum` with no threadgroup memory and no barrier. Rows here are at
// most 1,536 wide, so 32 lanes each fold ≤48 elements.

#include <metal_stdlib>
using namespace metal;

// params: [rows, dim, flags, eps_bits]   flags: bit0 = weighted, bit1 = residual
//
// The residual add is folded in because `residual + norm(x)` appears three
// times per layer: as separate ops that is 105 extra dispatches and 105 extra
// full-width allocations per token, for one fused multiply-add.
kernel void quixi_chat_rms_norm_f32(
    device float *out [[buffer(0)]],
    device const float *input [[buffer(1)]],
    device const float *weight [[buffer(2)]],
    device const float *residual [[buffer(3)]],
    device const uint *params [[buffer(4)]],
    uint row [[threadgroup_position_in_grid]],
    uint lane [[thread_position_in_threadgroup]],
    uint lanes [[threads_per_threadgroup]])
{
    const uint dim = params[1];
    const bool has_weight = (params[2] & 1u) != 0u;
    const bool has_residual = (params[2] & 2u) != 0u;
    const float eps = as_type<float>(params[3]);

    device const float *x = input + (ulong)row * dim;
    device float *y = out + (ulong)row * dim;

    // Sum of squares across the row.
    float partial = 0.0f;
    for (uint i = lane; i < dim; i += lanes) {
        const float v = x[i];
        partial = fma(v, v, partial);
    }
    const float total = simd_sum(partial);

    // rsqrt(mean + eps) — matches (mean + eps)^-0.5 in the expression above.
    const float inverse = rsqrt(fma(total, 1.0f / (float)dim, eps));

    device const float *r = residual + (ulong)row * dim;
    for (uint i = lane; i < dim; i += lanes) {
        float value = x[i] * inverse;
        if (has_weight) {
            value *= weight[i];
        }
        y[i] = has_residual ? value + r[i] : value;
    }
}
