import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const directory = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tests = (await readdir(directory))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => resolve(directory, name));
if (!tests.length)
  throw new Error("No extraction/search integration tests found.");
const startedAt = new Date().toISOString();
const run = spawnSync(
  process.execPath,
  ["--experimental-transform-types", "--test", "--test-reporter=tap", ...tests],
  { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
);
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
const tap = run.stdout ?? "",
  number = (name) =>
    Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(tap)?.[1] ?? 0);
const schemaLine = /^# quixi-extraction-schema (.+)$/m.exec(tap)?.[1];
const metrics = [...tap.matchAll(/^# quixi-extraction-metric (.+)$/gm)].map(
  (match) => JSON.parse(match[1]),
);
const files = [
  "packages/core/src/contracts/extraction.ts",
  "packages/storage/src/worker/extraction/index.ts",
  "packages/storage/src/worker/extraction/schema.ts",
  "packages/storage/src/worker/search/index.ts",
  "packages/storage/src/worker/search/schema.ts",
  "packages/storage/src/worker/search/sources.ts",
  "packages/storage/src/worker/search/extraction.ts",
  "packages/storage/tests/extraction-search/fixture.ts",
  "packages/storage/tests/extraction-search/repository.test.ts",
  "packages/storage/tests/extraction-search/run.mjs",
  "packages/storage/sqlite/dist/sqlite3.wasm",
];
const sourceHashes = {};
for (const file of files)
  sourceHashes[file] = createHash("sha256")
    .update(await readFile(resolve(root, file)))
    .digest("hex");
const result = {
  startedAt,
  completedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  status: run.status === 0 && number("tests") > 0 ? "passed" : "failed",
  exitCode: run.status,
  signal: run.signal,
  tests: number("tests"),
  passed: number("pass"),
  failed: number("fail"),
  canonicalMigrations: schemaLine ? JSON.parse(schemaLine) : null,
  sourceHashes,
  metrics,
  evidenceScope:
    "Pinned SQLite WASM in Node memory VFS with real canonical/extraction/search repositories, transactions, SQLite close/reopen and FTS5. Original blob availability is an injected proof check; no PDF parser runs here. No production StorageClient, OPFS, browser-owner termination or app integration claim.",
};
await mkdir(resolve(directory, "results"), { recursive: true });
await writeFile(
  resolve(directory, "results/repository-wasm.json"),
  JSON.stringify(result, null, 2) + "\n",
);
await writeFile(
  resolve(directory, "results/repository.tap"),
  tap + (run.stderr ?? ""),
);
if (result.status !== "passed") process.exitCode = run.status || 1;
