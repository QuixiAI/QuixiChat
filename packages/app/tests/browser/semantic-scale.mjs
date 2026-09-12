/** Plan 22 scale proof: the production Storage Worker's semantic query path
 * at 100k+ chunks on OPFS in actual browsers (product §76/§112). Messages
 * are seeded through the worker in bounded batches, indexed by the
 * production lexical path, enrolled, and given deterministic synthetic unit
 * vectors through the real claim→publish protocol (the embedding worker is
 * not involved: the model would take hours on CPU and its vectors are
 * qualified elsewhere). Ten planted topic vectors make the expected top hit
 * of each semantic query known. Queries are measured below the coarse
 * threshold (exact float KNN), above it (resident sign-bit stage + rerank,
 * ADR 0036 amendment 2), and after a cold reopen (resident index rebuilt).
 *
 *   QUIXI_SEMANTIC_SCALE_THREADS=1010 QUIXI_SEMANTIC_SCALE_PER_THREAD=100 node packages/app/tests/browser/semantic-scale.mjs
 */
import { build, preview } from "vite";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, platform, release, arch, cpus } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { browserEngines } from "../../../../tooling/browser-engines.mjs";

const selectedEngines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, "../../../..");
const SIZES = { threads: Number(process.env.QUIXI_SEMANTIC_SCALE_THREADS ?? 1010), perThread: Number(process.env.QUIXI_SEMANTIC_SCALE_PER_THREAD ?? 100), planted: 10 };
const COARSE_THRESHOLD = 100_000, INTERACTIVE_BUDGET_MS = 5000;
const total = SIZES.threads * SIZES.perThread;
const results = resolve(import.meta.dirname, "results");
const report = {
  status: "running", startedAt: new Date().toISOString(), sizes: { ...SIZES, messages: total }, coarseThreshold: COARSE_THRESHOLD, budgets: { interactiveMs: INTERACTIVE_BUDGET_MS },
  selectedEngines: selectedEngines.map(([name]) => name), hosts: [], sourceSha256: {},
  environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  qualification: "Synthetic unit vectors (seeded per chunk digest; ten planted topic directions) published through the production claim→publish protocol; the real embedding worker is not used. Timings are single runs under development load on one machine.",
};
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-semantic-scale-"));
const output = resolve(results, "semantic-scale-browser.json");
const save = async () => { await mkdir(results, { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
let server;
try {
  for (const file of ["packages/storage/src/worker/search/semantic.ts", "packages/storage/src/worker/search/index.ts", "packages/core/src/contracts/search.ts", "packages/app/tests/browser/index.ts", "packages/app/tests/browser/semantic-scale.mjs"])
    report.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: "127.0.0.1", port: 4197, strictPort: true }, logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const evidence = { name, status: "running", checks: [], phases: {}, queries: {} };
    report.hosts.push(evidence); await save();
    // `embedding=missing`: the app's own indexer cannot start a runtime, so only the fixture publishes vectors.
    const url = `http://127.0.0.1:4197/?archive=test-semantic-scale-${randomUUID()}&embedding=missing`;
    const context = await engine.launchPersistentContext(resolve(temporary, name), { headless: true, viewport: { width: 1280, height: 900 } });
    const errors = [];
    try {
      let page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => { if (message.text().startsWith("[scale]")) console.log(`${name}: ${message.text()}`); });
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
      const seeded = await page.evaluate((sizes) => window.appAcceptance.semanticScale.seed(sizes), SIZES);
      evidence.phases.seed = { ms: Math.round(seeded.seedMs), batches: seeded.batches };
      console.log(`${name}: seeded ${total} messages in ${(seeded.seedMs / 1000).toFixed(1)} s`);
      const indexed = await page.evaluate(() => window.appAcceptance.semanticScale.index());
      evidence.phases.lexical = { ms: Math.round(indexed.indexMs), slices: indexed.slices, indexedChunks: indexed.indexedChunks };
      expect(indexed.indexedChunks).toBe(total);
      console.log(`${name}: lexical index of ${indexed.indexedChunks} chunks in ${(indexed.indexMs / 1000).toFixed(1)} s`);
      await page.evaluate(() => window.appAcceptance.semanticScale.enroll());
      // Every vector is published; below the coarse threshold the queries take
      // the exact float KNN, at or above it the resident sign-bit stage.
      const first = await page.evaluate((limit) => window.appAcceptance.semanticScale.publish({ limit }), total);
      evidence.phases.publish = { ms: Math.round(first.publishMs), published: first.published, rounds: first.rounds, projection: first.status.projection };
      expect(first.status.vectors).toBe(total);
      expect(first.status.projection.complete).toBe(true);
      console.log(`${name}: published ${first.published} vectors in ${(first.publishMs / 1000).toFixed(1)} s`);
      const filterThreads = seeded.threadIds.slice(0, 32);
      const measure = async (label) => {
        const set = { label, semantic: [], correct: 0, best: null, exact: null, filtered: null };
        for (const plant of seeded.planted) {
          const r = await page.evaluate(({ topic }) => window.appAcceptance.semanticScale.query({ mode: "semantic", query: "", queryVector: window.appAcceptance.semanticScale.topicVector(topic), filters: {}, maxItems: 20 }), plant);
          set.semantic.push(r.ms);
          if (r.top[0]?.messageId === plant.messageId) set.correct++;
        }
        set.best = await page.evaluate(({ topic, messageId }) => window.appAcceptance.semanticScale.query({ mode: "best", query: `Planted topic ${topic} signal`, queryVector: window.appAcceptance.semanticScale.topicVector(topic), filters: {}, maxItems: 20 }).then((r) => ({ ...r, expected: messageId })), seeded.planted[3]);
        set.exact = await page.evaluate(() => window.appAcceptance.semanticScale.query({ mode: "exact", query: "Planted topic 3 signal", filters: {}, maxItems: 20 }));
        set.filtered = await page.evaluate(({ topic, threads }) => window.appAcceptance.semanticScale.query({ mode: "semantic", query: "", queryVector: window.appAcceptance.semanticScale.topicVector(topic), filters: { threadIds: threads }, maxItems: 20 }), { topic: 5, threads: filterThreads });
        set.status = (await page.evaluate(() => window.appAcceptance.semanticStatus())).projection;
        const sorted = [...set.semantic].sort((a, b) => a - b);
        set.semanticMedianMs = sorted[Math.floor(sorted.length / 2)]; set.semanticMaxMs = sorted[sorted.length - 1];
        return set;
      };
      if (total < COARSE_THRESHOLD) {
        const exact = await measure(`${first.published} vectors, exact float KNN`);
        evidence.queries.belowThreshold = exact;
        expect(exact.correct).toBe(seeded.planted.length);
        expect(exact.status.coarseRetrieval).toBe(false);
        expect(exact.best.top[0]?.messageId).toBe(exact.best.expected);
        expect(exact.best.top[0]?.explanation).toBe("Exact + semantic match");
        expect(exact.filtered.top[0]?.messageId).toBe(seeded.planted[5].messageId);
        expect(exact.semanticMaxMs).toBeLessThan(INTERACTIVE_BUDGET_MS);
        evidence.checks.push(`${first.published} vectors below the coarse threshold: every planted topic is the top semantic hit (median ${exact.semanticMedianMs.toFixed(0)} ms, max ${exact.semanticMaxMs.toFixed(0)} ms), Best fuses the lexical and semantic hit, the thread filter keeps the planted hit`);
        console.log(`${name}: exact path semantic median ${exact.semanticMedianMs.toFixed(0)} ms, best ${exact.best.ms.toFixed(0)} ms, exact ${exact.exact.ms.toFixed(0)} ms, filtered ${exact.filtered.ms.toFixed(0)} ms`);
      } else {
        const coarse = await measure(`${total} vectors, resident sign-bit coarse stage + float rerank`);
        evidence.queries.aboveThreshold = coarse;
        expect(coarse.correct).toBe(seeded.planted.length);
        expect(coarse.status.coarseRetrieval).toBe(true);
        expect(coarse.status.residentBytes).toBe(total * 48);
        expect(coarse.best.top[0]?.messageId).toBe(coarse.best.expected);
        expect(coarse.best.top[0]?.explanation).toBe("Exact + semantic match");
        expect(coarse.filtered.top[0]?.messageId).toBe(seeded.planted[5].messageId);
        expect(coarse.semanticMaxMs).toBeLessThan(INTERACTIVE_BUDGET_MS);
        evidence.checks.push(`${total} vectors above the threshold: the coarse stage is active with ${(coarse.status.residentBytes / 1048576).toFixed(1)} MB resident, every planted topic is still the top hit (median ${coarse.semanticMedianMs.toFixed(0)} ms, max ${coarse.semanticMaxMs.toFixed(0)} ms), Best and the thread filter agree`);
        console.log(`${name}: coarse path semantic median ${coarse.semanticMedianMs.toFixed(0)} ms (first ${coarse.semantic[0].toFixed(0)} ms incl. resident load), best ${coarse.best.ms.toFixed(0)} ms, filtered ${coarse.filtered.ms.toFixed(0)} ms`);
        // Cold reopen: a fresh worker rebuilds the resident index on the first coarse query.
        await page.evaluate(() => window.appAcceptance.close());
        await page.close();
        page = await context.newPage();
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(url);
        await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
        const cold = await measure(`${total} vectors after a cold reopen`);
        evidence.queries.coldReopen = cold;
        expect(cold.correct).toBe(seeded.planted.length);
        expect(cold.status.residentBytes).toBe(total * 48);
        evidence.checks.push(`cold reopen: the first coarse query rebuilds the resident index (${cold.semantic[0].toFixed(0)} ms) and later queries take a median of ${cold.semanticMedianMs.toFixed(0)} ms`);
        console.log(`${name}: cold reopen first ${cold.semantic[0].toFixed(0)} ms, median ${cold.semanticMedianMs.toFixed(0)} ms`);
      }
      await page.evaluate(() => window.appAcceptance.close());
      if (errors.length) throw new Error(`${name}: page errors ${JSON.stringify(errors)}`);
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed"; evidence.error = String(error?.stack ?? error); evidence.pageErrors = errors;
      throw error;
    } finally {
      await save();
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
}
