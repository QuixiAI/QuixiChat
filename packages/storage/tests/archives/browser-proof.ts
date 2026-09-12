import { browserEngines } from "../../../../tooling/browser-engines.mjs";
const selectedEngines = browserEngines({ chromium, webkit });
import { chromium, webkit } from "playwright";
import { build, preview } from "vite";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir, platform, release, arch } from "node:os";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-archive-copy-"));
const report = {
  selectedEngines: selectedEngines.map(([name]) => name),
  status: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null as string | null,
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
  },
  sourceSha256: {} as Record<string, string>,
  context: "fresh isolated persistent profiles",
  origin: null as string | null,
  hosts: [] as unknown[],
};
const reportPath =
  "packages/storage/tests/archives/results/snapshot-browser.json";
const save = async () => {
  await mkdir("packages/storage/tests/archives/results", { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
};
let server: Awaited<ReturnType<typeof preview>> | undefined;
try {
  await save();
  for (const file of [
    "tooling/browser-engines.mjs",
    "packages/storage/tests/archives/browser-proof.ts",
    "packages/storage/tests/archives/browser-worker.ts",
    "packages/storage/tests/archives/browser-roundtrip.ts",
    "packages/storage/tests/archives/compaction-roundtrip.ts",
    "packages/core/src/model/compaction.ts",
    "packages/core/src/model/validation.ts",
    "packages/storage/migrations/context-compaction.ts",
    "packages/storage/migrations/summary-proposals.ts",
    "packages/core/src/model/summaries.ts",
    "packages/storage/src/worker/canonical/summary-source.ts",
    "packages/storage/src/worker/canonical/repository.ts",
    "packages/storage/src/worker/archives/validation.ts",
    "packages/storage/tests/archives/schema-seven.ts",
    "packages/storage/tests/archives/schema-eight.ts",
    "packages/storage/tests/archives/browser-client.ts",
    "packages/storage/tests/archives/browser-workflows.ts",
    "packages/storage/src/worker/archives/index.ts",
    "packages/storage/src/worker/archives/clean-copy.ts",
    "packages/storage/src/worker/archives/schema-validation.ts",
    "packages/storage/migrations/index.ts",
    "packages/storage/migrations/operation-claims.ts",
    "packages/storage/sqlite/dist/sqlite3.wasm",
    "package-lock.json",
  ])
    report.sourceSha256[file] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const buildOptions = {
    outDir: resolve(temporary, "dist"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "browser.html") },
  };
  await build({
    configFile: false,
    root: import.meta.dirname,
    build: buildOptions,
    logLevel: "warn",
  });
  server = await preview({
    configFile: false,
    root: import.meta.dirname,
    build: buildOptions,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "warn",
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing private archive proof address");
  report.origin = `http://127.0.0.1:${address.port}`;
  for (const [name, engine] of selectedEngines) {
    const host = {
      name,
      status: "running",
      result: null as unknown,
      error: null as string | null,
    };
    report.hosts.push(host);
    await save();
    const context = await engine.launchPersistentContext(
      resolve(temporary, name),
      { headless: true },
    );
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      await page.goto(`${report.origin}/browser.html`);
      host.result = await page.evaluate(
        () => (window as typeof window & { proof: Promise<unknown> }).proof,
      );
      host.status = "passed";
      console.log(`${name}: snapshot passed`);
    } catch (error) {
      host.status = "failed";
      host.error = String(error);
      throw error;
    } finally {
      await context.close();
    }
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  throw error;
} finally {
  await new Promise<void>((resolveClose) =>
    server ? server.httpServer.close(() => resolveClose()) : resolveClose(),
  );
  report.finishedAt = new Date().toISOString();
  await save();
  await rm(temporary, { recursive: true, force: true });
}
