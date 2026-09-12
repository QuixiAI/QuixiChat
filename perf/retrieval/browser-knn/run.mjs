/** ADR 0036 browser-scale measurement: sqlite-vec float and int8 KNN in the
 * pinned SQLite WASM on OPFS in Chromium and WebKit, at the requested sizes.
 *
 *   node perf/retrieval/browser-knn/run.mjs                 # 100000 in both engines
 *   QUIXI_KNN_SIZES=100000,500000 QUIXI_TEST_BROWSERS=chromium node perf/retrieval/browser-knn/run.mjs
 *
 * Writes perf/retrieval/browser-knn-<size>.json per size (both engines in one
 * file). Vectors are pseudo-random with Arctic-like magnitudes (the quality
 * decision is compressed.mjs's job); this measures engine, OPFS and memory.
 */
import { chromium, webkit } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir, platform, release, arch, cpus, totalmem } from "node:os";
import { resolve, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { browserEngines } from "../../../tooling/browser-engines.mjs";
const here = import.meta.dirname, root = resolve(here, "../../..");
const sizes = (process.env.QUIXI_KNN_SIZES ?? "100000").split(",").map(Number);
/** vec0 chunk_size of the float table (rows per stored blob); unset = sqlite-vec default (1024). */
const floatChunkSize = process.env.QUIXI_KNN_FLOAT_CHUNK ? Number(process.env.QUIXI_KNN_FLOAT_CHUNK) : undefined;
const suffix = floatChunkSize ? `-chunk${floatChunkSize}` : "";
if (sizes.some((size) => !Number.isInteger(size) || size <= 0)) throw new Error("QUIXI_KNN_SIZES must be positive integers");
const batch = 5000, queries = 12, repetitions = 3, backfillBatches = 5, backfillBatch = 1000;
const manifest = JSON.parse(await readFile(resolve(root, "packages/storage/sqlite/artifacts.json"), "utf8"));
const wasm = await readFile(resolve(root, "packages/storage/sqlite/dist/sqlite3.wasm"));
if (createHash("sha256").update(wasm).digest("hex") !== manifest.artifacts["sqlite3.wasm"].sha256) throw new Error("sqlite3.wasm does not match artifacts.json");
const serve = await mkdtemp(resolve(tmpdir(), "quixi-knn-"));
for (const file of ["index.html", "worker.js"]) await copyFile(resolve(here, file), resolve(serve, file));
for (const file of ["sqlite3.mjs", "sqlite3.wasm"]) await copyFile(resolve(root, "packages/storage/sqlite/dist", file), resolve(serve, file));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  const path = request.url === "/" ? "/index.html" : request.url;
  try { const body = await readFile(resolve(serve, `.${path}`)); response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }); response.end(body); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise((ready) => server.listen(4303, "127.0.0.1", ready));
const origin = "http://127.0.0.1:4303";
const environment = { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, totalMemoryBytes: totalmem(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version, sqliteWasmSha256: manifest.artifacts["sqlite3.wasm"].sha256 };
try {
  for (const size of sizes) {
    const report = { version: 1, measuredAt: new Date().toISOString(), size, floatChunkSize: floatChunkSize ?? "default (1024)", batch, queries, repetitions, environment, engines: {}, note: "Pinned SQLite WASM + sqlite-vec on the OPFS SAHPool VFS in a dedicated worker; brute-force vec0 scans; pseudo-random vectors; single observations on a shared development host." };
    for (const [name, engine] of browserEngines({ chromium, webkit })) {
      const profile = await mkdtemp(resolve(tmpdir(), `quixi-knn-${name}-`));
      const context = await engine.launchPersistentContext(profile, { headless: true });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      try {
        await page.goto(`${origin}/`);
        await page.waitForFunction(() => window.quixiReady === true);
        const call = (command) => page.evaluate((c) => window.quixiMeasure(c), command);
        const opened = await call({ command: "open", name: `knn-${size}${suffix}`, floatChunkSize, fresh: true });
        const started = Date.now();
        const inserts = [];
        for (let from = 1; from <= size; from += batch) inserts.push((await call({ command: "insert", from, to: Math.min(size + 1, from + batch) })).ms);
        const buildMs = Date.now() - started;
        console.log(`${name} ${size}: built in ${(buildMs / 1000).toFixed(1)} s`);
        const steady = await call({ command: "measure", queries, repetitions });
        console.log(`${name} ${size}: float ${steady.floatKnnTop64.medianMs.toFixed(1)} ms, int8 coarse ${steady.int8CoarseTop500.medianMs.toFixed(1)} ms, coarse+rerank ${steady.int8CoarseThenFloatRerankTop64.medianMs.toFixed(1)} ms, agreement ${steady.top64AgreementWithFloat.toFixed(3)}, misses/query ${steady.int8CoarseThenFloatRerankTop64.pageCacheMissesPerQuery}`);
        const backfill = await call({ command: "underBackfill", from: size + 1, batch: backfillBatch, batches: backfillBatches });
        console.log(`${name} ${size}: under backfill write ${backfill.writeMs.medianMs.toFixed(0)} ms/${backfillBatch}, query after write ${backfill.coarseRerankAfterWrite.medianMs.toFixed(1)} ms (p95 ${backfill.coarseRerankAfterWrite.p95Ms.toFixed(1)})`);
        // Cold page cache: close the connection, reopen the same files and query once.
        await call({ command: "close" });
        const reopened = await call({ command: "open", name: `knn-${size}${suffix}`, floatChunkSize, fresh: false });
        if (reopened.rows !== size + backfillBatches * backfillBatch) throw new Error(`${name}: reopened ${reopened.rows} rows`);
        const cold = await call({ command: "measure", queries: 1, repetitions: 1 });
        await call({ command: "wipe" });
        report.engines[name] = { browser: engine.name(), version: context.browser()?.version() ?? null, opened, buildMs, insertBatchMs: { medianMs: [...inserts].sort((a, b) => a - b)[Math.floor(inserts.length / 2)], maxMs: Math.max(...inserts) }, steady, underBackfill: backfill, coldReopen: { rows: reopened.rows, floatKnnTop64: cold.floatKnnTop64, int8CoarseTop500: cold.int8CoarseTop500, int8CoarseThenFloatRerankTop64: cold.int8CoarseThenFloatRerankTop64, opfsBytes: cold.opfsBytes }, errors };
        if (errors.length) throw new Error(`${name}: page errors ${JSON.stringify(errors)}`);
      } finally {
        await page.evaluate((c) => window.quixiMeasure(c), { command: "wipe" }).catch(() => {});
        await context.close().catch(() => {});
        await rm(profile, { recursive: true, force: true });
      }
    }
    await writeFile(resolve(here, `../browser-knn-${size}${suffix}.json`), JSON.stringify(report, null, 2) + "\n");
  }
} finally {
  server.close();
  await rm(serve, { recursive: true, force: true });
}
