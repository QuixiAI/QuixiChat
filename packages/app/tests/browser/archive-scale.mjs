/** Plan 09 scale proof: portable and open exports of a large archive and an
 * isolated restore of the portable one through the production Storage Worker
 * in actual browsers, with bounded advance steps and no embeddings or Cloud
 * account (product §98, §99, §111). The open export's container is then
 * listed with the system `tar`, its JSONL parsed line by line with JSON.parse
 * and its Markdown read as text in Node: ordinary tools, no Quixi.
 *
 *   QUIXI_ARCHIVE_SCALE_THREADS=300 QUIXI_ARCHIVE_SCALE_PER_THREAD=100 node packages/app/tests/browser/archive-scale.mjs
 */
import { build, preview } from "vite";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, platform, release, arch, cpus } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { browserEngines } from "../../../../tooling/browser-engines.mjs";

const selectedEngines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, "../../../..");
const SIZES = { threads: Number(process.env.QUIXI_ARCHIVE_SCALE_THREADS ?? 300), perThread: Number(process.env.QUIXI_ARCHIVE_SCALE_PER_THREAD ?? 100), planted: 0 };
const total = SIZES.threads * SIZES.perThread;
const results = resolve(import.meta.dirname, "results");
const report = {
  status: "running", startedAt: new Date().toISOString(), sizes: { ...SIZES, messages: total },
  stepBounds: { maxRecords: 128, maxBytes: 1_048_576 },
  selectedEngines: selectedEngines.map(([name]) => name), hosts: [], sourceSha256: {},
  environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  qualification: "Synthetic short messages seeded through the production worker; the page runs with the embedding model unprovisioned and no Cloud account. Timings are single runs under development load on one machine.",
};
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-archive-scale-"));
const output = resolve(results, "archive-scale-browser.json");
const save = async () => { await mkdir(results, { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); };
/** Pulls an export's bytes out of the page in 8 MiB base64 slices. */
async function pull(page, format, byteLength) {
  const parts = [];
  for (let offset = 0; offset < byteLength; offset += 8 * 1024 * 1024) {
    const text = await page.evaluate(([f, o, l]) => window.appAcceptance.archiveScale.slice(f, o, l), [format, offset, Math.min(8 * 1024 * 1024, byteLength - offset)]);
    parts.push(Buffer.from(text, "base64"));
  }
  return Buffer.concat(parts);
}
let server;
try {
  for (const file of ["packages/storage/src/worker/archives/export.ts", "packages/storage/src/worker/archives/index.ts", "packages/core/src/contracts/archives.ts", "packages/app/tests/browser/index.ts", "packages/app/tests/browser/archive-scale.mjs"])
    report.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: "warn" });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: "127.0.0.1", port: 4196, strictPort: true }, logLevel: "warn" });
  for (const [name, engine] of selectedEngines) {
    const evidence = { name, status: "running", checks: [], phases: {}, openFormat: {} };
    report.hosts.push(evidence); await save();
    const url = `http://127.0.0.1:4196/?archive=test-archive-scale-${randomUUID()}&embedding=missing`;
    const context = await engine.launchPersistentContext(resolve(temporary, name), { headless: true, viewport: { width: 1280, height: 900 } });
    const errors = [];
    try {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(url);
      await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
      const seeded = await page.evaluate((sizes) => window.appAcceptance.semanticScale.seed(sizes), SIZES);
      evidence.phases.seed = { ms: Math.round(seeded.seedMs), batches: seeded.batches };
      // Derived search data is present, as in a used archive; exports do not need it.
      const indexed = await page.evaluate(() => window.appAcceptance.semanticScale.index());
      evidence.phases.lexical = { ms: Math.round(indexed.indexMs), indexedChunks: indexed.indexedChunks };
      const before = await page.evaluate(() => window.appAcceptance.archiveScale.diagnostics());
      evidence.phases.storageBefore = { usage: before.usage, quota: before.quota, schemaVersion: before.schemaVersion };
      console.log(`${name}: seeded ${total} messages in ${(seeded.seedMs / 1000).toFixed(1)} s; archive uses ${before.usage === null ? "unreported" : `${(before.usage / 1048576).toFixed(0)} MB`}`);
      // Portable export.
      const portable = await page.evaluate(() => window.appAcceptance.archiveScale.export({ format: "portable" }));
      evidence.phases.portableExport = portable;
      expect(portable.advances).toBeGreaterThan(1);
      console.log(`${name}: portable export ${(portable.byteLength / 1048576).toFixed(1)} MB in ${(portable.producedMs / 1000).toFixed(1)} s (${portable.advances} bounded steps, phases ${portable.phases.join("→")}), read in ${(portable.readMs / 1000).toFixed(1)} s`);
      evidence.checks.push(`portable export of ${total} messages produced ${(portable.byteLength / 1048576).toFixed(1)} MB in ${portable.advances} bounded steps (≤128 records, ≤1 MiB each) and streamed out in ${portable.chunks} chunks whose digest matches the job's`);
      // Isolated restore of the portable bytes: validated, never activated.
      const restored = await page.evaluate(() => window.appAcceptance.archiveScale.restore());
      evidence.phases.restore = restored;
      expect(restored.state).toBe("ready");
      expect(restored.candidate?.canonicalRecords).toBeGreaterThanOrEqual(total);
      console.log(`${name}: restore candidate validated in ${((restored.sentMs + restored.validatedMs) / 1000).toFixed(1)} s (${restored.advances} steps, phases ${restored.phases.join("→")}): ${restored.candidate.canonicalRecords} records, schema ${restored.candidate.schemaVersion}`);
      evidence.checks.push(`the portable bytes restore into an isolated candidate with ${restored.candidate.canonicalRecords} canonical records at schema ${restored.candidate.schemaVersion} after ${restored.advances} bounded validation steps; the active archive is untouched (the candidate is released, never activated)`);
      // A corrupted container must fail validation with a named cause and leave the active archive usable.
      const corrupt = await page.evaluate(() => window.appAcceptance.archiveScale.restore({ corrupt: true }));
      evidence.phases.corruptRestore = corrupt;
      expect(corrupt.state).toBe("failed");
      expect(typeof corrupt.failure?.code).toBe("string");
      expect(typeof corrupt.failure?.reason).toBe("string");
      const after = await page.evaluate(() => window.appAcceptance.archiveScale.diagnostics());
      evidence.phases.storageAfter = { usage: after.usage, quota: after.quota, integrity: after.integrity };
      expect(after.integrity).toBe("ok");
      const stillSearchable = await page.evaluate(() => window.appAcceptance.semanticScale.query({ mode: "exact", query: "\"Passage 7 of thread 3\"", filters: {}, maxItems: 5 }));
      expect(stillSearchable.count).toBeGreaterThanOrEqual(1);
      console.log(`${name}: corrupted container refused (${corrupt.failure.code}: ${corrupt.failure.reason.slice(0, 80)}) after ${corrupt.advances} steps; active archive integrity ${after.integrity}, exact search still answers`);
      evidence.checks.push(`a container with 64 KiB zeroed fails validation with a named cause (${corrupt.failure.code}) and the active archive stays intact: integrity ${after.integrity}, an exact search still answers`);
      // Open export: JSONL + Markdown in a TAR container.
      const open = await page.evaluate(() => window.appAcceptance.archiveScale.export({ format: "open" }));
      evidence.phases.openExport = open;
      console.log(`${name}: open export ${(open.byteLength / 1048576).toFixed(1)} MB in ${(open.producedMs / 1000).toFixed(1)} s (${open.advances} bounded steps)`);
      const tar = await pull(page, "open", open.byteLength);
      expect(createHash("sha256").update(tar).digest("hex")).toBe(open.sha256);
      const tarPath = resolve(temporary, `${name}-open.tar`);
      await writeFile(tarPath, tar);
      const extracted = resolve(temporary, `${name}-open`);
      await mkdir(extracted, { recursive: true });
      const listing = execFileSync("tar", ["-tf", tarPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim().split("\n");
      execFileSync("tar", ["-xf", tarPath, "-C", extracted]);
      const files = (await walk(extracted)).map((file) => file.slice(extracted.length + 1));
      const jsonl = files.filter((file) => file.endsWith(".jsonl")), markdown = files.filter((file) => file.endsWith(".md"));
      let records = 0, messages = 0, threads = 0, invalid = 0;
      for (const file of jsonl) {
        for (const line of (await readFile(join(extracted, file), "utf8")).split("\n")) {
          if (!line.trim()) continue;
          try { const record = JSON.parse(line); records++; const kind = String(record.collection ?? record.kind ?? ""); if (kind === "messages") messages++; if (kind === "threads") threads++; } catch { invalid++; }
        }
      }
      let markdownBytes = 0, markdownMessages = 0;
      for (const file of markdown) { const text = await readFile(join(extracted, file), "utf8"); markdownBytes += text.length; markdownMessages += (text.match(/^ {4}Passage \d+ of thread \d+/gm) ?? []).length; }
      evidence.openFormat = { entries: listing.length, jsonlFiles: jsonl.length, markdownFiles: markdown.length, jsonlRecords: records, jsonlInvalidLines: invalid, jsonlMessageRecords: messages, jsonlThreadRecords: threads, markdownBytes, markdownMessagePassages: markdownMessages, sample: files.slice(0, 6) };
      expect(invalid).toBe(0);
      expect(messages).toBe(total);
      expect(threads).toBe(SIZES.threads);
      expect(markdownMessages).toBe(total);
      console.log(`${name}: system tar lists ${listing.length} entries; ${jsonl.length} JSONL files parse to ${records} records (${invalid} invalid lines); ${markdown.length} Markdown files carry ${markdownMessages} message passages`);
      evidence.checks.push(`the open export is a TAR the system tar lists and extracts (${listing.length} entries); its ${jsonl.length} JSONL files parse line by line with JSON.parse into ${records} records with no invalid line, and its ${markdown.length} Markdown files carry all ${markdownMessages} message passages as plain text`);
      await page.evaluate(() => window.appAcceptance.close());
      if (errors.length) throw new Error(`${name}: page errors ${JSON.stringify(errors)}`);
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed"; evidence.error = String(error?.stack ?? error); evidence.pageErrors = errors;
      throw error;
    } finally {
      await save();
      await context.close().catch(() => {});
    }
  }
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
}
async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path))); else out.push(path);
  }
  return out;
}
