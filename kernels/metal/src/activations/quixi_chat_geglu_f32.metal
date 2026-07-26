// Fused GeGLU over a stacked gate/up projection.
//
// The FFN's `gelu_approximate(gate) * up` is, in framework ops, two slices of
// the stacked GEMV output plus GELU's own chain —
//   inner = (x + x^3 * 0.044715) * sqrt(2/pi);  x * (tanh(inner) + 1) * 0.5
// — and a final multiply: roughly ten dispatches over a 6,144 or 12,288 wide
// vector, once per layer, so ~350 dispatches per token.
//
// One dispatch instead. The gate and up halves are read straight out of the
// stacked buffer, so nothing is sliced and nothing is copied.

#include <metal_stdlib>
using namespace metal;

// params: [width]  — the output width; the input holds gate then up, 2*width.
kernel void quixi_chat_geglu_f32(
    device float *out [[buffer(0)]],
    device const float *gate_up [[buffer(1)]],
    device const uint *params [[buffer(2)]],
    uint group [[threadgroup_position_in_grid]],
    uint lane [[thread_position_in_threadgroup]],
    uint lanes [[threads_per_threadgroup]])
{
    const uint width = params[0];
    const uint index = group * lanes + lane;
    if (index >= width) {
        return;
    }

    // Matches burn's `gelu_approximate` term for term, including the constant
    // spelled as FRAC_2_SQRT_PI * FRAC_1_SQRT_2, so outputs do not drift.
    const float sqrt_2_over_pi = 0.7978845608028654f;
    const float g = gate_up[index];
    const float inner = (g + g * g * g * 0.044715f) * sqrt_2_over_pi;
    const float gelu = g * (precise::tanh(inner) + 1.0f) * 0.5f;

    out[index] = gelu * gate_up[index + width];
}
