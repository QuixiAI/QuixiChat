/** Plan 09 cross-host restore: export a portable archive from the web host
 * (production Storage Worker in Playwright Chromium), restore it inside the
 * native Tauri WebView (production Storage Worker on macOS WebKit), and
 * compare canonical record digests per collection and every blob file's
 * hash. Nothing is activated on either side.
 *
 *   node tests/hosts/archive-cross-host/run.mjs [--skip-build]
 */
import { build, preview } from "vite";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { deflateSync } from "node:zlib";

const here = import.meta.dirname, root = resolve(here, "../../.."), harness = resolve(root, "packages/app/tests/browser");
const skipBuild = process.argv.includes("--skip-build");
const binary = resolve(root, "target/debug/quixi-archive-cross-host-proof");
const SIZES = { threads: 6, perThread: 5, planted: 0 };
const report = {
  status: "running", startedAt: new Date().toISOString(), sizes: SIZES, sourceSha256: {}, commands: [],
  environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  scope: "Web host export (Playwright Chromium, production Storage Worker) restored in the native Tauri WebView (macOS WebKit, production Storage Worker); the candidate is validated and read back through the retained-archive reader, never activated.",
  web: null, native: null, comparison: null, checks: [],
};
const output = resolve(root, "test-results/archive-cross-host.json");
const save = async () => { await mkdir(resolve(root, "test-results"), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const typed = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed)); return Buffer.concat([length, typed, crc]); };
const pngImage = (width, height, rgba) => {
  const stride = width * 4 + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba(x, y).forEach((value, index) => { raw[y * stride + 1 + x * 4 + index] = value; });
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
};
const run = (argv, timeout = 900_000, env = {}) => new Promise((done) => {
  const started = new Date().toISOString();
  const child = spawn(argv[0], argv.slice(1), { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  child.on("close", (code) => { clearTimeout(timer); report.commands.push({ argv: argv.map((value) => value.replace(root, ".")), startedAt: started, completedAt: new Date().toISOString(), exitCode: code, stderr: stderr.slice(-4000) }); done({ code, stdout, stderr }); });
});
const must = async (argv, timeout) => { const result = await run(argv, timeout); if (result.code !== 0) throw new Error(`${argv.join(" ")} exited ${result.code}\n${result.stderr.slice(-2000)}`); return result.stdout; };
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-cross-host-"));
let server;
try {
  if (platform() !== "darwin") throw new Error("The native side of this proof runs the macOS Tauri WebView.");
  for (const file of ["packages/storage/tests/archives/cross-host.ts", "packages/storage/src/worker/archives/index.ts", "packages/storage/src/worker/archives/export.ts", "packages/storage/src/client/retained-archive.ts", "packages/storage/src/worker/retained-archive.ts", "packages/app/tests/browser/index.ts", "tests/hosts/archive-cross-host/index.ts", "tests/hosts/archive-cross-host/native.rs", "tests/hosts/archive-cross-host/build.mjs", "tests/hosts/archive-cross-host/run.mjs", "apps/desktop/src-tauri/tauri.conf.json"])
    report.sourceSha256[file] = digest(await readFile(resolve(root, file)));
  // 1. Web host: seed, export, dump.
  const outDir = resolve(temporary, "dist");
  await build({ configFile: false, root: harness, build: { outDir, emptyOutDir: true }, logLevel: "warn" });
  server = await preview({ configFile: false, root: harness, build: { outDir }, preview: { host: "127.0.0.1", port: 4204, strictPort: true }, logLevel: "warn" });
  const context = await chromium.launchPersistentContext(resolve(temporary, "chromium"), { headless: true, viewport: { width: 1280, height: 900 } });
  const errors = [];
  let portable;
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:4204/?archive=test-cross-host-${randomUUID()}&embedding=missing`);
    await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
    const seeded = await page.evaluate((sizes) => window.appAcceptance.semanticScale.seed(sizes), SIZES);
    const image = await page.evaluate((png) => window.appAcceptance.seedImageThread(png, "Cross-host image thread"), pngImage(3, 2, (x, y) => [40 * x, 90 * y, 200, 255]).toString("base64"));
    const indexed = await page.evaluate(() => window.appAcceptance.semanticScale.index());
    const exported = await page.evaluate(() => window.appAcceptance.archiveScale.export({ format: "portable" }));
    const parts = [];
    for (let offset = 0; offset < exported.byteLength; offset += 8 * 1024 * 1024)
      parts.push(Buffer.from(await page.evaluate(([o, l]) => window.appAcceptance.archiveScale.slice("portable", o, l), [offset, Math.min(8 * 1024 * 1024, exported.byteLength - offset)]), "base64"));
    portable = Buffer.concat(parts);
    if (digest(portable) !== exported.sha256) throw new Error("Pulled export bytes do not match the job's digest");
    const dump = await page.evaluate(() => window.appAcceptance.crossHost.dump());
    report.web = { engine: "chromium", seedMs: Math.round(seeded.seedMs), imageThread: image, indexedChunks: indexed.indexedChunks, export: { byteLength: exported.byteLength, sha256: exported.sha256, advances: exported.advances, phases: exported.phases }, dump };
    report.checks.push(`the web host exports a portable archive of ${dump.records} canonical records (${dump.blobs.length} blob files) in ${exported.advances} bounded steps`);
    await page.evaluate(() => window.appAcceptance.close());
    if (errors.length) throw new Error(`web page errors ${JSON.stringify(errors)}`);
  } finally { await context.close().catch(() => {}); }
  await save();
  // 2. Native host: bundle the bytes into the proof page and build the binary.
  await mkdir(resolve(here, "public"), { recursive: true });
  await writeFile(resolve(here, "public/archive.portable"), portable);
  if (!skipBuild) {
    await must(["node_modules/.bin/tsc", "--noEmit", "-p", "tests/hosts/archive-cross-host/tsconfig.json"]);
    await must(["node", "tests/hosts/archive-cross-host/build.mjs"]);
    await must(["cargo", "build", "--locked", "-p", "quixi-desktop", "--bin", "quixi-archive-cross-host-proof", "--features", "archive-cross-host-proof"]);
  }
  report.binarySha256 = digest(await readFile(binary));
  report.bundledArchiveSha256 = digest(await readFile(resolve(here, "build/dist/archive.portable")));
  if (report.bundledArchiveSha256 !== report.web.export.sha256) throw new Error("The bundled archive differs from the web export");
  const profile = randomUUID();
  const native = await run([binary], 300_000, { QUIXI_ARCHIVE_PROOF_PROFILE: profile });
  const lines = native.stdout.split("\n");
  report.native = { profile, exitCode: native.code, checkpoints: lines.filter((line) => line.startsWith("QUIXI_ARCHIVE_PROOF_CHECKPOINT=")).map((line) => line.slice("QUIXI_ARCHIVE_PROOF_CHECKPOINT=".length)) };
  const reports = lines.filter((line) => line.startsWith("QUIXI_ARCHIVE_PROOF=")).map((line) => JSON.parse(line.slice("QUIXI_ARCHIVE_PROOF=".length)));
  if (reports.length !== 1) throw new Error("Native WebView did not return exactly one proof report");
  report.native.result = reports[0];
  const webview = reports[0].webview;
  if (!webview.success) throw new Error(`native restore failed: ${webview.error ?? "unknown"}`);
  report.checks.push(...webview.checks.map((check) => `native: ${check}`));
  // 3. Compare.
  const web = report.web.dump, candidate = webview.candidateDump;
  const collections = {};
  for (const name of Object.keys(web.collections)) collections[name] = { web: web.collections[name], native: candidate.collections[name], equal: web.collections[name].count === candidate.collections[name].count && web.collections[name].sha256 === candidate.collections[name].sha256 };
  const blobKey = (list) => list.map((blob) => `${blob.path}:${blob.sha256}:${blob.bytes}`).sort().join("\n");
  const blobsEqual = blobKey(web.blobs) === blobKey(candidate.blobs);
  report.comparison = { collections, records: { web: web.records, native: candidate.records, candidateSummary: webview.restore.candidate.canonicalRecords }, syncOperations: { web: web.syncOperations, native: candidate.syncOperations }, blobs: { web: web.blobs.length, native: candidate.blobs.length, equal: blobsEqual } };
  const unequal = Object.entries(collections).filter(([, value]) => !value.equal).map(([name]) => name);
  if (unequal.length) throw new Error(`collections differ between hosts: ${unequal.join(", ")}`);
  if (!blobsEqual) throw new Error("blob hashes differ between hosts");
  if (web.records !== candidate.records || web.records !== webview.restore.candidate.canonicalRecords) throw new Error("record counts differ between hosts");
  if (web.syncOperations !== candidate.syncOperations) throw new Error("sync operation counts differ between hosts");
  if (web.blobs.length < 1) throw new Error("the archive carried no blob file to compare");
  report.checks.push(`every collection's record digest, the ${web.records} canonical records, the ${web.syncOperations} sync operations and all ${web.blobs.length} blob file hashes match between the web export and the native restore candidate`);
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
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, comparison: report.comparison }, null, 1));
}
