import { chromium, webkit, expect } from "@playwright/test";
import { browserEngines } from "../../../../tooling/browser-engines.mjs";
import { build, preview } from "vite";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir, platform, release, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
const engines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, "../../../.."),
  temporary = await mkdtemp(resolve(tmpdir(), "quixi-extraction-browser-"));
const output = resolve(root, "test-results/extraction-client-browser.json");
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
const invoke = (page, method, ...args) =>
  page.evaluate(
    async ({ method, args }) => {
      try {
        return {
          ok: true,
          result: await window.extractionTest[method](...args),
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error?.code,
            message: String(error),
            detail: error?.detail,
          },
        };
      }
    },
    { method, args },
  );
const call = async (...args) => {
  const value = await invoke(...args);
  if (!value.ok) throw new Error(JSON.stringify(value.error));
  return value.result;
};
const rejected = async (page, method, args, code) => {
  const value = await invoke(page, method, ...args);
  expect(value.ok).toBe(false);
  if (code) expect(value.error.code).toBe(code);
  return value.error;
};
const request = (page, operation, args, drop = false) =>
  call(page, "request", operation, args, drop);
const identityOperation = () => randomUUID();
let server;
try {
  const outDir = resolve(temporary, "dist");
  const sources = [
    "tooling/browser-engines.mjs",
    "packages/storage/src/client/archive.ts",
    "packages/storage/src/archive-protocol.ts",
    "packages/storage/src/worker/archive.ts",
    "packages/storage/src/worker/archive-runtime.ts",
    "packages/storage/src/worker/archive-database.ts",
    "packages/storage/src/worker/operation-claims.ts",
    "packages/storage/src/worker/archive-operation-fences.ts",
    "packages/storage/src/worker/extraction/index.ts",
    "packages/storage/src/worker/extraction/schema.ts",
    "packages/storage/src/worker/search/index.ts",
    "packages/storage/src/worker/search/schema.ts",
    "packages/storage/src/worker/search/sources.ts",
    "packages/storage/src/worker/search/extraction.ts",
    "packages/storage/src/worker/blob-catalog.ts",
    "packages/storage/src/worker/blobs.ts",
    "packages/storage/migrations/index.ts",
    "packages/core/src/contracts/extraction.ts",
    "packages/core/src/contracts/storage.ts",
    "packages/storage/tests/extraction-browser/index.ts",
    "packages/storage/tests/extraction-browser/run.mjs",
    "packages/documents/tests/fixtures/pages-100.pdf",
    "packages/storage/sqlite/dist/sqlite3.wasm",
  ];
  for (const file of sources)
    report.sourceSha256[file] = createHash("sha256")
      .update(await readFile(resolve(root, file)))
      .digest("hex");
  await build({
    configFile: false,
    root: import.meta.dirname,
    logLevel: "warn",
    build: { outDir, emptyOutDir: true },
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
  const baseURL = `http://127.0.0.1:${address.port}`;
  report.origin = baseURL;
  for (const [name, engine] of engines) {
    const host = { name, status: "running", checks: [] };
    report.hosts.push(host);
    await save();
    const profile = resolve(temporary, name);
    let context = await engine.launchPersistentContext(profile, {
      headless: true,
    });
    const visit = async () => {
      const page = await context.newPage();
      await page.goto(baseURL);
      await page.waitForFunction(() => !!window.extractionTest);
      return page;
    };
    let fixture,
      run,
      first,
      second,
      publish1,
      receipt1,
      stage2,
      receipt2,
      third,
      stage3,
      thirdReceipt,
      afterTakeover;
    try {
      const owner = await visit(),
        follower = await visit();
      host.userAgent = await owner.evaluate(() => navigator.userAgent);
      const initial = await owner.evaluate(async () => {
        const names = [];
        for await (const item of (
          await navigator.storage.getDirectory()
        ).values())
          names.push(item.name);
        return names.sort();
      });
      expect(initial).toEqual([]);
      host.initialOpfs = initial;
      const ownerState = await call(owner, "open"),
        followerState = await call(follower, "open");
      expect(followerState.ownerId).toBe(ownerState.ownerId);
      expect(ownerState.schemaVersion).toBe(13);
      fixture = await call(follower, "seed");
      host.original = await call(owner, "original", fixture.identity);
      expect(host.original.sha256).toBe(fixture.identity.attachmentSha256);
      expect(host.original.byteLength).toBe(
        fixture.identity.attachmentByteLength,
      );
      host.allocationLoss = await call(
        follower,
        "allocationLoss",
        fixture.identity,
      );
      host.checks.push(
        "twenty real lost read/slice creation replies release by known request ID; eight fresh reader slots and seven child slots plus parent remain available",
      );
      await save();
      const beginArgs = {
        operationId: identityOperation(),
        identity: fixture.identity,
      };
      run = await request(follower, "beginDocumentExtraction", beginArgs);
      expect(
        await request(owner, "beginDocumentExtraction", beginArgs),
      ).toEqual(run);
      expect(
        (
          await request(owner, "operationStatus", {
            operationId: beginArgs.operationId,
          })
        ).result,
      ).toEqual(run);
      host.checks.push(
        "two actual managed clients share the OPFS owner; verified original PDF and canonical Document/Attachment support a durable extraction run",
      );
      await save();

      first = {
        runId: run.runId,
        writerEpoch: run.writerEpoch,
        ...(await request(follower, "beginExtractionPage", {
          operationId: identityOperation(),
          runId: run.runId,
          writerEpoch: run.writerEpoch,
          page: 1,
          documentPageCount: 100,
        })),
      };
      const write1 = {
          runId: run.runId,
          writerEpoch: run.writerEpoch,
          pageAttemptId: first.pageAttemptId,
        },
        fragments1 = ["A silver ", "fox café 🧪\0 crosses staging fragments."];
      const stage1 = await call(follower, "stageArgs", write1, fragments1[0]);
      host.lostStage = await rejected(
        follower,
        "request",
        ["stagePageText", stage1, true],
        "UNKNOWN_OUTCOME",
      );
      expect(host.lostStage.detail.operationId).toBe(stage1.operationId);
      expect(await call(follower, "dropped")).toBe(21);
      const stageStatus = await request(owner, "getExtractionOperation", {
        operationId: stage1.operationId,
      });
      expect(stageStatus.status).toBe("committed");
      expect(await request(follower, "stagePageText", stage1)).toEqual(
        stageStatus.result,
      );
      await rejected(
        follower,
        "request",
        ["stagePageText", { ...stage1, text: "B silver " }],
        "CONFLICT",
      );
      expect((await call(owner, "query", "silver")).items).toEqual([]);
      await request(
        follower,
        "stagePageText",
        await call(
          follower,
          "stageArgs",
          write1,
          fragments1[1],
          1,
          fragments1[0].length,
        ),
      );
      publish1 = await call(follower, "publishArgs", write1, fragments1);
      host.lostPublication = await rejected(
        follower,
        "request",
        ["publishExtractionPage", publish1, true],
        "UNKNOWN_OUTCOME",
      );
      expect(host.lostPublication.detail.operationId).toBe(
        publish1.operationId,
      );
      expect(await call(follower, "dropped")).toBe(22);
      const committed1 = await request(owner, "operationStatus", {
        operationId: publish1.operationId,
      });
      expect(committed1.status).toBe("committed");
      receipt1 = committed1.result;
      expect(
        await request(follower, "publishExtractionPage", publish1),
      ).toEqual(receipt1);
      await call(follower, "indexed", receipt1.pageRef);
      const firstHits = (await call(owner, "query", '"silver fox"')).items;
      expect(firstHits.length).toBe(1);
      expect(firstHits[0].position.page).toBe(1);
      expect(
        (
          await request(owner, "readExtractedPageText", {
            pageRef: receipt1.pageRef,
            startUTF16: 0,
            maxUTF16: 4096,
          })
        ).text,
      ).toBe(fragments1.join(""));
      const map = await request(owner, "readExtractedPageMap", {
        pageRef: receipt1.pageRef,
        startUTF16: 0,
        endUTF16: fragments1.join("").length,
        maxItems: 8,
        maxBytes: 8192,
        cursor: null,
      });
      expect(map.items.length).toBe(2);
      expect(map.items[0].end).toBe(map.items[1].start);
      expect(map.nextCursor).toBeNull();
      host.checks.push(
        "actual lost stage/publication replies reconcile by stable operation IDs; changed replay rejects; unsealed page is invisible; complete page has continuous phrase/NUL/Unicode text and bounded source maps",
      );
      await save();

      second = await request(follower, "beginExtractionPage", {
        operationId: identityOperation(),
        runId: run.runId,
        writerEpoch: run.writerEpoch,
        page: 2,
        documentPageCount: 100,
      });
      const write2 = {
          runId: run.runId,
          writerEpoch: run.writerEpoch,
          pageAttemptId: second.pageAttemptId,
        },
        text2 = "pendingamber only appears when this second page publishes";
      stage2 = await call(follower, "stageArgs", write2, text2);
      await request(follower, "stagePageText", stage2);
      expect((await call(owner, "query", "pendingamber")).items).toEqual([]);
      expect(
        (await call(owner, "query", '"silver fox"')).items[0].chunkId,
      ).toBe(firstHits[0].chunkId);
      receipt2 = await request(
        follower,
        "publishExtractionPage",
        await call(follower, "publishArgs", write2, [text2]),
      );
      await call(follower, "indexed", receipt2.pageRef);
      expect(
        (await call(owner, "query", "pendingamber")).items[0].position.page,
      ).toBe(2);
      expect(
        (await call(owner, "query", '"silver fox"')).items[0].chunkId,
      ).toBe(firstHits[0].chunkId);
      host.checks.push(
        "page 1 remains searchable with the same shared chunk identity while page2 is paused/staged and after independent page2 publication",
      );
      await save();

      await rejected(
        follower,
        "request",
        [
          "beginDocumentExtraction",
          {
            operationId: fixture.canonicalOperationIds[0],
            identity: fixture.identity,
          },
        ],
        "CONFLICT",
      );
      await rejected(
        follower,
        "request",
        [
          "beginDocumentExtraction",
          { operationId: fixture.blobOperationId, identity: fixture.identity },
        ],
        "CONFLICT",
      );
      await rejected(
        follower,
        "collision",
        [stage2.operationId, fixture.identity.documentId],
        "CONFLICT",
      );
      expect(
        (
          await request(owner, "operationStatus", {
            operationId: stage2.operationId,
          })
        ).result,
      ).toEqual(await request(owner, "stagePageText", stage2));
      const document = await request(owner, "readEntity", {
        collection: "documents",
        id: fixture.identity.documentId,
      });
      expect(document.title).toBe("Public PDF persistence fixture");
      host.checks.push(
        "canonical/blob/extraction operation identities are globally fenced and rejected cross-domain attempts retain original receipts and canonical title",
      );
      await save();

      third = await request(follower, "beginExtractionPage", {
        operationId: identityOperation(),
        runId: run.runId,
        writerEpoch: run.writerEpoch,
        page: 3,
        documentPageCount: 100,
      });
      stage3 = await call(
        follower,
        "stageArgs",
        {
          runId: run.runId,
          writerEpoch: run.writerEpoch,
          pageAttemptId: third.pageAttemptId,
        },
        "restartpending third page text",
      );
      thirdReceipt = await request(follower, "stagePageText", stage3);
      await owner.close();
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await invoke(follower, "diagnostics");
        if (result.ok && result.result.ownerId !== ownerState.ownerId) {
          afterTakeover = result.result;
          break;
        }
        if (!result.ok && result.error.code !== "UNKNOWN_OUTCOME")
          throw new Error(JSON.stringify(result.error));
        await follower.waitForTimeout(100);
      }
      expect(afterTakeover).toBeTruthy();
      const progress = await request(follower, "getDocumentExtraction", {
        documentId: fixture.identity.documentId,
      });
      expect(progress.completedPage).toBe(2);
      expect(progress.currentPage.pageAttemptId).toBe(third.pageAttemptId);
      expect(progress.writerEpoch).toBe(run.writerEpoch);
      expect(await request(follower, "stagePageText", stage3)).toEqual(
        thirdReceipt,
      );
      expect(
        (
          await request(follower, "operationStatus", {
            operationId: publish1.operationId,
          })
        ).result,
      ).toEqual(receipt1);
      expect((await call(follower, "query", "restartpending")).items).toEqual(
        [],
      );
      const diag = await call(follower, "diagnostics");
      expect(diag.canonicalRecords).toBe(fixture.diagnostics.canonicalRecords);
      expect(diag.syncOperations).toBe(fixture.diagnostics.syncOperations);
      host.checks.push(
        "abrupt real owner-tab loss preserves completed pages and exact staged checkpoint/receipt without inventing producer interruption or canonical/sync writes",
      );
      await call(follower, "close");
    } finally {
      await context.close();
    }
    context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await visit();
      await call(page, "open");
      expect(
        (
          await request(page, "operationStatus", {
            operationId: publish1.operationId,
          })
        ).result,
      ).toEqual(receipt1);
      expect(await request(page, "stagePageText", stage3)).toEqual(
        thirdReceipt,
      );
      const progress = await request(page, "getDocumentExtraction", {
        documentId: fixture.identity.documentId,
      });
      expect(progress.completedPage).toBe(2);
      expect(progress.currentPage.pageAttemptId).toBe(third.pageAttemptId);
      expect(
        (
          await request(page, "readExtractedPageText", {
            pageRef: receipt1.pageRef,
            startUTF16: 0,
            maxUTF16: 4096,
          })
        ).text,
      ).toBe("A silver fox café 🧪\0 crosses staging fragments.");
      const retainedMap = await request(page, "readExtractedPageMap", {
        pageRef: receipt1.pageRef,
        startUTF16: 0,
        endUTF16: "A silver fox café 🧪\0 crosses staging fragments.".length,
        maxItems: 8,
        maxBytes: 8192,
        cursor: null,
      });
      expect(retainedMap.items.length).toBe(2);
      expect((await call(page, "query", '"silver fox"')).items.length).toBe(1);
      expect((await call(page, "query", "pendingamber")).items.length).toBe(1);
      const original = await call(page, "original", fixture.identity);
      expect(original.sha256).toBe(fixture.identity.attachmentSha256);
      expect(original.byteLength).toBe(fixture.identity.attachmentByteLength);
      await request(page, "interruptDocumentExtraction", {
        operationId: identityOperation(),
        runId: run.runId,
        writerEpoch: run.writerEpoch,
        reason: "user_cancelled",
      });
      const resumed = await request(page, "resumeDocumentExtraction", {
        operationId: identityOperation(),
        runId: run.runId,
        expectedWriterEpoch: run.writerEpoch,
      });
      expect(resumed.writerEpoch).toBe(run.writerEpoch + 1);
      await rejected(
        page,
        "request",
        ["stagePageText", { ...stage3, operationId: identityOperation() }],
        "CONFLICT",
      );
      const diag = await call(page, "diagnostics");
      expect(diag.integrity).toBe("ok");
      expect(diag.canonicalRecords).toBe(fixture.diagnostics.canonicalRecords);
      expect(diag.syncOperations).toBe(fixture.diagnostics.syncOperations);
      await call(page, "close");
      host.checks.push(
        "complete browser-process restart preserves global receipts, text/search/checkpoints and exact original bytes; explicit interrupt/resume rotates writer epoch and fences old writes",
      );
    } finally {
      await context.close();
    }
    host.status = "passed";
    await save();
    console.log(
      `${name}: public extraction passed ${host.checks.length} checks`,
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
