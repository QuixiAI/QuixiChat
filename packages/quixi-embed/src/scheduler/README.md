# Bounded embedding service

`createEmbeddingScheduler` coordinates one owned executor in a dedicated worker.
It is exported from the package root and `@quixi/quixi-embed/worker`; importing
either entry starts no worker, model download, database, or inference. The worker
owner supplies assets, executor factories, private cache storage, and RPC. See
[the public types](types.ts), [adapters](executors.ts), and [browser worker integration](../../tests/scheduler/worker.ts).

Priorities are interactive query (0), current document (1), new content (2),
recent imports (3), and archive backfill (4). Selection happens after the current
complete dispatch. A queued duplicate promoted to priority 0 takes effect at the
next eligible boundary. FIFO aging raises background work by one class every
eight dispatches, stopping at class 1; sustained interactive work can delay all
background classes. Queries and every priority-0 request dispatch singly.

CPU adapters execute one request and yield through a macrotask before selecting
again. GPU backgrounds default to four requests and 2,048 **padded** tokens:
batch size multiplied by the longest token sequence. Role, priority, executor
capacity and token budgets determine each batch. No existing C forward pass or
submitted GPU graph can be interrupted. The renderer remains independent when
this service runs in its dedicated worker. The measured Apple M5 Max development
final provisioned runs include 0.71–0.78-second SIMD and 1.51–1.82-second scalar
512-token dispatches;
the current-dispatch delay remains visible to new queries. GPU batch-4 guidance
comes from [plan 19 measurements](../../perf/results/2026-09-08-gpu-development-load/README.md).

## Admission and ownership

| Resource | Default bound |
| --- | ---: |
| Unique admitted jobs | 256 |
| Admitted consumers / consumers for one job | 1,024 / 64 |
| One UTF-8 input / total accounted admission | 64 KiB / 8 MiB |
| Hot vectors / accounted hot-cache bytes | 2,048 / 16 MiB |
| Actually unresolved private-store calls / accounted bytes | 8 / 1 MiB |
| Private-store observation timeout | 50 ms |
| GPU background requests / padded tokens | 4 / 2,048 |
| CPU requests / tokens per dispatch | 1 / 512 |
| Snapshot drain observers | 64 |

Limits are configurable positive integers; input is capped at 1 MiB, batches at
32, and storage observation at one second. Admission accounting conservatively
includes text, UTF-8 bytes, cache keys and fixed job overhead. Consumer counts,
batch output count, cache bytes, rolling statistics (16 samples) and drain
observers have separate bounds. These are owned resource budgets, not a claim
about exact JavaScript engine heap sizes or vectors retained by consumers.
Saturation rejects a ticket with `SchedulerError.code === 'saturated'`; the owner
must pace a backfill producer and retry after capacity becomes available.

`CpuEncoder.inspect` and the independently usable `ArcticTokenizer.inspect`
require CPU artifact **1.0.1**. Owned C tokenization counts framing and the query
prefix without truncating accepted input. Count saturates at **513**, reporting
overflow past the model's 512-token limit. The scheduler rejects overflow as
`oversized`, so a chunker bug cannot silently discard a suffix. Existing
`tokenize()` retains the model's historical right-truncation contract. Inspection
does not expose full token streams or source offsets; model-aware chunking still
needs that separate interface.

Semantic identity is copied and frozen per service: model hash, compiled artifact
hash, tokenizer/preprocessing/chunking versions and query prefix. Each cache key
also contains the query/document role and the owned C SHA-256 of the exact UTF-8
input. Normalization is not used to merge inputs. JavaScript's isolated-surrogate
replacement follows TextEncoder, so strings encoding to the same UTF-8 bytes
share work. Keys contain digests rather than raw input text. Use a new service
after any semantic identity change; an incompatible request assertion is rejected.
Each consumer receives an independent vector copy, including singleflight and
cache hits. Cached vectors must contain 384 finite, approximately unit values.

## Cancellation, controls, and fallback

