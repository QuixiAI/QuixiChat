# Context summary design experiment

This is an executable design model for [ADR 0020](../../docs/decisions/0020-reviewed-summary-proposals.md),
not the product summary workflow. It is not imported by application/worker code,
does not mutate the product schema or archive protocol, and performs no model inference or
canonical storage writes. Its authored summaries are test data, never presented
as generated output.

Run from the repository root with the existing pinned dependencies and browsers:

```sh
node research/context-summary/run.mjs
```

This typechecks the experiment, runs its Node tests, builds its browser entry,
and executes the same contract cases in actual Chromium and Playwright WebKit.
It writes [results/report.json](results/report.json) with running/failed/passed
status, environment, exact source and bundle hashes, commands and individual
checks. Browser selection uses the repository's `QUIXI_TEST_BROWSERS` convention.
No new dependency or dataset is installed. For only the Node cases:

```sh
npm exec -- tsc --noEmit -p research/context-summary/tsconfig.json
node --experimental-transform-types --test research/context-summary/node.test.ts
```

## What the experiment establishes

The [contract model](contract-model.ts) tests contiguous prefix identity,
closed tool exchanges (including provider-only references), conservative refusal
of unsupported/ambiguous evidence, explicit attachment exclusions, hidden
provenance omission, UTF-8/count limits, immutable original data, complete-only
proposal eligibility, scope/text/provenance-bound review, repeated-summary source
binding and suffix traversal that stops before old source reads. The actual
production provider mappers verify the labelled summary stays user content,
retained messages remain present, the original prefix is absent, and summary
input uses quoted evidence with a dedicated instruction and no executable tools.

This does not establish a SQLite transaction, producer cancellation, archive
migration or an integrated user flow. Metadata/part arrays are synthetic and
already materialized; the prototype explicitly refuses blob-backed text and
unmapped attachments. Production requires the worker-owned bounded readers and
validators described in the ADR. Quoting instructions as data is a serialization
property, not proof that a language model will ignore malicious source text.

## Fidelity fixtures and future measurement

[quality-fixtures.json](quality-fixtures.json) contains ten original synthetic
histories, source-linked required claims, hand-authored reference summaries and
ten faulty controls. No external corpus content was copied. Categories cover
knowledge updates, negation, uncertainty, attribution, tool failure, exact values,
quoted hostile instructions, chronology, omitted attachments and partial output.
[quality.ts](quality.ts) checks that evidence quotes exist within the selected
prefix and that annotations/negative controls are consistent. A deliberately
corrupted quote and a quote moved to the retained tail must fail.

**Zero model runs have been performed.** Corpus validation is not a summary
quality score and does not automatically grade arbitrary text. An actual model
qualification must retain its exact request/output/provenance, manually grade
required fact retention and unsupported/contradicted claims, exercise the faulty
controls, and test repeated compression plus downstream questions. An authored
reference passing these structural checks cannot satisfy that gate.
