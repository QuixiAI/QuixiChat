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
import { exerciseOnboarding } from "./onboarding.mjs";

const selectedEngines = browserEngines({ chromium, webkit });
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-onboarding-"));
const report = {
  selectedEngines: selectedEngines.map(([name]) => name), status: "running", startedAt: new Date().toISOString(), hosts: [], sourceSha256: {},
  environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  model: { source: embeddingModelSource(), provisioned: existsSync(embeddingModelSource()) },
};
const save = async () => { await mkdir("test-results", { recursive: true }); await writeFile("test-results/app-onboarding-browser.json", JSON.stringify(report, null, 2) + "\n"); };
let server;
try {
  if (!report.model.provisioned) throw new Error(`The pinned model is not provisioned at ${report.model.source}; compile it with packages/quixi-embed/compiler/compile_model.py first.`);
  for (const file of [
    "packages/app/src/features/onboarding/controller.ts", "packages/app/src/features/onboarding/OnboardingPanel.tsx", "packages/app/src/features/preferences/PreferencesPanel.tsx",
    "packages/app/src/AppRoot.tsx", "packages/app/tests/browser/index.ts", "packages/app/tests/browser/onboarding.mjs", "packages/app/tests/browser/onboarding-run.mjs",
    "packages/core/src/contracts/preferences.ts", "packages/core/src/contracts/host.ts", "packages/storage/src/worker/preferences.ts", "apps/web/src/host/index.ts", "apps/desktop/src/host/index.ts",
  ]) report.sourceSha256[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  report.sourceSha256[report.model.source] = createHash("sha256").update(await readFile(report.model.source)).digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true, rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html") } } }, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: "127.0.0.1", port: 4201, strictPort: true }, plugins: [embeddingModelAssets()], logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const evidence = { name, status: "running", checks: [] };
    report.hosts.push(evidence);
    await save();
    const profile = resolve(temporary, name);
    Object.assign(evidence, await exerciseOnboarding({ engine, profile, name, origin: "http://127.0.0.1:4201" }));
    evidence.status = "passed";
    await save();
    console.log(`${name}: ${evidence.checks.length} onboarding checks passed`);
  }
  report.sourceStable = (await Promise.all(Object.entries(report.sourceSha256).map(async ([file, sha256]) => createHash("sha256").update(await readFile(file)).digest("hex") === sha256))).every(Boolean);
  if (!report.sourceStable) throw new Error("Onboarding proof source changed during qualification");
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
