import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { providerFixture, fixtureStats } from "./fixture-server.ts";
const root = resolve(import.meta.dirname, "../../..");
const output = resolve(root, "test-results/providers-native.json");
const sourceFiles = [
  "packages/providers/src/adapter.ts", "packages/providers/src/request.ts", "packages/providers/src/types.ts",
  "packages/providers/src/catalog.ts", "packages/providers/src/normalize.ts", "packages/providers/src/sse.ts",
  "packages/providers/tests/host-proof.ts", "packages/providers/tests/fixtures.ts", "packages/providers/tests/audio-fixtures.ts",
  "packages/providers/tests/fixture-server.ts", "packages/providers/tests/run-native.mjs",
  "apps/desktop/tests/host-proof.ts", "apps/desktop/tests/vite.host-proof.config.ts",
  "apps/desktop/src/host/index.ts", "apps/desktop/src-tauri/src/host_proof.rs",
  "apps/desktop/src-tauri/src/host/mod.rs", "apps/desktop/src-tauri/src/host/models.rs",
  "apps/desktop/src-tauri/src/host/secrets.rs", "apps/desktop/src-tauri/src/registered_destinations.rs",
  "tests/hosts/run_tauri_native_host_proof.py", "package-lock.json", "Cargo.lock",
];
const hashSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(resolve(root, file))).digest("hex")])));
const sourceSha256 = await hashSources();
const fixture = createServer(providerFixture);
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
try {
  const child = spawn(
    "python3",
    [
      "tests/hosts/run_tauri_native_host_proof.py",
      "--providers-only",
      "--output",
      output,
      ...(process.argv.includes("--skip-build") ? ["--skip-build"] : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        QUIXI_PROVIDER_PROOF_ORIGIN: `http://127.0.0.1:${fixture.address().port}`,
      },
      stdio: "inherit",
    },
  );
  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const report = JSON.parse(await readFile(output, "utf8"));
  report.providerFixture = { ...fixtureStats };
  report.sourceSha256 = sourceSha256;
  report.sourceStable = JSON.stringify(await hashSources()) === JSON.stringify(sourceSha256);
  report.success = report.success && report.sourceStable && fixtureStats.disconnected >= 2 && fixtureStats.audioWav >= 1 && fixtureStats.audioMp3 >= 1;
  report.testScope =
    "Actual macOS bundled Tauri WebView and native HostClient; controlled synthetic OpenAI-compatible/Anthropic endpoints; no live provider calls.";
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (exit || !report.success) process.exitCode = 1;
} finally {
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
