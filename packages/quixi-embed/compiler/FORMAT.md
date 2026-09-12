# `.qxmodel` v1 and `.qxtokenizer` v1

These are fixed Arctic XS data formats, not generic graph containers. All integers
are unsigned little-endian; weights are IEEE-754 FP32, row-major `[output,input]`.
The C loader supports little-endian targets only. Format changes require a version
change, compiler/loader update, and numerical/retrieval gates. There is no precision
conversion, tensor transpose, or quantization in v1.

## Full model

Maximum accepted size: 128 MiB. Header size: 128 bytes.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 8 | ASCII `QXARCTIC` |
| 8 | 4 | Version, 1 |
| 12 | 4 | Header bytes, 128 |
| 16 | 8 | Exact file bytes |
| 24 | 4 | Section count, 4 |
| 28 | 4 | FP32 layout flag, 1 |
| 32 | 32 | Frozen upstream safetensors SHA-256 |
| 64 | 32 | SHA-256 of all bytes after header |
| 96 | 8 | Section table offset, 128 |
| 104 | 8 | Section table bytes, 128 |
| 112 | 16 | Reserved zero bytes |

Four 32-byte section entries follow. Each is type u32, flags u32 (zero), offset
u64, byte length u64, count u64. Sections are ordered, nonoverlapping, 64-byte
aligned, and in bounds: tensor records (type 1, count 101), weights (type 2, count
101), vocabulary (type 3, count 30,522), Unicode tables (type 4, count 1).
The final section ends at file end. Compiler alignment padding is zero.

Each tensor record is 96 bytes: zero-terminated/zero-padded ASCII name[64],
absolute data offset u64, byte count u64, dimension 0 u32, dimension 1 u32,
rank u32, dtype u32 (1 means FP32). Vectors use dimension 1 = 1. Records follow
[the frozen inventory](../tests/goldens/tensor-inventory.json) order. Each weight
start is 64-byte aligned. The C loader validates every expected name, shape,
byte count, and **individual frozen tensor hash**, in addition to the package
payload hash; recomputing an altered package checksum cannot authorize new weights.

The vocabulary section contains the exact pinned UTF-8 `vocab.txt`, including its
final newline. The loader verifies its source hash, parses exactly 30,522 nonempty
lines, and constructs a bounded lookup table. Unicode data is checked against
[format-lock.json](format-lock.json), with its hash compiled into the runtime.

## Unicode section

The 24-byte header is `QXUNIC01`[8], deletion-range count u32, normalization-map
count u32, punctuation-range count u32, and UTF-8 pool byte count u32. It is followed
by deletion ranges (inclusive start/end u32 pairs), normalization mappings
(code point u32, pool offset u32, UTF-8 byte count u32), punctuation ranges
(start/end u32 pairs), and UTF-8 bytes. Ranges and mappings are ordered, unique,
in bounds, and limited to Unicode scalar values. Chinese boundaries use the
fixed BERT ranges in C. The table contains 288 deletion ranges, 14,286 mappings,
156 punctuation ranges, and 107,535 UTF-8 pool bytes.

The offline compiler queries the frozen fast tokenizer across every Unicode
scalar to generate these tables. Per-code-point NFD/mark removal/lowercasing is
composed by the streaming C tokenizer, which also recognizes literal special
strings, whitespace/punctuation/CJK boundaries, and greedy WordPiece. It retains
at most a 100-code-point pending word and 512 output IDs; it does not allocate
an input-sized normalized string. Valid input may contain embedded NULL. Malformed
UTF-8 is rejected, and raw input is capped at 1 MiB independently of token truncation.

## Tokenizer-only artifact

`.qxtokenizer` is capped at 2 MiB and contains no weights. Its header is 128 bytes:
`QXTOKEN1`[8], version u32 (1), header bytes u32 (128), exact total bytes u64,
vocabulary offset/bytes u64, Unicode offset/bytes u64, upstream source SHA-256[32],
payload SHA-256[32], and reserved zero[8]. Vocabulary starts at 128; Unicode starts
at the next 64-byte boundary after vocabulary. The loader validates both frozen
section hashes as well as the whole payload. This allows token-aware chunking
without downloading or initializing inference weights.

## Ownership and errors

Both loaders validate before allocating/copying the owned artifact. Their input
buffer always remains the caller's responsibility. The full model owns its copied
bytes and bounded vocabulary index. A separately allocated workspace reserves all
scratch for up to 512 tokens; ordinary execution allocates nothing. The scalar
batch adapter processes independent items serially with one workspace, preserving
input order and masking semantics without batch-proportional scratch.

Errors distinguish argument/limit, format, version, integrity, allocation, UTF-8,
nonfinite output, and workspace-in-use failures. A failed load returns no handle.
Free each successful handle exactly once; public TypeScript wrappers provide
idempotent disposal and reject subsequent use. WASM allocator memory may remain
reserved until the worker/instance is garbage-collected, though buffers become
reusable on free. Diagnostic stage storage and exports exist only in diagnostic
builds and add a fixed bounded allocation.
