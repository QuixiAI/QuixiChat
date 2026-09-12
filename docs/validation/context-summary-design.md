# Reviewed summary design evidence

2026-09-10. [ADR 0020](../decisions/0020-reviewed-summary-proposals.md) completes
the source/proposal/review design prerequisite for plan 10's summary choice.
The subsequent [production implementation](context-summaries.md) has separate
controlled integration evidence; model quality remains unqualified. This design
report does not close the compaction acceptance criterion.

## Verified experiment

Run `node research/context-summary/run.mjs`. The
[retained report](../../research/context-summary/results/report.json) records
typecheck, Node test output, exact source/build hashes, OS/Node/browser identity
and individual browser results. The [experiment README](../../research/context-summary/README.md)
describes its deliberately limited scope.

The final experiment has **24 passing Node tests and 24 passing checks each in
actual Chromium and Playwright WebKit**. It includes actual production request
mapping for both provider protocols but no HTTP provider call, model inference,
SQLite mutation or application summary UI.

The checks establish:

- Contiguous source identity, a retained user turn, stable sealed messages and
  part identities; missing/foreign/divergent scope refuses.
- Closed resolved and provider-only tool exchanges, including refusal of split,
  ambiguous, orphan and unfinished cases.
- Attachment exclusions before evidence serialization, explicit refusal when
  verified text/image/file readers are required, omission of redacted reasoning
  and recognized internal transport artifacts, preservation of visible reasoning
  summaries, and refusal of unknown provider artifacts.
- Independent message/part/UTF-8 limits, no text clipping, immutable originals,
  complete-only proposal eligibility and exact edited-text retention.
- Review binding to archive/selection revision, thread/revision/context/leaf,
  proposal/generation/source identity and exact text. Stale or changed review
  cannot produce an applicable payload in the design model.
- Repeated-summary evidence contains the earlier reviewed text plus newly covered
  messages; it does not reconstruct old source from a lossy summary.
- A request walk stops before reading cutoff parts or older messages. Divergent,
  missing, cyclic and oversized tails refuse without falling back to full history.
- Both real provider mappers transmit the same labelled user summary and retained
  tail, retain the system prompt, omit the original prefix and preserve attachment
  exclusions on the retained tail without changing its original records. Summary generation
  input is quoted historical evidence with a distinct instruction and no tools.

These are deterministic design-contract results. They do not prove producer
cancellation, worker validation/transactions, actual HTTP bytes, cross-tab behavior,
archive upgrade/restore or any model's factual reliability. Those are covered separately by the
production acceptance report where verified. In particular, serializing a hostile instruction as
quoted data does not prove a model will resist following it.

## Fidelity corpus

The [corpus](../../research/context-summary/quality-fixtures.json) contains **10
original synthetic cases, 19 evidence-linked required claims and 10 hand-authored
faulty controls**. It addresses corrections, negation, uncertainty, speaker
attribution, tool failures, exact strings/Unicode, quoted instructions, chronology,
excluded attachments and partial assistant responses.

Corpus checks verify quote locations inside the selected prefix, identifiers and
control annotations. Corrupted quotes and references moved into the retained tail
are rejected. The acceptable and faulty summaries are authored fixtures. **Zero
model runs were performed; no model quality score or release pass is claimed.**
Actual qualification must capture requests/outputs and grade critical fact
retention, unsupported/contradicted claims, attribution, repeated compaction and
subsequent questions independently of compression size. The ADR cites the dated
primary research that informed these evaluation dimensions.

## Repository checks and handoff

`npm run check` passed before and after this design work: SQLite verification,
TypeScript and both host frontend builds. The
[build report](results/context-summary-design-check-macos.json) retains the output.
The existing large-bundle warning remains. At that design-only checkpoint,
product schema 11/protocol 3 and attachment-exclusion behavior were unchanged;
that build report is a historical snapshot. The design experiment has been rerun
against the production summary contracts with refreshed source/build hashes.

The subsequent [production increment](context-summaries.md) implements unselected
request snapshots, frozen bodies, typed proposal provenance, generation isolation,
worker scope validation, bounded readers, shared prefix-aware requests and
recovery. Its controlled HTTP/browser/archive proofs are separate from the design
model. Actual model fidelity and explicit compaction branching remain open; no
numbered plan is marked complete here.
