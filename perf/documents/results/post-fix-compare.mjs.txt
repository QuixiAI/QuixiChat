import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const name = process.argv[2] ?? "post-fix";
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
  throw new Error("Expected a report filename stem");
const root = resolve(import.meta.dirname, "results");
const bytes = await readFile(resolve(root, `${name}.json`));
const report = JSON.parse(bytes);
const baseline = JSON.parse(
  await readFile(resolve(root, "baseline-summary.json"), "utf8"),
);
const rows = [];
for (const host of report.hosts)
  for (const item of host.cases) {
    if (!item.extraction) continue;
    const measured = item.extraction,
      previous = baseline.cases.find(
        (row) => row.engine === host.name && row.fixture === item.fixture,
      );
    const requests = Object.values(measured.requestTimings).reduce(
      (sum, value) => sum + value.totalMs,
      0,
    );
    const index =
      measured.requestTimings.advanceExtractionPageIndex?.totalMs ?? 0;
    rows.push({
      engine: host.name,
      fixture: item.fixture,
      status: item.status,
      baselineStatus: previous?.status ?? null,
      sourceBytes: item.source.sourceBytes,
      sourceSha256: item.source.sourceSha256,
      totalExtractionMs: measured.totalExtractionMs,
      baselineTotalExtractionMs: previous?.totalExtractionMs ?? null,
      totalRatio:
        previous?.status === "passed"
          ? measured.totalExtractionMs / previous.totalExtractionMs
          : null,
      firstIndexedPageMs: measured.firstIndexedPageMs,
      baselineFirstIndexedPageMs: previous?.firstIndexedPageMs ?? null,
      indexCreditRequestMs: index,
      baselineIndexCreditRequestMs: previous?.indexCreditRequestMs ?? null,
      indexCreditRatio: previous?.indexCreditRequestMs
        ? index / previous.indexCreditRequestMs
        : null,
      publicationRequestMs:
        measured.requestTimings.publishExtractionPage?.totalMs ?? 0,
      foregroundP95Ms: measured.foregroundAroundPublication.p95Ms,
      baselineForegroundP95Ms:
        previous?.foregroundAroundPublicationP95Ms ?? null,
      foregroundBaselineP95Ms: measured.foregroundBaseline.p95Ms,
      cancellationDrainMs: measured.cancellationDrainMs,
      baselineCancellationDrainMs: previous?.cancellationDrainMs ?? null,
      postExtractionObservation: measured.postExtractionObservation ?? null,
      totalTimedPublicRequestMs: requests,
      workflowOutsideTimedPublicRequestsMs:
        measured.totalExtractionMs - requests,
      observedDescendantPeakRssKiB: item.memory.peakRssKiB,
      memoryBoundary: previous?.memoryAttribution ?? null,
      failure: measured.failure,
      storedPages: measured.storedPages,
      pageCount: measured.pageCount,
    });
  }
const summary = {
  createdAt: new Date().toISOString(),
  report: `${name}.json`,
  comparisonToolSha256: createHash("sha256")
    .update(await readFile(import.meta.filename))
    .digest("hex"),
  reportSha256: createHash("sha256").update(bytes).digest("hex"),
  sourceStable: report.sourceStable,
  status: report.status,
  parserSha256:
    report.sourceSha256["node_modules/pdfjs-dist/build/pdf.worker.mjs"],
  rangePatchToolSha256:
    report.sourceSha256["packages/documents/tooling/pdfjs-range-patch.mjs"],
  rows,
  limits: [
    "Baseline is a split single-run capture, Chromium used nonpersistent contexts; post-fix uses fresh persistent profiles and new origins per case. No statistically controlled cross-engine or before/after speedup guarantee.",
    "Image baseline was rejected; its failure-path time is not a successful extraction baseline and totalRatio is null.",
    "Workflow time outside timed requests includes parser, chunk reads/ACKs, scheduling, and cleanup; it is not an isolated idle-maintenance CPU measurement.",
    "Post-extraction read latency and searchStatus timing observe residual queue/status cost; explicit probes themselves can affect scheduling.",
    "Descendant RSS excludes WebKit XPC content processes; no parser heap or hard memory bound follows.",
  ],
};
await writeFile(
  resolve(root, `${name}-comparison.json`),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    rows.map(
      ({
        engine,
        fixture,
        status,
        totalExtractionMs,
        indexCreditRequestMs,
        foregroundP95Ms,
      }) => ({
        engine,
        fixture,
        status,
        totalExtractionMs,
        indexCreditRequestMs,
        foregroundP95Ms,
      }),
    ),
    null,
    2,
  ),
);
