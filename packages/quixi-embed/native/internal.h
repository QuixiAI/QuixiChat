#ifndef QX_INTERNAL_H
#define QX_INTERNAL_H
#include "quixi_embed.h"
#include <stdint.h>
#define QX_VOCAB 30522u
#define QX_HASH_SLOTS 65536u
#define QX_D 384u
#define QX_F 1536u
static inline uint32_t qx_u32(const uint8_t *p) {
  return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);
}
static inline uint64_t qx_u64(const uint8_t *p) { return qx_u32(p)|((uint64_t)qx_u32(p+4)<<32); }
typedef struct {
  const float *qw,*qb,*kw,*kb,*vw,*vb,*ow,*ob,*an_w,*an_b,*fw,*fb,*dw,*db,*fn_w,*fn_b;
} qx_layer;
struct qx_model {
  uint8_t *data;size_t length;
  const float *word,*position,*type,*en_w,*en_b;
  qx_layer layer[6];
  const uint8_t *vocab;
  uint32_t vocab_offsets[QX_VOCAB];uint16_t vocab_lengths[QX_VOCAB];uint32_t vocab_hash[QX_HASH_SLOTS];
  const uint8_t *deletion,*mapping,*punctuation,*utf8;
  uint32_t deletion_count,mapping_count,punctuation_count,utf8_size;
};
int qx_vocabulary_init(qx_model *model, const uint8_t *data, size_t length);
int qx_unicode_init(qx_model *model, const uint8_t *data, size_t length);
#endif