A ticket's `cancel()` or AbortSignal affects that consumer only. Work remains
admitted while another consumer needs it. A cancelled final queued consumer
releases its job immediately; an active graph may finish, but its abandoned
result is neither delivered nor cached. A new consumer may join that still-active
graph. The owner must also reject late RPC replies using its producer generation
before publishing vectors or checkpoints.

`pauseBackground()` preserves admitted work and interactive dispatch.
`resumeBackground()` restarts it. `drainBackground()` rejects new background
admission, completes admitted background consumers, then remains paused;
interactive queries remain usable. `drain()` snapshots current consumers, so
future submissions do not extend it. `shutdown('drain')` finishes existing work
and disposes the executor; default `shutdown('cancel')` rejects consumers,
disposes immediately, and ignores late results. Shutdown is idempotent.

`createSchedulerWithFallback` returns the initial GPU error separately for UI
diagnostics and creates the CPU executor when GPU initialization fails. A typed
recoverable GPU execution/device error disposes that executor, requeues unfinished
work, and creates the CPU executor once. New interactive requests outrank the
retried background batch. CPU failures and malformed outputs disable the service;
no incomplete or invalid vector is published.

For GPU use, supply `preflight` from a model-owned C tokenizer that survives GPU
disposal and CPU initialization. `gpuSchedulerExecutor` owns the GPU encoder,
while the caller owns this independent tokenizer and disposes it after scheduler
shutdown. That tokenizer uses its own 16 MiB WASM instance. CPU-only callers can
use the encoder's inspector without another instance. Factories own cleanup of
partial initialization failures; successfully returned executors belong to the
scheduler. Assets, backend selection and worker lifetime belong to the caller.

## Storage and progress

The optional `EmbeddingCacheStore` only has bounded `get`/`put` calls. Its owner
chooses private storage, applies eviction and handles generations. A timed-out
underlying call retains its operation/byte permit until it actually settles;
hung storage cannot accumulate unbounded pending calls. Unavailable capacity,
errors, corrupt entries and timeouts become cache misses. A pending interactive
lookup prevents background dispatch until its bounded observation finishes.
An already-started storage write can finish after cancellation or shutdown; the
adapter must enforce its own publication/generation rules.

Statistics report route, queue/resources, cache/singleflight/cancellation,
dispatches, fallback and inference completions. Document throughput counts distinct inference jobs; cache hits and joiners do
not inflate it. It uses wall time
including admission, task yields, cache checks and intervening queries while a
backlog exists. ETA is approximate: by default it covers admitted document jobs;
`statistics(remainingDocuments)` uses the owner's larger remaining-work estimate.
Paused/unavailable/closed services report no ETA. These completions are explicitly
**not durable**. Only storage can report indexed chunks, persisted checkpoints,
resume state, or publication success. Browser visibility and app controls invoke
this API through the owning worker; this package does not observe UI state.

## Reproduction

From the repository root after `npm ci`, with the Linux x86_64 CPU-only reference
environment prerequisites (uv, Python, Docker, Node) and Playwright OS libraries:

```sh
python3 packages/quixi-embed/native/scheduler_ci.py
```

The command explicitly provisions frozen assets, both CPU routes and three
browser engines, then checks distribution identity, strict token fixtures,
deterministic scheduling, production CPU APIs and actual browser workers.
macOS arm64 uses the existing macOS lock and also requires Docker. Add `--gpu`
for actual Chromium/WebKit GPU FP32, half and in-flight loss scenarios; unavailable
hardware fails this gate. Add `--full` for all 159 frozen native/scalar/SIMD cases
(native compilation also requires clang). `--skip-provision` explicitly requires
already verified assets, environment and browser binaries.

Reports invalidate previous success at startup and record failures with their
command. [Recorded evidence](../../tests/reports/scheduler-2026-09-08/README.md)
separates deterministic resource tests, actual model/browser execution and the
remaining app/storage and wider GPU-family integration gates.
