# Original-source tokenizer offsets

CPU artifact **1.0.2** adds `ArcticTokenizer.tokenizeWithOffsets`. It loads the
514,223-byte `.qxtokenizer` vocabulary/Unicode artifact independently of model
weights, inference, storage, or a UI. The C implementation carries original
coordinates through normalization and WordPiece. It does not reconstruct spans
by decoding token IDs or searching for token strings in the input.

```ts
import {
  createArcticTokenizer, TOKEN_ORIGIN, TokenOffsetCapacityError,
} from '@quixi/quixi-embed/tokenizer';

const tokenizer = await createArcticTokenizer({wasm, tokenizer: tokenizerBytes});
try {
  const result = tokenizer.tokenizeWithOffsets(text, {
    role: 'document', maxTokens: 8192,
  });
  for (let i = 0; i < result.tokenCount; i++) {
    if (result.origins[i] !== TOKEN_ORIGIN.source) continue;
    const start = result.utf16Offsets[i * 2]!;
    const end = result.utf16Offsets[i * 2 + 1]!;
    // These positions refer to the original supplied string.
    consumeSourceSpan(start, end);
  }
} catch (error) {
  if (error instanceof TokenOffsetCapacityError) {
    // No partial result was returned. The required count is exact.
    handleCapacity(error.capacity, error.requiredTokens);
  } else {
    throw error;
  }
} finally {
  tokenizer.dispose();
}
```

The result owns copied `ids: Uint32Array`, flattened `[start,end)` pairs in
`byteOffsets: Uint32Array` and `utf16Offsets: Uint32Array`, and
`origins: Uint8Array`. `tokenCount` is their complete token count;
`inputBytes` and `inputUtf16Units` describe the source text alone. Returned arrays
do not alias WASM memory or subsequent results. Caller-retained results are the
caller's memory responsibility.

## Coordinates and normalization

| Origin | Value | Coordinate domain |
| --- | ---: | --- |
| `TOKEN_ORIGIN.source` | 0 | Original supplied source text |
| `TOKEN_ORIGIN.queryPrefix` | 1 | Frozen `ARCTIC_QUERY_PREFIX` string, relative to that string |
| `TOKEN_ORIGIN.framing` | 2 | Synthetic CLS/SEP; both ranges are `[0,0)` |

Native byte positions refer to the exact validated UTF-8 input. JavaScript byte
positions refer to `TextEncoder(text)`; isolated surrogates become U+FFFD, exactly
as in existing inference. UTF-16 positions retain the original JavaScript string's
code-unit coordinates, including isolated-surrogate positions. Astral characters
span two UTF-16 units. These coordinates are relative to the provided text, not
an enclosing file, PDF, source part or another encoding. The owner adds its source
base offset and retains the original text needed for slicing.

The tokenizer preserves source provenance through lowercasing, decomposition,
deletion, Chinese/punctuation boundaries and WordPiece segmentation. A token's
range bounds the original characters contributing to it. Several normalized
pieces may derive from one original character, so ranges can overlap. Removed
characters before/after a token need not be covered; removed characters inside
its bounding range remain inside that range. Offsets are not a partition of the
input, and they do not guarantee grapheme boundaries.

- `cafe\u0301` produces a token whose UTF-16 range is `[0,4)`; the final combining
  mark remains an uncovered source gap.
- `각` produces three WordPieces, each with byte range `[0,3)` and UTF-16 range
  `[0,1)`. There is no independent source cut between those pieces.
- Literal `[CLS]` in the source retains its actual `[0,5)` source range and
  origin 0, even though its ID equals the synthetic framing ID. Classify by origin.
- Query encoding adds eight fixed-prefix tokens plus CLS/SEP. Prefix ranges do
  not shift source coordinates. A caller-supplied heading/context prefix is
  ordinary input text; only the model's fixed query prefix receives origin 1.

### Known upstream alignment discrepancy

The frozen fast tokenizer remains the authority for IDs and normalization.
Its original-offset metadata has a demonstrated discrepancy in some mixed
combining sequences. For `a\u1dce\u1b44`, normalization removes U+1DCE and keeps
U+1B44 from original scalar position 2. The upstream `[UNK]` range is `[0,2)` in
scalar coordinates, excluding that contributor. This API returns the actual
contributor bounding range `[0,3)` in UTF-16 and `[0,7)` in UTF-8.

