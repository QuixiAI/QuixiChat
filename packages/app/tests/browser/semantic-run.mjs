import { build, preview } from "vite";
import { chromium, webkit } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { browserEngines } from "../../../../tooling/browser-engines.mjs";
import { embeddingModelAssets, embeddingModelSource } from "../../../../tooling/embedding-assets.ts";
import { exerciseSemanticSearch } from "./semantic.mjs";

const selectedEngines = browserEngines({ chromium, webkit });
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-semantic-"));
const report = {
  selectedEngines: selectedEngines.map(([name]) => name), status: "running", startedAt: new Date().toISOString(), hosts: [], sourceSha256: {},
  environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  model: { source: embeddingModelSource(), provisioned: existsSync(embeddingModelSource()) },
};
const save = async () => { await mkdir("test-results", { recursive: true }); await writeFile("test-results/app-semantic-browser.json", JSON.stringify(report, null, 2) + "\n"); };
let server;
try {
  if (!report.model.provisioned) throw new Error(`The pinned model is not provisioned at ${report.model.source}; compile it with packages/quixi-embed/compiler/compile_model.py first.`);
  for (const file of [
    "packages/app/src/features/semantic/controller.ts", "packages/app/src/features/semantic/SemanticPanel.tsx", "packages/app/src/features/semantic/assets.ts",
    "packages/app/src/AppRoot.tsx", "packages/app/src/runtime/library.ts", "packages/app/tests/browser/index.ts", "packages/app/tests/browser/semantic.mjs", "packages/app/tests/browser/semantic-run.mjs",
    "packages/search/src/semantic/indexer.ts", "packages/search/src/fusion.ts", "packages/search/src/chunker.ts",
    "packages/storage/src/worker/search/semantic.ts", "packages/storage/src/worker/search/index.ts", "packages/storage/src/worker/search/schema.ts", "packages/storage/src/worker/search/tokenizer.ts", "packages/storage/src/worker/chunk-tokenizer.ts", "packages/storage/src/worker/archive-database.ts",
    "packages/quixi-embed/src/chunking.ts", "packages/quixi-embed/src/lock.ts", "packages/quixi-embed/src/service/worker.ts", "packages/quixi-embed/src/service/client.ts", "packages/quixi-embed/src/service/assets.ts", "packages/quixi-embed/src/service/protocol.ts",
    "packages/quixi-embed/artifacts/model/lock.json", "packages/quixi-embed/artifacts/model/arctic-xs.qxtokenizer", "packages/quixi-embed/artifacts/1.0.2/quixi-scalar.wasm", "packages/quixi-embed/artifacts/1.0.2/quixi-simd.wasm",
    "packages/core/src/contracts/search.ts", "tooling/embedding-assets.ts",
    "packages/quixi-embed/src/service/self-test.ts", "packages/quixi-embed/src/service/self-test-cases.ts", "packages/app/src/features/diagnostics/DiagnosticsPanel.tsx", "packages/app/src/features/diagnostics/report-controller.ts",
  ]) report.sourceSha256[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  report.sourceSha256[report.model.source] = createHash("sha256").update(await readFile(report.model.source)).digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true, rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html") } } }, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: "127.0.0.1", port: 4199, strictPort: true }, plugins: [embeddingModelAssets()], logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const evidence = { name, status: "running", checks: [] };
    report.hosts.push(evidence);
    await save();
    const profile = resolve(temporary, name);
    Object.assign(evidence, await exerciseSemanticSearch({ engine, profile, name, origin: "http://127.0.0.1:4199" }));
    evidence.status = "passed";
    await save();
    console.log(`${name}: ${evidence.checks.length} semantic checks passed (${evidence.backend}, enable ${evidence.enableMs} ms, index ${evidence.indexMs} ms, restart ${evidence.restartMs} ms)`);
  }
  report.sourceStable = (await Promise.all(Object.entries(report.sourceSha256).map(async ([file, sha256]) => createHash("sha256").update(await readFile(file)).digest("hex") === sha256))).every(Boolean);
  if (!report.sourceStable) throw new Error("Semantic proof source changed during qualification");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
