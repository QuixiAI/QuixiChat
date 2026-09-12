#ifndef QX_SHA256_H
#define QX_SHA256_H
#include <stddef.h>
#include <stdint.h>
void qx_sha256(const uint8_t *data, size_t length, uint8_t digest[32]);
#endif