The [hand-specified contributor fixtures](../tests/token-offset-contributor-cases.json)
record original contributor positions and normalized strings. Both roles are
checked against pinned IDs/normalization; 16 cases deliberately differ from
upstream offset metadata, with another 12 control cases agreeing. All other
focused/exhaustive fixtures use the upstream offsets and independently computed
original UTF-8/UTF-16 boundaries. This is not a claim of universal upstream offset
parity. Hugging Face documents the intended
[normalization alignment](https://huggingface.co/docs/tokenizers/components) and
[original-text offset API](https://www.huggingface.co/docs/tokenizers/python/latest/quicktour.html);
the exception here is specific to the frozen 0.21.0 behavior reproduced in the
[recorded evidence](../tests/reports/offsets-2026-09-08/README.md).

## Bounds and failure semantics

Input is capped at **1 MiB of UTF-8**. `maxTokens` defaults to **8,192** and accepts
integer capacities **2..65,536**, including framing and query-prefix tokens. The
API is untruncated. If a valid input needs more records, it scans the bounded
input to obtain the exact full count and throws `TokenOffsetCapacityError` with
`code: 'offset-capacity'`, `capacity` and `requiredTokens`. No partial arrays are
returned. A larger capacity can be retried only within the hard maximum; otherwise
split the source structurally and tokenize the smaller pieces.

The native `qx_tokenizer_encode_offsets` / `qx_tokenize_offsets` ABI takes caller
storage for `capacity` six-u32 records (`qx_token_offset`, exactly 24 bytes).
`QX_OK` writes the complete count. Output-capacity `QX_LIMIT` writes the exact
required count, and **all records must be ignored**. Other errors set count to
zero, including an input exceeding 1 MiB (`QX_LIMIT`), malformed UTF-8 (`QX_UTF8`),
or invalid arguments/capacity (`QX_ARGUMENT`). C performs no heap allocation in
this operation. Count/capacity arithmetic is bounded before buffer access;
the frozen normalization expands a scalar into at most three scalars, keeping
full count arithmetic safely within u32 at this input ceiling.

| Resource | Bound or measured value |
| --- | ---: |
| Owned C tokenizer/vocabulary tables | 959,947 bytes |
| Existing UTF-8 input scratch | 1,048,576 bytes |
| Temporary C output records | `24 * maxTokens`, at most 1,572,864 bytes |
| Explicit per-byte provenance stack array | 6,400 bytes |
| Pinned compiler's tokenizer-frame sum on the offset call path | 8,560 bytes; excludes caller/libc frames |
| Existing reserved WASM stack | 1,048,576 bytes |
| Returned typed-array data | `21 * tokenCount`, at most 1,376,256 bytes |
| Standalone WASM linear memory in maximum-capacity tests | Fixed 16,777,216 bytes |

The facade frees temporary output storage on success and rejection. `memory()`
exposes current `offsetScratchBytes` and lifetime `peakOffsetScratchBytes`, alongside
existing tokenizer and linear-memory sizes. These figures exclude caller inputs,
retained output arrays, JavaScript object/VM overhead and OS RSS. Disposal releases
owned C allocations and rejects later calls. The calls are synchronous; use a
dedicated worker and yield between bounded source blocks.

## Chunker integration

Shared structural/FTS chunks remain available without a model or tokenizer. The
optional model-aware stage can use these offsets to propose original-source cuts,
while preserving all original text, including uncovered gaps. Never treat
overlapping spans as separate source characters or cut a surrogate pair.

Cutting a substring can change its WordPiece segmentation. Token counts obtained
from the longer input therefore do not prove that a slice fits the model. After
each proposed cut, construct the exact embedding text (including any caller
context prefix) and call `inspect(text, role)` again. Only a non-overflow result
with at most 512 tokens proves admission; documents reserve two framing tokens,
queries reserve ten framing/prefix tokens. Keep the scheduler's separate UTF-8
input-byte limit too. Offset capacity is not model capacity.

The app owns the chunk policy/version, source base offsets, metadata and durable
publication. Version the policy when adopting this original-contributor mapping;
the model/tokenizer data format remains v1 and the new runtime distribution is
1.0.2. Older 1.0.0/1.0.1 distributions remain intact. Their legacy `tokenize` and
1.0.1 `inspect` still work; calling the new offset method against an older binary
fails explicitly instead of approximating offsets.

## Reproduction

From the repository root after `npm ci`:

```sh
python3 packages/quixi-embed/native/offset_ci.py
```

This explicitly provisions the verified reference environment and public assets,
rebuilds and verifies CPU artifacts, and runs native/oracle, scalar/SIMD WASM,
ASan/UBSan, pinned compiler stack and three-engine browser checks. Prerequisites
are uv, Python, clang, Docker, Node and Playwright OS libraries; supported
provisioning hosts are Linux x86_64 and macOS arm64. `--skip-provision` requires
existing verified assets, reference environment and browser binaries; it still
compiles native safety and the Docker stack probe. `--full` also rebuilds diagnostic
native/scalar/SIMD and runs all 159 frozen numerical cases per route. See the
[evidence index](../tests/reports/offsets-2026-09-08/README.md) for actual host coverage.
