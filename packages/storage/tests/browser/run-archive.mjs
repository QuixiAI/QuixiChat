import { browserEngines } from "../../../../tooling/browser-engines.mjs";
const selectedEngines = browserEngines({ chromium, webkit });
import { build, preview } from "vite";
import { chromium, webkit } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const workspace = resolve(import.meta.dirname, "../../../..");
const output = resolve(workspace, "test-results/archive-client-browser.json");
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-archive-acceptance-"));
const report = { selectedEngines: selectedEngines.map(([name]) => name), status: "running", startedAt: new Date().toISOString(), hosts: [] };
await mkdir(resolve(workspace, "test-results"), { recursive: true });
const save = async () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
await save();
const run = (page, operation, value) => page.evaluate(({ operation, value }) => window.archiveTest(operation, value), { operation, value });
const visit = async context => { const page = await context.newPage(); await page.goto("http://127.0.0.1:4188/archive.html"); await page.waitForFunction(() => typeof window.archiveTest === "function"); return page; };
let server;
try {
  report.sourceSha256 = {};
  for (const file of ["tooling/browser-engines.mjs", "packages/storage/src/client/archive.ts", "packages/storage/src/client/producer.ts", "packages/storage/src/producer-protocol.ts", "packages/storage/src/worker/producers.ts", "packages/storage/migrations/producers.ts", "packages/core/src/contracts/producers.ts", "packages/core/src/contracts/search.ts", "packages/storage/src/worker/search/index.ts", "packages/storage/src/worker/search/schema.ts", "packages/storage/src/worker/search/sources.ts", "packages/search/src/chunker.ts", "packages/search/src/query.ts", "packages/storage/tests/browser/archive-lifecycle.ts", "packages/storage/tests/browser/archive-search-verification.ts", "packages/storage/tests/browser/search-damage.ts", "packages/storage/src/archive-protocol.ts", "packages/storage/src/worker/archive.ts", "packages/storage/src/worker/archive-database.ts", "packages/storage/src/worker/blobs.ts", "packages/storage/src/worker/blob-catalog.ts", "packages/storage/src/worker/canonical/repository.ts", "packages/storage/src/worker/canonical/imports.ts", "packages/storage/migrations/index.ts", "packages/core/src/contracts/transfer.ts", "packages/core/src/contracts/imports.ts", "packages/storage/tests/browser/archive.ts", "packages/storage/tests/browser/archive-import.ts", "packages/storage/tests/browser/run-archive.mjs", "package-lock.json"]) report.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(workspace, file))).digest("hex");
  const buildOptions = { outDir: resolve(temporary, "dist"), emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, "archive.html") } };
  await build({ configFile: false, root: import.meta.dirname, build: buildOptions, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: buildOptions, preview: { host: "127.0.0.1", port: 4188, strictPort: true }, logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const profile = resolve(temporary, name), archiveId = `test-acceptance-${crypto.randomUUID()}`;
    const host = { name, status: "running", checks: [] }; report.hosts.push(host); await save();
    let fixture, importFixture, restartProducer, uncoordinated;
    const importArchiveId = `${archiveId}-imports`;
    const producerArchiveId = `${archiveId}-producers`;
    let context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const first = await visit(context);
      host.userAgent = await first.evaluate(() => navigator.userAgent);
      host.owner = await run(first, "open", archiveId);
      const second = await visit(context);
      const follower = await run(second, "open", archiveId);
      assert.equal(host.owner.ownerId, follower.ownerId, "Tabs opened independent owners");
      host.checks.push("two tabs share one SQLite/OPFS owner");
      host.requestAdmission = await run(second, "request_admission");
      host.checks.push("64 control requests are admitted; the next is rejected before dispatch and admission recovers");
      fixture = await run(second, "write");
      host.ranges = await run(second, "ranges", fixture);
      host.checks.push("verified range transfers preserve exact selected bytes, cap active leases, survive parent discard and acknowledge empty EOF ranges");
      host.checks.push("follower publishes verified 5 MiB blob with canonical metadata and three atomic sync operations", "four upload/read credits include pending replies and permit retry after local overload", "out-of-order acknowledgements and final-chunk handling preserve exact SHA-256", "invalid canonical transaction rolls back metadata and sync operations", "transaction replay after staging cleanup does not duplicate operations");
      host.checks.push("suppressed real commit reply produces UNKNOWN_OUTCOME and operation-status reconciliation finds the durable commit");
      host.checks.push("a blob-control operation cannot reuse a canonical operation identity; SQLite constraint failure returns typed CONFLICT and preserves the original operation");
      host.checks.push("bounded sync pages retain an ordered high-water snapshot without skipped or repeated operations");
      host.lostChunkReply = await run(second, "lost_chunk_reply");
      host.checks.push("suppressed real upload acknowledgement invalidates the transfer; explicit discard and fresh transfer recover");
      await first.waitForFunction(async ids => {
        const events = await window.archiveTest("events");
        return ids.every(id => events.changes.includes(id));
      }, fixture.batch.mutations.map(item => item.operationId));
      const events = await run(first, "events");
      for (const mutation of fixture.batch.mutations) assert(events.changes.includes(mutation.operationId), "Owner subscriber missed follower commit");
      const followerEvents = await run(second, "events");
      for (const mutation of fixture.batch.mutations) assert(followerEvents.progress.some(item => item.operationId === mutation.operationId && item.status === "complete"), "Follower did not receive completion progress");
      host.checks.push("change notifications reach owner and completion progress returns to follower");
      const interrupted = await run(second, "leave_upload");
      await first.close(); // Actual owner worker termination without graceful StorageClient.close().
      let takeover;
      for (let attempt = 0; attempt < 10; attempt++) {
        try { takeover = await run(second, "diagnostics"); if (takeover.ownerId !== host.owner.ownerId) break; }
        catch (error) { if (!String(error).includes("owner changed") && !String(error).includes("deadline")) throw error; }
        await second.waitForTimeout(100);
      }
      assert(takeover && takeover.ownerId !== host.owner.ownerId, "Follower did not acquire ownership after tab termination");
      host.afterTakeover = await run(second, "verify", fixture);
      host.checks.push("abrupt owner-tab termination transfers ownership and preserves canonical and blob data");
      host.interruptedUpload = await run(second, "verify_interrupted", interrupted);
      host.checks.push("upload interrupted by actual owner termination cannot resume under its previous operation identity and can be discarded");
      host.cancellation = await run(second, "cancel_before_dispatch", `test-cancel-${crypto.randomUUID()}`);
      host.checks.push("cancellation before owner acquisition is reported as not_dispatched");
      await run(second, "close");
      const importer = await visit(context);
      await run(importer, "open", importArchiveId);
      importFixture = await run(importer, "prepare_import");
      await importer.close();
      const importOwner = await visit(context);
      await run(importOwner, "open", importArchiveId);
      host.importPublication = await run(importOwner, "finish_import_after_restart", importFixture);
      host.checks.push("1001-part normalized import stays hidden during staging, requires fresh validation after owner restart, and atomically publishes records plus sync marker");
      host.importCancellation = await run(importOwner, "cancel_import");
      await importOwner.waitForFunction(async archiveId => (await window.archiveTest("stage_files", archiveId)).length === 0, importArchiveId);
      host.checks.push("cancelled import publishes no records or sync operations; idle maintenance removes published and cancelled temporary blob files");
      const shared = await run(importOwner, "share_import_transfer");
      // A subsequent completed foreground request also drains a maintenance slice.
      await run(importOwner, "diagnostics");
      assert((await run(importOwner, "stage_files", importArchiveId)).includes(`${shared.transferId}.stage`), "Cancelled import removed a transfer still used by an active import");
      await run(importOwner, "cancel_import_id", shared.remainingImportId);
      await importOwner.waitForFunction(async archiveId => (await window.archiveTest("stage_files", archiveId)).length === 0, importArchiveId);
      host.checks.push("cleanup retains a shared transfer while another import is active and releases it after both are cancelled");
      await run(importOwner, "close");
      const producerOwner = await visit(context);
      const originalProducerOwner = await run(producerOwner, "open", producerArchiveId);
      const producer = await visit(context);
      await run(producer, "open", producerArchiveId);
      const living = await run(producer, "prepare_producer", {});
      const orphan = await run(producer, "prepare_producer", { create: false });
      const observer = await visit(context);
      await run(observer, "open", producerArchiveId);
      await run(observer, "verify_producer", { fixture: living, expected: "streaming" });
      await producerOwner.close();
      await producer.waitForFunction(async prior => {
        try { return (await window.archiveTest("diagnostics")).ownerId !== prior; }
        catch (error) { if (error.code === 'UNKNOWN_OUTCOME') return false; throw error; }
      }, originalProducerOwner.ownerId);
      host.liveProducer = await run(producer, "verify_producer", { fixture: living, expected: "streaming" });
      host.checks.push("independent producer lease survives abrupt storage-owner tab termination without sealing live output");
      await producer.close();
      await observer.waitForFunction(async fixture => {
        try { await window.archiveTest("verify_producer", { fixture, expected: "partial" }); return true; } catch { return false; }
      }, living);
      host.lostProducer = await run(observer, "verify_producer", { fixture: living, expected: "partial" });
      host.orphanProducer = await run(observer, "verify_producer", { fixture: orphan, expected: "absent" });
      host.checks.push("actual producer-tab termination preserves committed prefix, seals partial output, records exactly one event and rejects delayed writes while committed retries remain idempotent", "producer registration before creation fences delayed creation after context loss");
      await observer.waitForFunction(async () => {
        const status = await window.archiveTest('search_progress');
        return status?.state === 'ready' && status.indexedChunks > 0;
      });
      host.checks.push("idle owner maintenance indexes committed text automatically and publishes search status without foreground polling work");
      host.search = await run(observer, "verify_search", living);
      host.checks.push("production FTS returns safe source-located excerpts without embedding weights and keeps old exact results available through an epoch rebuild");
      host.incrementalSearch = await run(observer, "verify_incremental_search");
      host.checks.push("a multi-megabyte text blob verifies in bounded owner turns while queued foreground reads complete; no tail result appears before verification and indexing preserves canonical/sync inventories");
      host.damagedSearch = await run(observer, 'damage_search');
      await run(observer, 'open', producerArchiveId);
      host.repairedSearch = await run(observer, 'repair_search', living);
      host.checks.push('removing a derived table in an offline worker leaves canonical writes usable after reopen; explicit search repair rebuilds results without changing canonical records or sync operations');
      restartProducer = await run(observer, "prepare_producer", {});
      uncoordinated = await run(observer, "prepare_producer", { registered: false });
    } finally { await context.close(); }
    context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const restarted = await visit(context);
      await run(restarted, "open", archiveId);
      host.afterProcessRestart = await run(restarted, "verify", fixture);
      host.checks.push("canonical metadata, blob SHA-256 and transaction replay survive actual browser-process restart");
      await run(restarted, "close");
      const imports = await visit(context);
      await run(imports, "open", importArchiveId);
      host.importAfterProcessRestart = await run(imports, "verify_import", importFixture);
      host.checks.push("published many-part import and verified long-text blob survive browser-process restart");
      await run(imports, "close");
      const producers = await visit(context);
      await run(producers, "open", producerArchiveId);
      host.incrementalSearchAfterRestart = await run(producers, "verify_incremental_search_result", host.incrementalSearch);
      host.producerAfterProcessRestart = await run(producers, "verify_producer", { fixture: restartProducer, expected: "partial" });
      host.uncoordinatedAfterProcessRestart = await run(producers, "verify_producer", { fixture: uncoordinated, expected: "streaming" });
      host.checks.push("actual browser-process restart recovers registered lost producers while leaving uncoordinated history untouched");
      await run(producers, "close");
    } finally { await context.close(); }
    host.status = "passed"; await save(); console.log(`${name}: production archive client acceptance passed`);
  }
  report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
