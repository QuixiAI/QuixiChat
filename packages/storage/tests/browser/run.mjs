import { browserEngines } from "../../../../tooling/browser-engines.mjs";
const selectedEngines = browserEngines({ chromium, webkit });
import { build, preview } from "vite";
import { chromium, webkit } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../../..");
const output = resolve(workspace, "test-results/blob-storage-browser.json");
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-blob-acceptance-"));
const report = { selectedEngines: selectedEngines.map(([name]) => name), status: "running", startedAt: new Date().toISOString(), hosts: [] };
await mkdir(resolve(workspace, "test-results"), { recursive: true });
const save = async () => writeFile(output, JSON.stringify(report, null, 2) + "\n");
await save();
let server;
try {
  report.sourceSha256 = {};
  for (const file of ["tooling/browser-engines.mjs", "packages/storage/tests/browser/search-verification.ts", "packages/storage/src/worker/search/index.ts", "packages/storage/src/worker/search/sources.ts", "packages/storage/src/worker/search/schema.ts", "packages/search/src/chunker.ts", "packages/storage/src/worker/blobs.ts", "packages/storage/src/worker/blob-catalog.ts", "packages/storage/src/worker/canonical/repository.ts", "packages/storage/migrations/index.ts", "packages/core/src/contracts/transfer.ts", "packages/storage/tests/browser/main.ts", "packages/storage/tests/browser/worker.ts", "packages/storage/tests/browser/catalog.ts", "packages/storage/tests/browser/run.mjs", "package-lock.json"]) {
    report.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(workspace, file))).digest("hex");
  }
  await save();
  await build({ configFile: false, root: import.meta.dirname, build: { outDir: resolve(temporary, "dist"), emptyOutDir: true }, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir: resolve(temporary, "dist") }, preview: { host: "127.0.0.1", port: 4187, strictPort: true }, logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const profile = resolve(temporary, name);
    const namespace = `quixi-blob-tests-${crypto.randomUUID()}`;
    const host = { name, status: "running", phases: {} }; report.hosts.push(host); await save();
    for (const operation of ["write", "restart"]) {
      const context = await engine.launchPersistentContext(profile, { headless: true });
      try {
        const page = await context.newPage();
        await page.goto("http://127.0.0.1:4187");
        await page.waitForFunction(() => typeof window.blobTest === "function");
        host.userAgent = await page.evaluate(() => navigator.userAgent);
        host.phases[operation] = await page.evaluate(({ operation, namespace }) => window.blobTest(operation, namespace), { operation, namespace });
        host.phases[`catalog_${operation}`] = await page.evaluate(({ operation, namespace }) => window.blobTest(`catalog_${operation}`, `${namespace}-catalog`), { operation, namespace });
        host.phases[`search_verification_${operation}`] = await page.evaluate(({ operation, namespace }) => window.blobTest(`search_verification_${operation}`, `${namespace}-search-verification`), { operation, namespace });
        if (operation === "restart" && JSON.stringify(host.phases.search_verification_write.after) !== JSON.stringify(host.phases.search_verification_restart.before)) throw new Error("Search verification changed canonical inventory across forced process restart");
        if (operation === "restart" && !host.phases.restart.stagedFiles.some(item => item.name === `${host.phases.interruption.transferId}.stage` && item.byteLength === 3)) throw new Error("Unfinished upload did not survive actual browser termination");
        if (operation === "write") host.phases.interruption = await page.evaluate(namespace => window.blobTest("leave_open", namespace), namespace);
        await save();
        if (operation === "restart" && name === "chromium") {
          const cdp = await context.newCDPSession(page);
          const origin = "http://127.0.0.1:4187";
          const before = await cdp.send("Storage.getUsageAndQuota", { origin });
          await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: before.usage + 262144 });
          try { host.phases.quota = await page.evaluate(namespace => window.blobTest("quota", namespace), namespace); }
          finally { await cdp.send("Storage.overrideQuotaForOrigin", { origin }); }
          host.phases.quota.usageBefore = before.usage;
          host.phases.quota.imposedQuota = before.usage + 262144;
          host.phases.afterQuota = await page.evaluate(namespace => window.blobTest("after_quota", namespace), namespace);
        } else if (operation === "restart") host.phases.quota = { status: "not_run", reason: "No equivalent browser quota override available in this harness" };
      } finally { await context.close(); }
    }
    host.status = "passed"; await save();
    console.log(`${name}: blob integrity, backpressure, restart and failure checks passed`);
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error?.stack ?? error); process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString(); await save();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
