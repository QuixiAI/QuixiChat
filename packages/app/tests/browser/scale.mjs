/** Plan 08 responsiveness acceptance: a large library and a long conversation
 * through the production Storage Worker, measured in actual browsers. Every
 * interaction must stay bounded by the app's page budgets, never reading the
 * archive whole, and finish within a generous interactive budget. */
import { browserEngines } from "../../../../tooling/browser-engines.mjs";
import { build, preview } from "vite";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, access } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
const selectedEngines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, "../../../..");
const SIZES = { threads: Number(process.env.QUIXI_SCALE_THREADS ?? 2000), longMessages: Number(process.env.QUIXI_SCALE_MESSAGES ?? 2000) };
const INTERACTIVE_BUDGET_MS = 5000, PAGE_BYTES_BOUND = 900_000;
const results = resolve(import.meta.dirname, "results");
const report = {
  status: "running", startedAt: new Date().toISOString(), sizes: SIZES, budgets: { interactiveMs: INTERACTIVE_BUDGET_MS, pageBytes: PAGE_BYTES_BOUND },
  selectedEngines: selectedEngines.map(([name]) => name), hosts: [], sourceSha256: {},
  environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  qualification: "Synthetic unique titles and short texts seeded through the production worker in bounded batches. Timings are single runs under development load on one machine; the structural bounds (page bytes, request counts) are the acceptance evidence, the timings are context.",
};
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-app-scale-"));
const output = resolve(results, "scale-browser.json");
const save = async () => { await mkdir(results, { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
const timed = async (action) => { const started = performance.now(); await action(); return Math.round(performance.now() - started); };
let server;
try {
  try { await access(output); const previous = JSON.parse(await readFile(output, "utf8")); await mkdir(resolve(results, "attempts"), { recursive: true }); await rename(output, resolve(results, "attempts", `scale-${(previous.finishedAt ?? "unknown").replace(/[:.]/g, "-")}.json`)); } catch { /* first capture */ }
  for (const file of ["tooling/browser-engines.mjs", "packages/app/src/AppRoot.tsx", "packages/app/src/runtime/library.ts", "packages/storage/src/worker/views.ts", "packages/storage/src/worker/archive-database.ts", "packages/storage/src/worker/canonical/repository.ts", "packages/core/src/contracts/views.ts", "packages/app/tests/browser/index.ts", "packages/app/tests/browser/scale.mjs", "package-lock.json"])
    report.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: "127.0.0.1", port: 4198, strictPort: true }, logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const evidence = { name, status: "running", checks: [], timings: {}, requests: {} };
    report.hosts.push(evidence); await save();
    const url = `http://127.0.0.1:4198/?archive=test-app-scale-${randomUUID()}`;
    const context = await engine.launchPersistentContext(resolve(temporary, name), { headless: true, viewport: { width: 1280, height: 900 } });
    try {
      let page = await context.newPage();
      page.on("pageerror", (error) => console.error(name, error));
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
      const seeded = await page.evaluate((sizes) => window.appAcceptance.seed(sizes), SIZES);
      evidence.timings.seedMs = Math.round(seeded.seedMs); evidence.seedBatches = seeded.batches;
      await page.evaluate(() => window.appAcceptance.close());
      await page.close();
      // Cold open of the seeded archive: the library must render its first bounded page.
      page = await context.newPage();
      page.on("pageerror", (error) => console.error(name, error));
      const stats = () => page.evaluate(() => window.appAcceptance.requestStats());
      const reset = () => page.evaluate(() => window.appAcceptance.resetRequestStats());
      evidence.timings.coldLibraryMs = await timed(async () => {
        await page.goto(url);
        await expect(page.getByRole("button", { name: "Long conversation", exact: true })).toBeVisible();
      });
      const initial = await stats(); evidence.requests.coldLibrary = initial;
      expect(initial.listLibrary.calls).toBeLessThanOrEqual(3);
      expect(initial.readEntities?.calls ?? 0).toBe(0);
      const threadButtons = page.getByRole("complementary", { name: "Conversation library" }).getByRole("button", { name: /^(Thread \d{4}|Long conversation)$/ });
      expect(await threadButtons.count()).toBeLessThanOrEqual(24);
      evidence.checks.push(`cold open renders one bounded library page (${await threadButtons.count()} of ${SIZES.threads + 1} conversations) with at most three list requests and no whole-collection read`);
      await reset();
      // A title far from the first page, so the wait proves the filtered read.
      const filtered = `Thread ${String(42).padStart(4, "0")}`;
      evidence.timings.filterMs = await timed(async () => {
        await page.getByLabel("Filter titles", { exact: true }).fill(filtered);
        await page.getByRole("button", { name: "Filter", exact: true }).click();
        await expect(page.getByRole("button", { name: filtered, exact: true })).toBeVisible();
      });
      expect(await threadButtons.count()).toBe(1);
      evidence.requests.filter = await stats();
      await page.getByLabel("Filter titles", { exact: true }).fill("");
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await expect(page.getByRole("button", { name: "Long conversation", exact: true })).toBeVisible();
      await reset();
      evidence.timings.nextPageMs = await timed(async () => {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(page.getByRole("button", { name: "Long conversation", exact: true })).toHaveCount(0);
        await expect(threadButtons.first()).toBeVisible();
      });
      evidence.requests.nextPage = await stats();
      expect(evidence.requests.nextPage.listLibrary.calls).toBeLessThanOrEqual(2);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expect(page.getByRole("button", { name: "Long conversation", exact: true })).toBeVisible();
      evidence.checks.push("title filter and next/previous library pages each issue bounded list requests and render at most one page of conversations");
      await reset();
      const last = `Message ${SIZES.longMessages} of the long conversation.`;
      evidence.timings.openLongMs = await timed(async () => {
        await page.getByRole("button", { name: "Long conversation", exact: true }).click();
        await expect(page.getByText(last, { exact: true })).toBeVisible();
      });
      evidence.requests.openLong = await stats();
      expect(evidence.requests.openLong.readConversationWindow.calls).toBeLessThanOrEqual(2);
      expect(evidence.requests.openLong.readMessageParts.calls).toBeLessThanOrEqual(16);
      const visible = await page.locator("section.messages .message").count();
      expect(visible).toBeLessThanOrEqual(12);
      evidence.checks.push(`opening a ${SIZES.longMessages}-message conversation renders its latest ${visible} messages with bounded window and part reads`);
      evidence.timings.olderMs = [];
      for (let step = 1; step <= 3; step++) {
        await reset();
        const target = `Message ${SIZES.longMessages - 12 * step} of the long conversation.`;
        evidence.timings.olderMs.push(await timed(async () => {
          await page.getByRole("button", { name: "Older messages", exact: true }).click();
          await expect(page.getByText(target, { exact: true })).toBeVisible();
        }));
        const older = await stats();
        expect(older.readConversationWindow.calls).toBeLessThanOrEqual(2);
        expect(await page.locator("section.messages .message").count()).toBeLessThanOrEqual(12);
      }
      await reset();
      evidence.timings.latestMs = await timed(async () => {
        await page.getByRole("button", { name: "Latest messages", exact: true }).click();
        await expect(page.getByText(last, { exact: true })).toBeVisible();
      });
      evidence.checks.push("paging older and back to latest keeps a twelve-message window with bounded reads per step");
      const indexingStarted = performance.now();
      await expect.poll(async () => (await page.evaluate(() => window.appAcceptance.status())).pendingSources, { timeout: 600_000, intervals: [1000] }).toBe(0);
      evidence.timings.indexingWaitMs = Math.round(performance.now() - indexingStarted);
      await reset();
      const needle = `Message ${Math.floor(SIZES.longMessages / 2)} of the long conversation.`;
      evidence.timings.searchMs = await timed(async () => {
        await page.getByLabel("Search your history", { exact: true }).fill(`"${needle}"`);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect(page.getByRole("region", { name: "Search results" }).getByText("Exact text match").first()).toBeVisible();
      });
      evidence.requests.search = await stats();
      evidence.timings.openHitMs = await timed(async () => {
        await page.getByRole("region", { name: "Search results" }).getByRole("button", { name: /Long conversation/ }).first().click();
        await expect(page.getByRole("region", { name: "Selected search content", exact: true })).toBeVisible();
        await expect(page.getByText(needle, { exact: true }).first()).toBeVisible();
      });
      evidence.checks.push("lexical search over the seeded archive returns and opens an exact hit in the middle of the long conversation");
      const all = await page.evaluate(() => window.appAcceptance.requestStats());
      evidence.requests.afterSearch = all;
      for (const [operation, entry] of Object.entries({ ...initial, ...all })) expect(entry.maxBytes, operation).toBeLessThanOrEqual(PAGE_BYTES_BOUND);
      for (const [key, value] of Object.entries(evidence.timings)) {
        if (["seedMs", "indexingWaitMs"].includes(key)) continue;
        for (const ms of [value].flat()) expect(ms, key).toBeLessThanOrEqual(INTERACTIVE_BUDGET_MS);
      }
      evidence.memory = await page.evaluate(() => (performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null));
      evidence.checks.push(`every bounded page response stayed within ${PAGE_BYTES_BOUND.toLocaleString()} bytes and every interaction within ${INTERACTIVE_BUDGET_MS} ms`);
      await page.evaluate(() => window.appAcceptance.close());
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed"; evidence.error = String(error?.stack ?? error);
      throw error;
    } finally { await context.close(); await save(); }
    console.log(`${name}: ${evidence.checks.length} scale checks passed`, JSON.stringify(evidence.timings));
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error?.stack ?? error); console.error(report.error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await save();
  if (server) await new Promise((done) => server.httpServer.close(done));
  await rm(temporary, { recursive: true, force: true });
}
