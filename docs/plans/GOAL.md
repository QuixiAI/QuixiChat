# Implementation goal prompt

Implement plans 01–14 and 16–24 in `docs/plans/`, and carry the
work through integration, validation, and release readiness. This is an execution
goal: make the repository changes and verify the resulting product.

For repeated autonomous iterations, run the bounded per-iteration procedure in
[GOAL_LOOP.md](./GOAL_LOOP.md); it defers to this file for requirements.

Read `docs/plans/README.md`, `docs/product.md`, `docs/architecture.md`, and the
applicable repository instructions. Treat `product.md` as the requirements
baseline and the numbered plans as the implementation roadmap. Inspect the
current implementation and existing validation evidence before deciding what
remains; continue completed work rather than rebuilding it. Preserve unrelated
changes and keep `legacy/prototype/` as independent reference material. You may
consult `~/embeddinggemma.c` and index relevant directories with zvec-grep.

## Scope and sequencing

- Complete the 23 plans numbered 01–14 and 16–24. Local OCR (15), Cloud design and
  Cloud implementation (25–26) are deferred by the user's 2026-09-08 instructions and
  excluded from this execution goal and its completion gates. Preserve those
  plans for future work and preserve the explicit product non-goals.
- PDF native-text extraction, scanned/low-text detection, document navigation,
  lexical search and semantic document search remain in scope. Do not download,
  build, or expose an OCR engine as part of this goal.
- Follow each plan's prerequisites and the roadmap's milestone gates. Plan
  numbers do not require serial execution of independent work.
- Start or resume the universal-storage proof and independent embedding-port
  work. Deliver usable chat/history/search/export and migration milestones while
  inference work proceeds, then finish the local product and semantic capabilities.
- Complete research, measurements, and required design reviews before dependent
  implementation.

## Execution

- Continue through successive implementation milestones without stopping after
  an individual plan or a progress report. Keep a durable handoff in the roadmap
  with completed work, current work, outstanding gates, and the next concrete
  steps so another session can resume from verified repository state.
- Resolve routine implementation choices autonomously. Record consequential
  decisions, alternatives, and evidence in `docs/decisions/`. Resolve conflicts
  with the product specification explicitly; do not silently reduce scope.
- Use sub-agents for concrete independent workstreams when useful. Establish
  shared contracts and clear file ownership, and review and integrate their work.
- Build working vertical slices, including UI, worker communication, storage,
  host integration, and error handling. Scaffolds, mocks, placeholder screens,
  and unimplemented interfaces do not satisfy feature acceptance criteria.
- Verify current external APIs and dependencies against official sources. Pin
  reproducible build inputs, model artifacts, and required licenses/checksums.
- Investigate failures, repair their causes, and rerun affected checks. Continue
  independent work when credentials, hardware, or external services block a gate;
  record exactly what remains unverified and what would unblock it.

## Architectural requirements

- Use the same Storage Worker → SQLite WASM → OPFS backend on every supported
  host. Only the Storage Worker owns SQLite. Respect package and host boundaries.
- Preserve canonical history, branches, provenance, raw source, and attachment
  integrity. Commit canonical mutations and their sync operations atomically.
- Keep chat, imports, documents, FTS, and export usable with semantic indexing
  disabled, incomplete, rebuilding, or failing. Search indexes remain derived
  and rebuildable.
- Share SearchChunks across conversations and documents. Bound memory, queues,
  transfers, extraction, imports, and inference; support cancellation and recovery
  wherever required by the plans.
- Own the fixed embedding graph, tokenizer, WASM SIMD execution, and WGSL kernels.
  Preserve a scalar correctness oracle. Select optimizations and compressed
  retrieval using numerical, relevance, and performance evidence.
- Preserve complete local archive usability without a Quixi account or Cloud.
  Keep the future Cloud boundary explicitly opt-in; do not implement the deferred
  Cloud service, encryption/recovery design, or device lifecycle in this goal.

## Validation and completion

- Track progress in the numbered plan files and roadmap. Mark tasks and acceptance
  criteria complete only when backed by implementation and validation evidence.
  Maintain traceability from product sections to code, tests, and reports.
- Run relevant unit, integration, and end-to-end checks. Exercise actual storage
  persistence, reloads, concurrent ownership, interrupted writes, migrations,
  quota failures, archive restore, and optional-feature failures.
- Run the required storage, document, inference, and retrieval workloads. Record
  environment, dataset size, commands, measured results, and limitations. Use
  synthetic or redistributable fixtures rather than private user history.
- Validate supported hosts using their actual runtime behavior. A successful
  frontend build or a different browser engine does not establish host support.
- Verify clean-checkout builds, CI, packaging, Docker, upgrades, recovery, and
  release configuration. Prepare reviewable release artifacts and operational
  documentation. Obtain authorization before public deployment, publication,
  spending money, or transmitting private data.
- Do not declare the goal complete until plans 01–14 and 16–24 and their required gates
  are satisfied. An unavailable prerequisite remains an explicit outstanding
  requirement, not a passing check. Finish with a concise account of delivered
  capabilities, validation evidence, artifact locations, and any remaining work.
