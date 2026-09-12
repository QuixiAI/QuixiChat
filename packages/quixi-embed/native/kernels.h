#ifndef QX_KERNELS_H
#define QX_KERNELS_H
#include <stdint.h>
#ifdef QX_SIMD
#include <wasm_simd128.h>
#endif
/* Frozen graph widths are 32, 384 and 1536: all divisible by four.
 * Preserve the scalar four-accumulator order; do not contract multiply/add. */
static inline float qx_dot(const float *a,const float *b,uint32_t count) {
#ifdef QX_SIMD
  v128_t sum=wasm_f32x4_splat(0);
  for(uint32_t i=0;i<count;i+=4)
    sum=wasm_f32x4_add(sum,wasm_f32x4_mul(wasm_v128_load(a+i),wasm_v128_load(b+i)));
  return (wasm_f32x4_extract_lane(sum,0)+wasm_f32x4_extract_lane(sum,1))+
         (wasm_f32x4_extract_lane(sum,2)+wasm_f32x4_extract_lane(sum,3));
#else
  float s0=0,s1=0,s2=0,s3=0;
  for(uint32_t i=0;i<count;i+=4) {s0+=a[i]*b[i];s1+=a[i+1]*b[i+1];s2+=a[i+2]*b[i+2];s3+=a[i+3]*b[i+3];}
  return (s0+s1)+(s2+s3);
#endif
}
static inline void qx_axpy(float *output,const float *value,float probability,uint32_t count) {
#ifdef QX_SIMD
  v128_t probability4=wasm_f32x4_splat(probability);
  for(uint32_t j=0;j<count;j+=4)
    wasm_v128_store(output+j,wasm_f32x4_add(wasm_v128_load(output+j),wasm_f32x4_mul(probability4,wasm_v128_load(value+j))));
#else
  for(uint32_t j=0;j<count;j++) output[j]+=probability*value[j];
#endif
}
#endif
