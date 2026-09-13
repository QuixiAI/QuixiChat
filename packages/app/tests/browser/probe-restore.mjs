/** Restore-only probe over a kept stress profile and its exported container:
 * opens the seeded archive on the stress harness origin (port 4206), streams
 * the container back from disk and drives the isolated restore validation
 * with the harness's progress lines forwarded, so the restore phase can be
 * measured or debugged without repeating the seed and export.
 *
 *   node packages/app/tests/browser/probe-restore.mjs <profile-dir> <container-file>
 */
import { build, preview } from "vite";
import { webkit } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, open as openFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const [profile, container] = process.argv.slice(2);
if (!profile || !container) throw new Error("usage: probe-restore.mjs <profile-dir> <container-file>");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-probe-restore-"));
const outDir = resolve(temporary, "dist");
await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: "warn" });
const server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: "127.0.0.1", port: 4206, strictPort: true }, logLevel: "warn" });
const report = { status: "failed", startedAt: new Date().toISOString(), container: { path: container, bytes: (await stat(container)).size, sha256: null }, restore: null };
const context = await webkit.launchPersistentContext(resolve(profile, "webkit"), { headless: true });
try {
  const hash = createHash("sha256"); const file = await openFile(container, "r"); const block = Buffer.alloc(8 * 1024 * 1024);
  try { for (let offset = 0; ; ) { const { bytesRead } = await file.read(block, 0, block.length, offset); if (!bytesRead) break; hash.update(block.subarray(0, bytesRead)); offset += bytesRead; } } finally { await file.close(); }
  report.container.sha256 = hash.digest("hex");
  log("container", report.container.bytes, "bytes", report.container.sha256.slice(0, 16));
  const page = await context.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.text().startsWith("[stress] ")) log(m.text().slice(9)); });
  await page.goto("http://127.0.0.1:4206/?archive=test-probe-0&embedding=missing");
  await page.waitForTimeout(3000);
  const names = await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const out = []; for await (const [name] of root.entries()) out.push(name); return out; });
  const archive = names.map((n) => n.replace(/^quixi-/, "")).find((n) => n.startsWith("test-stress-"));
  if (!archive) throw new Error(`no stress archive in profile: ${names.join(",")}`);
  await page.evaluate(() => window.appAcceptance.close()).catch(() => {});
  await page.goto(`http://127.0.0.1:4206/?archive=${archive}&embedding=missing`);
  await page.getByRole("heading", { name: "Pick up where you left off." }).waitFor({ timeout: 120_000 });
  log("opened", archive);
  const started = Date.now();
  const begun = await page.evaluate(([length, digest]) => window.appAcceptance.stress.beginRestore(length, digest), [report.container.bytes, report.container.sha256]);
  const reader = await openFile(container, "r"); const chunk = Buffer.alloc(4 * 1024 * 1024); let offset = 0;
  try {
    for (;;) {
      const { bytesRead } = await reader.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      await page.evaluate((text) => window.appAcceptance.stress.sendRestoreBytes(text), chunk.subarray(0, bytesRead).toString("base64"));
      offset += bytesRead;
      if (offset % (512 * 1024 * 1024) === 0) log("sent", (offset / 1048576).toFixed(0), "MB");
    }
  } finally { await reader.close(); }
  const sentMs = Date.now() - started;
  log("sent all", (offset / 1048576).toFixed(0), "MB in", (sentMs / 1000).toFixed(0), "s; validating");
  const restored = await page.evaluate(() => window.appAcceptance.stress.finishRestore());
  report.restore = { ...restored, sentMs, maxChunkBytes: begun.maxChunkBytes };
  log("restore", restored.state, restored.failure ? JSON.stringify(restored.failure) : "", "advances", restored.advances, "phases", restored.phases.join(">"), "validated in", (restored.validatedMs / 1000).toFixed(0), "s", "records", restored.candidate?.canonicalRecords);
  report.pageErrors = errors;
  report.status = restored.state === "ready" ? "passed" : "failed";
  await page.evaluate(() => window.appAcceptance.close()).catch(() => {});
} catch (error) {
  report.error = String(error?.message ?? error); console.error(report.error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(import.meta.dirname, "results", "probe-restore.json"), JSON.stringify(report, null, 2) + "\n");
  await context.close().catch(() => {});
  await new Promise((done) => server.httpServer.close(done));
  await rm(temporary, { recursive: true, force: true });
}
