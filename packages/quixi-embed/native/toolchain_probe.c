/* Build-feasibility evidence only; this is not an inference kernel benchmark. */
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

float qx_probe_dot4(const float *a, const float *b) {
#ifdef __wasm_simd128__
  v128_t product = wasm_f32x4_mul(wasm_v128_load(a), wasm_v128_load(b));
  return wasm_f32x4_extract_lane(product, 0) + wasm_f32x4_extract_lane(product, 1)
       + wasm_f32x4_extract_lane(product, 2) + wasm_f32x4_extract_lane(product, 3);
#else
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
#endif
}

#ifdef QX_PROBE_MAIN
int main(void) {
  const float a[4] = {1, 2, 3, 4}, b[4] = {5, 6, 7, 8};
  return qx_probe_dot4(a, b) == 70.0f ? 0 : 1;
}
#endif
