#ifndef QUIXI_EMBED_H
#define QUIXI_EMBED_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define QX_DIMENSION 384
#define QX_MAX_TOKENS 512
#define QX_MAX_TEXT_BYTES (1024u * 1024u)
#define QX_MAX_MODEL_BYTES (128u * 1024u * 1024u)
#define QX_MAX_OFFSET_TOKENS 65536u

typedef enum {
  QX_OK = 0, QX_ARGUMENT = 1, QX_LIMIT = 2, QX_FORMAT = 3, QX_VERSION = 4,
  QX_INTEGRITY = 5, QX_MEMORY = 6, QX_UTF8 = 7, QX_NONFINITE = 8, QX_BUSY = 9
} qx_status;
typedef enum { QX_DOCUMENT = 0, QX_QUERY = 1 } qx_role;
typedef struct qx_model qx_model;
typedef struct qx_workspace qx_workspace;
typedef struct qx_tokenizer qx_tokenizer;

typedef enum { QX_SOURCE = 0, QX_QUERY_PREFIX = 1, QX_FRAMING = 2 } qx_token_origin;
/* Half-open ranges in the original source domain selected by origin. Synthetic
   framing has zero ranges; literal special tokens retain source ranges. */
typedef struct {
  uint32_t id, byte_start, byte_end, utf16_start, utf16_end, origin;
} qx_token_offset;

/* Vocabulary/Unicode-only artifact: usable for chunking without model weights. */
qx_tokenizer *qx_tokenizer_load(const uint8_t *bytes, size_t length, int *status);
void qx_tokenizer_free(qx_tokenizer *tokenizer);
size_t qx_tokenizer_bytes(const qx_tokenizer *tokenizer);
int qx_tokenizer_encode(const qx_tokenizer *tokenizer, const uint8_t *text, size_t length,
                        uint32_t role, uint32_t *ids, uint32_t *count);
/* Full, untruncated tokenization; capacity is 2..65536 records, including framing
   and query prefix. On output-capacity QX_LIMIT, count is the exact required
   token count; ALL records must be ignored. Other errors set count to zero.
   Input is at most 1 MiB. No allocation is performed by either C function. */
int qx_tokenizer_encode_offsets(const qx_tokenizer *tokenizer, const uint8_t *text,
                               size_t length, uint32_t role, qx_token_offset *records,
                               uint32_t capacity, uint32_t *count);
int qx_tokenize_offsets(const qx_model *model, const uint8_t *text, size_t length,
                        uint32_t role, qx_token_offset *records, uint32_t capacity,
                        uint32_t *count);

/* Owned digest primitive for exact UTF-8 cache identities. Caller supplies32 bytes. */
void qx_sha256(const uint8_t *data, size_t length, uint8_t digest[32]);

/* Count includes framing and role prefix. 513 means overflow; larger totals are
   deliberately not counted. No truncated input is mistaken for an exact fit. */
int qx_tokenizer_inspect(const qx_tokenizer *tokenizer, const uint8_t *text, size_t length,
                       uint32_t role, uint32_t *count);
int qx_inspect_tokens(const qx_model *model, const uint8_t *text, size_t length,
                      uint32_t role, uint32_t *count);

/* Copies and owns a bounded, verified model package. Input ownership stays with
   the caller, on success and failure. Returns NULL and writes an explicit status. */
/* 0 = scalar FP32, 1 = explicit WASM SIMD FP32. */
uint32_t qx_backend(void);
qx_model *qx_model_load(const uint8_t *bytes, size_t length, int *status);
void qx_model_free(qx_model *model);
size_t qx_model_bytes(const qx_model *model);

/* One workspace belongs to one serial inference owner. Model weights are read-only
   and may be shared by distinct workspaces. No allocation occurs during inference. */
qx_workspace *qx_workspace_create(uint32_t max_tokens);
void qx_workspace_free(qx_workspace *workspace);
size_t qx_workspace_bytes(const qx_workspace *workspace);

/* UTF-8 bytes may include embedded NULL. Writes framing tokens plus content,
   truncating on the right; no padding. Caller supplies room for 512 uint32 IDs. */
int qx_tokenize(const qx_model *model, const uint8_t *text, size_t length,
                uint32_t role, uint32_t *ids, uint32_t *count);
/* IDs/masks are padded to tokens. Type IDs are implicitly zero. Output is 384
   normalized FP32 values; error output must not be consumed by the caller. */
int qx_embed_tokens(const qx_model *model, qx_workspace *workspace,
                    const uint32_t *ids, const uint32_t *mask, uint32_t tokens, float *output);
int qx_embed_document(const qx_model *model, qx_workspace *workspace,
                      const uint8_t *text, size_t length, float *output);
int qx_embed_query(const qx_model *model, qx_workspace *workspace,
                   const uint8_t *text, size_t length, float *output);
const char *qx_status_message(int status);

#ifdef QX_DIAGNOSTICS
/* Test build only: valid after a successful forward, until the next forward/free. */
const float *qx_diagnostic_stage(const qx_workspace *workspace, uint32_t stage);
const float *qx_diagnostic_pooled(const qx_workspace *workspace);
#endif
#ifdef __cplusplus
}
#endif
#endif
