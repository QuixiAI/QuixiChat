/** Plan 24 storage stress: 100k conversations and 1M+ messages seeded through
 * the production Storage Worker, then measured: seed throughput, integrity
 * check, library paging, cold reopen (startup), a follower tab reading while
 * the owner is open, a portable export streamed to disk in bounded steps,
 * and an isolated restore validation streamed back from disk. Nothing is
 * materialized archive-wide on either side; the runner holds one block at a
 * time. Attachments, quota exhaustion and interrupted writes are not part of
 * this run (see docs/validation/storage-stress.md).
 *
 *   QUIXI_TEST_BROWSERS=webkit QUIXI_STRESS_THREADS=100000 QUIXI_STRESS_PER_THREAD=10 node packages/app/tests/browser/stress.mjs
 */
import { build, preview } from "vite";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile, open as openFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, platform, release, arch, cpus } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { browserEngines, browserNames } from "../../../../tooling/browser-engines.mjs";

const selectedEngines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, "../../../..");
const SIZES = { threads: Number(process.env.QUIXI_STRESS_THREADS ?? 100_000), perThread: Number(process.env.QUIXI_STRESS_PER_THREAD ?? 10), planted: 0 };
const SLICE = Number(process.env.QUIXI_STRESS_SLICE ?? 5000);
const total = SIZES.threads * SIZES.perThread;
const results = resolve(import.meta.dirname, "results");
const suffix = process.env.QUIXI_STRESS_OUTPUT ?? browserNames().join("-");
const output = resolve(results, `stress-browser-${suffix}.json`);
const report = {
  status: "running", startedAt: new Date().toISOString(), sizes: { ...SIZES, messages: total, seedSlice: SLICE },
  stepBounds: { maxRecords: 128, maxBytes: 1_048_576 }, selectedEngines: selectedEngines.map(([name]) => name), hosts: [], sourceSha256: {},
  environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  qualification: "Synthetic short messages seeded through the production worker; no embedding model, no provider, no Cloud account; timings are single runs under development load on one machine.",
};
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-stress-"));
const save = async () => { await mkdir(results, { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
const log = (name, text) => console.log(`${new Date().toISOString()} ${name}: ${text}`);
let server;
try {
  for (const file of ["packages/storage/src/worker/archives/export.ts", "packages/storage/src/worker/archives/index.ts", "packages/storage/src/worker/archive-database.ts", "packages/app/tests/browser/index.ts", "packages/app/tests/browser/stress.mjs"])
    report.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: "127.0.0.1", port: 4206, strictPort: true }, logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const evidence = { name, status: "running", checks: [], phases: {} };
    report.hosts.push(evidence); await save();
    const url = `http://127.0.0.1:4206/?archive=test-stress-${randomUUID()}&embedding=missing`;
    const context = await engine.launchPersistentContext(resolve(temporary, name), { headless: true, viewport: { width: 1280, height: 900 } });
    const errors = [];
    const container = resolve(temporary, `${name}.portable`);
    try {
      let page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
      // Seed in slices so the page never holds more than one slice of mutations.
      const seedStarted = Date.now(); let batches = 0, seededThreads = 0;
      for (let done = 0; done < SIZES.threads; done += SLICE) {
        const slice = Math.min(SLICE, SIZES.threads - done);
        const seeded = await page.evaluate((sizes) => window.appAcceptance.semanticScale.seed(sizes), { threads: slice, perThread: SIZES.perThread, planted: 0 });
        batches += seeded.batches; seededThreads += slice;
        if (seededThreads % (SLICE * 4) === 0 || seededThreads === SIZES.threads) log(name, `seeded ${seededThreads}/${SIZES.threads} conversations (${(seededThreads * SIZES.perThread).toLocaleString()} messages) in ${((Date.now() - seedStarted) / 1000).toFixed(0)} s`);
      }
      evidence.phases.seed = { ms: Date.now() - seedStarted, batches, messagesPerSecond: Math.round(total / ((Date.now() - seedStarted) / 1000)) };
      const diagnostics = await page.evaluate(() => window.appAcceptance.stress.timedDiagnostics());
      evidence.phases.integrity = { ms: Math.round(diagnostics.ms), integrity: diagnostics.integrity, canonicalRecords: diagnostics.canonicalRecords, syncOperations: diagnostics.syncOperations, usage: diagnostics.usage, quota: diagnostics.quota };
      expect(diagnostics.integrity).toBe("ok");
      log(name, `integrity ${diagnostics.integrity} in ${(diagnostics.ms / 1000).toFixed(1)} s; ${diagnostics.canonicalRecords.toLocaleString()} records; ${diagnostics.usage === null ? "usage unreported" : `${(diagnostics.usage / 1048576).toFixed(0)} MB used`}`);
      evidence.checks.push(`${SIZES.threads.toLocaleString()} conversations and ${total.toLocaleString()} messages seeded through the production worker in ${batches.toLocaleString()} bounded commits (${evidence.phases.seed.messagesPerSecond} messages/s); integrity_check answers ok in ${(diagnostics.ms / 1000).toFixed(1)} s over ${diagnostics.canonicalRecords.toLocaleString()} canonical records`);
      const paging = await page.evaluate(() => window.appAcceptance.stress.libraryPages(20));
      evidence.phases.libraryPaging = paging;
      expect(paging.firstMs).toBeLessThan(5000);
      evidence.checks.push(`the library's first page answers in ${paging.firstMs.toFixed(0)} ms and twenty consecutive pages in ${paging.totalMs.toFixed(0)} ms (max ${paging.maxMs.toFixed(0)} ms) without listing the whole archive`);
      // Cold reopen: a fresh page and worker over the persisted archive.
      await page.evaluate(() => window.appAcceptance.close());
      await page.close();
      const reopenStarted = Date.now();
      page = await context.newPage(); page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible({ timeout: 120_000 });
      const reopenReadyMs = Date.now() - reopenStarted;
      const reopenPaging = await page.evaluate(() => window.appAcceptance.stress.libraryPages(1));
      evidence.phases.coldReopen = { readyMs: reopenReadyMs, firstPageMs: reopenPaging.firstMs };
      evidence.checks.push(`a cold reopen of the persisted ${total.toLocaleString()}-message archive shows the landing in ${(reopenReadyMs / 1000).toFixed(1)} s and answers the first library page in ${reopenPaging.firstMs.toFixed(0)} ms`);
      log(name, `cold reopen ready in ${(reopenReadyMs / 1000).toFixed(1)} s`);
      // Follower tab: a second page shares the owner through the production coordination.
      const follower = await context.newPage(); follower.on("pageerror", (error) => errors.push(String(error)));
      await follower.goto(url);
      await expect(follower.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible({ timeout: 120_000 });
      const followerPaging = await follower.evaluate(() => window.appAcceptance.stress.libraryPages(3));
      evidence.phases.followerTab = { firstMs: followerPaging.firstMs, totalMs: followerPaging.totalMs };
      await follower.evaluate(() => window.appAcceptance.close()); await follower.close();
      evidence.checks.push(`a second tab opens the same archive and reads three library pages through the owner in ${followerPaging.totalMs.toFixed(0)} ms`);
      // Portable export produced in bounded steps, streamed to the runner's disk block by block.
      const exported = await page.evaluate(() => window.appAcceptance.stress.beginExport("portable"));
      log(name, `portable export produced: ${(exported.byteLength / 1048576).toFixed(0)} MB in ${(exported.producedMs / 1000).toFixed(0)} s (${exported.advances} steps)`);
      const readStarted = Date.now(); const hash = createHash("sha256"); const file = await openFile(container, "w");
      let received = 0, chunks = 0;
      try {
        for (;;) {
          const block = await page.evaluate(() => window.appAcceptance.stress.readExportChunks(64));
          const bytes = Buffer.from(block.base64, "base64"); hash.update(bytes); await file.write(bytes); received += bytes.length; chunks += block.chunks;
          if (block.final) break;
          if (received > exported.byteLength) throw new Error("Export read past its length");
        }
      } finally { await file.close(); }
      const sha256 = hash.digest("hex");
      expect(received).toBe(exported.byteLength); expect(sha256).toBe(exported.sha256);
      await page.evaluate(() => window.appAcceptance.stress.releaseExport());
      evidence.phases.portableExport = { byteLength: exported.byteLength, sha256, producedMs: Math.round(exported.producedMs), advances: exported.advances, phases: exported.phases, readMs: Date.now() - readStarted, chunks, entryCount: exported.entryCount };
      evidence.checks.push(`the portable export of ${total.toLocaleString()} messages is ${(exported.byteLength / 1048576).toFixed(0)} MB, produced in ${exported.advances.toLocaleString()} bounded steps (${(exported.producedMs / 1000).toFixed(0)} s) and streamed out in ${chunks.toLocaleString()} chunks (${((Date.now() - readStarted) / 1000).toFixed(0)} s) with its digest verified on disk`);
      // Isolated restore validation streamed back from disk.
      const restoreStarted = Date.now();
      const begun = await page.evaluate(([length, digest]) => window.appAcceptance.stress.beginRestore(length, digest), [received, sha256]);
      const reader = await openFile(container, "r"); const block = Buffer.alloc(4 * 1024 * 1024); let offset = 0;
      try {
        for (;;) {
          const { bytesRead } = await reader.read(block, 0, block.length, offset);
          if (!bytesRead) break;
          await page.evaluate((text) => window.appAcceptance.stress.sendRestoreBytes(text), block.subarray(0, bytesRead).toString("base64"));
          offset += bytesRead;
        }
      } finally { await reader.close(); }
      const sentMs = Date.now() - restoreStarted;
      const restored = await page.evaluate(() => window.appAcceptance.stress.finishRestore());
      evidence.phases.restore = { state: restored.state, failure: restored.failure, candidate: restored.candidate, advances: restored.advances, phases: restored.phases, sentMs, validatedMs: Math.round(restored.validatedMs), maxChunkBytes: begun.maxChunkBytes };
      expect(restored.state).toBe("ready");
      expect(restored.candidate.canonicalRecords).toBe(diagnostics.canonicalRecords);
      log(name, `restore validated in ${(restored.validatedMs / 1000).toFixed(0)} s (${restored.advances} steps); candidate ${restored.candidate.canonicalRecords.toLocaleString()} records`);
      evidence.checks.push(`the container restores into an isolated candidate with ${restored.candidate.canonicalRecords.toLocaleString()} canonical records (equal to the source) after ${restored.advances.toLocaleString()} bounded validation steps (${(restored.validatedMs / 1000).toFixed(0)} s), streamed in from disk in ${(sentMs / 1000).toFixed(0)} s; the candidate is released, never activated`);
      await page.evaluate(() => window.appAcceptance.close());
      if (errors.length) throw new Error(`${name}: page errors ${JSON.stringify(errors)}`);
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed"; evidence.error = String(error?.stack ?? error); evidence.pageErrors = errors;
      throw error;
    } finally {
      await save();
      await rm(container, { force: true }).catch(() => {});
      await context.close().catch(() => {});
    }
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error?.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  if (server) await new Promise((done) => server.httpServer.close(done));
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, hosts: report.hosts.map((host) => ({ name: host.name, status: host.status, checks: host.checks.length })) }));
}
