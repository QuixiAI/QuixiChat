import { chromium, webkit, expect } from "@playwright/test";
import { browserEngines } from "../../../../tooling/browser-engines.mjs";
import { build, preview } from "vite";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir, platform, release, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "../../../.."),
  temporary = await mkdtemp(resolve(tmpdir(), "quixi-persist-pdf-"));
const engines = browserEngines({ chromium, webkit });
const output = resolve(root, "test-results/pdf-persistence-browser.json");
const report = {
  status: "running",
  selectedEngines: engines.map(([name]) => name),
  startedAt: new Date().toISOString(),
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    osVersion:
      platform() === "darwin"
        ? execFileSync("sw_vers", ["-productVersion"], {
            encoding: "utf8",
          }).trim()
        : release(),
    node: process.version,
  },
  sourceSha256: {},
  hosts: [],
};
const save = async () => {
  await mkdir(resolve(root, "test-results"), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
};
const call = (page, method, ...args) =>
  page.evaluate(
    async ({ method, args }) => window.persistenceTest[method](...args),
    { method, args },
  );
const request = (page, operation, args) =>
  call(page, "request", operation, args);
const waitFor = async (page, condition, timeout = 90000) => {
  const started = Date.now();
  for (;;) {
    const state = await call(page, "state");
    if (condition(state)) return state;
    if (state.outcome.state === "failed")
      throw new Error(JSON.stringify(state));
    if (Date.now() - started > timeout)
      throw new Error(`Workflow deadline: ${JSON.stringify(state)}`);
    await page.waitForTimeout(50);
  }
};
let server;
try {
  execFileSync(
    process.execPath,
    ["packages/documents/tests/verify-distribution.mjs"],
    { cwd: root, stdio: "pipe" },
  );
  const files = [
    "tooling/browser-engines.mjs",
    "packages/documents/src/persist.ts",
    "packages/documents/src/persist-mutation.ts",
    "packages/documents/src/storage-source.ts",
    "packages/documents/src/storage.ts",
    "packages/documents/src/index.ts",
    "packages/documents/src/contracts.ts",
    "packages/documents/src/worker/index.ts",
    "packages/documents/src/worker/parser.ts",
    "packages/documents/src/worker/assets.ts",
    "packages/documents/tests/fixtures/pages-1.pdf",
    "packages/documents/tests/fixtures/pages-100.pdf",
    "node_modules/pdfjs-dist/build/pdf.worker.mjs",
    "packages/documents/tests/persistence-browser/index.ts",
    "packages/documents/tests/persistence-browser/run.mjs",
    "packages/storage/src/client/archive.ts",
    "packages/storage/src/worker/archive-database.ts",
    "packages/storage/src/worker/archive-runtime.ts",
    "packages/storage/src/worker/extraction/index.ts",
    "packages/storage/src/worker/extraction/schema.ts",
    "packages/storage/src/worker/operation-claims.ts",
    "packages/storage/src/worker/search/index.ts",
    "packages/storage/src/worker/search/sources.ts",
    "packages/storage/src/worker/search/extraction.ts",
    "packages/storage/src/worker/search/schema.ts",
    "packages/core/src/contracts/extraction.ts",
    "packages/storage/sqlite/dist/sqlite3.wasm",
  ];
  for (const file of files)
    report.sourceSha256[file] = createHash("sha256")
      .update(await readFile(resolve(root, file)))
      .digest("hex");
  const outDir = resolve(temporary, "dist");
  await build({
    configFile: false,
    root: import.meta.dirname,
    logLevel: "warn",
    plugins: [
      {
        name: "pdf-license-retention",
        async generateBundle() {
          for (const name of await readdir(
            resolve(root, "packages/documents/third-party"),
          ))
            this.emitFile({
              type: "asset",
              fileName: `third-party/${name}`,
              source: await readFile(
                resolve(root, "packages/documents/third-party", name),
              ),
            });
        },
      },
    ],
    build: { outDir, emptyOutDir: true, assetsInlineLimit: 0 },
    worker: { format: "es" },
  });
  server = await preview({
    configFile: false,
    root: import.meta.dirname,
    logLevel: "warn",
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("No isolated origin");
  const origin = `http://127.0.0.1:${address.port}`;
  report.origin = origin;
  for (const [name, engine] of engines) {
    const host = {
      name,
      status: "running",
      checks: [],
      external: [],
      consoleErrors: [],
    };
    report.hosts.push(host);
    await save();
    const profile = resolve(temporary, name);
    let context = await engine.launchPersistentContext(profile, {
      headless: true,
    });
    const visit = async () => {
      const page = await context.newPage();
      page.on("pageerror", (error) => {
        if (host.consoleErrors.length < 20)
          host.consoleErrors.push(String(error));
      });
      await page.goto(origin);
      await page.waitForFunction(() => !!window.persistenceTest);
      return page;
    };
    const observe = () =>
      context.on("request", (request) => {
        if (
          !request.url().startsWith(origin + "/") &&
          host.external.length < 20
        )
          host.external.push(request.url());
      });
    observe();
    let large, small, firstRef, firstMap, chatMessage, largeRun;
    try {
      const page = await visit();
      host.userAgent = await page.evaluate(() => navigator.userAgent);
      const initial = await page.evaluate(async () => {
        const names = [];
        for await (const item of (
          await navigator.storage.getDirectory()
        ).values())
          names.push(item.name);
        return names.sort();
      });
      expect(initial).toEqual([]);
      host.initialOpfs = initial;
      const diagnostics = await call(page, "open");
      // Canonical schema 12 (context compaction 11, summary proposals 12).
      expect(diagnostics.schemaVersion).toBe(12);
      large = await call(page, "seed", 100);
      await call(page, "start", large.documentId, true);
      host.paused = await waitFor(page, (state) => state.paused);
      expect(host.paused.outcome.state).toBe("running");
      expect(host.paused.latest.indexedThroughPage).toBe(1);
      expect(host.paused.parserWorkersStarted).toBe(1);
      const progress = await request(page, "getDocumentExtraction", {
        documentId: large.documentId,
      });
      expect(progress.completedPage).toBe(1);
      expect(progress.pageCount).toBe(100);
      expect(progress.state).toBe("working");
      largeRun = progress.runId;
      const early = await call(
        page,
        "query",
        '"Quixi document fixture"',
        large.documentId,
      );
      expect(early.items.some((hit) => hit.position.page === 1)).toBe(true);
      firstRef = await request(page, "getPublishedExtractionPage", {
        runId: largeRun,
        page: 1,
      });
      expect(firstRef.page).toBe(1);
      expect(firstRef.identity.attachmentSha256).toBe(large.sha256);
      const text = await request(page, "readExtractedPageText", {
        pageRef: firstRef,
        startUTF16: 0,
        maxUTF16: 4096,
      });
      expect(text.text).toContain("Quixi document fixture page 1");
      firstMap = await request(page, "readExtractedPageMap", {
        pageRef: firstRef,
        startUTF16: 0,
        endUTF16: text.totalUTF16,
        maxItems: 32,
        maxBytes: 16384,
        cursor: null,
      });
      expect(
        firstMap.items.some(
          (span) =>
            span.source &&
            span.source.transform.length === 6 &&
            Number.isInteger(span.source.itemIndex),
        ),
      ).toBe(true);
      expect(
        firstMap.items.every(
          (span) => span.start >= 0 && span.end <= text.totalUTF16,
        ),
      ).toBe(true);
      host.navigation = {
        documentId: large.documentId,
        sourceSha256: large.sha256,
        pageRef: firstRef,
        firstOriginalSpan: firstMap.items.find((span) => span.source),
        offsetUnit: "page-local UTF-16; original PDF item coordinates",
      };
      expect(early.items[0].documentId).toBe(large.documentId);
      host.checks.push(
        "actual pinned PDF.js publishes and indexes page1 of a100-page real PDF before completion; source ref and bounded maps retain original PDF item coordinates",
      );
      await save();

      const competing = await visit();
      await call(competing, "open");
      await call(competing, "start", large.documentId, false);
      host.competingProducer = await call(competing, "finish");
      expect(host.competingProducer.state).toBe("failed");
      expect(host.competingProducer.error.code).toBe("CAPACITY");
      expect((await call(competing, "state")).parserWorkersStarted).toBe(0);
      await call(competing, "close");
      await competing.close();
      chatMessage = await call(page, "chat");
      expect(chatMessage.parts.items[0].data.text).toContain(
        "Concurrent chat stays usable",
      );
      expect((await call(page, "state")).paused).toBe(true);
      host.checks.push(
        "awaited downstream page1 progress pauses the real parser pipeline while a competing producer tab is refused and canonical chat commit/read stays usable",
      );
      const beforeCancel = await request(page, "diagnostics", null);
      host.cancelled = await call(page, "cancel");
      const interrupted = await request(page, "getDocumentExtraction", {
        documentId: large.documentId,
      });
      expect(interrupted.state).toBe("interrupted");
      expect(interrupted.completedPage).toBe(1);
      expect((await call(page, "state")).activePdfWorkers).toBe(0);
      expect(
        (
          await call(
            page,
            "query",
            '"Quixi document fixture"',
            large.documentId,
          )
        ).items.some((hit) => hit.position.page === 1),
      ).toBe(true);
      expect(
        await request(page, "getPublishedExtractionPage", {
          runId: largeRun,
          page: 1,
        }),
      ).toEqual(firstRef);
      expect(await call(page, "source", large.sha256)).toEqual({
        sha256: large.sha256,
        byteLength: large.byteLength,
      });
      const afterCancel = await request(page, "diagnostics", null);
      expect(afterCancel.canonicalRecords).toBe(beforeCancel.canonicalRecords);
      expect(afterCancel.syncOperations).toBe(beforeCancel.syncOperations);
      host.checks.push(
        "cancellation terminates both parser workers, durably interrupts the run and preserves published page1, exact source bytes and canonical/sync state",
      );
      await save();

      await call(page, "start", large.documentId, false);
      host.resumed = await waitFor(
        page,
        (state) => state.outcome.state === "completed",
      );
      expect(host.resumed.outcome.result.state).toBe("completed");
      expect(host.resumed.outcome.result.completedPage).toBe(100);
      expect(host.resumed.parserStartPages).toEqual([1, 2]);
      expect(host.resumed.firstExtractingPage).toBe(2);
      expect(host.resumed.activePdfWorkers).toBe(0);
      expect(
        await request(page, "getPublishedExtractionPage", {
          runId: largeRun,
          page: 1,
        }),
      ).toEqual(firstRef);
      expect(
        await request(page, "readExtractedPageMap", {
          pageRef: firstRef,
          startUTF16: 0,
          endUTF16: text.totalUTF16,
          maxItems: 32,
          maxBytes: 16384,
          cursor: null,
        }),
      ).toEqual(firstMap);
      const lastRef = await request(page, "getPublishedExtractionPage", {
        runId: largeRun,
        page: 100,
      });
      expect(lastRef.page).toBe(100);
      const tail = await request(page, "readExtractedPageText", {
        pageRef: lastRef,
        startUTF16: 0,
        maxUTF16: 4096,
      });
      expect(tail.text).toContain("Quixi document fixture page 100");
      host.checks.push(
        "resume actually starts the parser at page2, preserves page1 reference/maps and completes all100 pages with indexed page100",
      );
      await save();

      small = await call(page, "seed", 1);
      const beforeSmall = await request(page, "diagnostics", null);
      await call(page, "dropStageReply");
      await call(page, "start", small.documentId, false);
      host.small = await waitFor(
        page,
        (state) => state.outcome.state === "completed",
      );
      expect(host.small.outcome.result.state).toBe("completed");
      expect(host.small.outcome.result.completedPage).toBe(1);
      expect(host.small.activePdfWorkers).toBe(0);
      host.droppedStage = await call(page, "droppedStage");
      expect(host.droppedStage.repliesSuppressed).toBe(1);
      expect(host.droppedStage.recoveryLookups).toBe(1);
      expect(host.droppedStage.stageDispatches).toBe(1);
      const recovered = await request(page, "getExtractionOperation", {
          operationId: host.droppedStage.operationId,
        }),
        global = await request(page, "operationStatus", {
          operationId: host.droppedStage.operationId,
        });
      expect(recovered.status).toBe("committed");
      expect(recovered.requestDigest).toBe(host.droppedStage.requestDigest);
      expect(global.status).toBe("committed");
      expect(global.result).toEqual(recovered.result);
      const afterSmall = await request(page, "diagnostics", null);
      expect(afterSmall.canonicalRecords).toBe(beforeSmall.canonicalRecords);
      expect(afterSmall.syncOperations).toBe(beforeSmall.syncOperations);
      expect(await call(page, "source", small.sha256)).toEqual({
        sha256: small.sha256,
        byteLength: small.byteLength,
      });
      await call(page, "close");
      host.checks.push(
        "a separate actual one-page PDF completes using the same released worker/source resources",
      );
      host.checks.push(
        "a real stage reply dropped inside persistPdfDocument resolves through one exact-digest receipt lookup and the original operation ID, without another stage dispatch or canonical/source changes",
      );
    } finally {
      await context.close();
    }
    context = await engine.launchPersistentContext(profile, { headless: true });
    observe();
    try {
      const page = await visit();
      await call(page, "open");
      const progress = await request(page, "getDocumentExtraction", {
        documentId: large.documentId,
      });
      expect(progress.state).toBe("completed");
      expect(progress.completedPage).toBe(100);
      const smallProgress = await request(page, "getDocumentExtraction", {
        documentId: small.documentId,
      });
      expect(smallProgress.state).toBe("completed");
      expect(
        await request(page, "getPublishedExtractionPage", {
          runId: largeRun,
          page: 1,
        }),
      ).toEqual(firstRef);
      expect(await call(page, "source", large.sha256)).toEqual({
        sha256: large.sha256,
        byteLength: large.byteLength,
      });
      expect(
        (
          await call(
            page,
            "query",
            '"Quixi document fixture"',
            small.documentId,
          )
        ).items.length,
      ).toBeGreaterThan(0);
      expect(
        (
          await request(page, "readMessageParts", {
            messageId: chatMessage.messageId,
            page: { cursor: null, maxItems: 8, maxBytes: 8192 },
          })
        ).items[0].data.text,
      ).toContain("Concurrent chat");
      expect((await request(page, "diagnostics", null)).integrity).toBe("ok");
      await call(page, "close");
      host.checks.push(
        "full browser-process restart preserves completed extraction/search, original PDF bytes and concurrent canonical chat",
      );
    } finally {
      await context.close();
    }
    expect(host.external).toEqual([]);
    expect(host.consoleErrors).toEqual([]);
    host.status = "passed";
    await save();
    console.log(
      `${name}: actual PDF persistence passed ${host.checks.length} checks`,
    );
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
