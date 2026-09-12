import { test, expect } from "./fixtures.ts";
import type { StorageProofClient } from "../../packages/storage/src/client/index.ts";

declare global { interface Window { quixiStorageProof?: StorageProofClient } }

test("browser OPFS quota exhaustion preserves committed history after quota restoration and reopen", async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "Actual quota override uses Chromium CDP; no equivalent WebKit control is available.");
  const namespace = `quota-${crypto.randomUUID()}`;
  const consoleErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`/storage-proof?namespace=${namespace}`);
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => window.quixiStorageProof!.request("put", { id: "sentinel", text: "Committed archive sentinel before browser quota failure" }));
  const initial = await page.evaluate(() => window.quixiStorageProof!.request("diagnostics", undefined));
  const origin = new URL(page.url()).origin;
  const session = await context.newCDPSession(page);
  const beforeQuota = await session.send("Storage.getUsageAndQuota", { origin });
  // At most 64 * 64 KiB of input; quota stays below 16 MiB including
  // Chromium's initial per-SAH reservation for the six-file pool.
  // SQLite's own max_page_count remains unchanged throughout this test.
  const quotaSize = Math.ceil(beforeQuota.usage) + 512 * 1024;
  expect(quotaSize).toBeLessThan(16 * 1024 * 1024);
  const worker = page.workers()[0]!;
  expect(worker).toBeTruthy();
  await worker.evaluate(() => {
    const scope = globalThis as unknown as { FileSystemSyncAccessHandle: { prototype: Record<string, (...args: unknown[]) => unknown> }; quotaWriteFailures?: { name: string; message: string; operation: string }[] };
    scope.quotaWriteFailures = [];
    for (const operation of ["write", "truncate"]) {
      const original = scope.FileSystemSyncAccessHandle.prototype[operation]!;
      scope.FileSystemSyncAccessHandle.prototype[operation] = function (...args: unknown[]) {
        try { return original.apply(this, args); }
        catch (error) {
          const exception = error as Error;
          scope.quotaWriteFailures!.push({ name: exception.name, message: exception.message, operation });
          throw error;
        }
      };
    }
  });
  let override: unknown;
  let pressure: { committed: string[]; failedId: string | null; error: { code: string; message: string } | null } | undefined;
  let lowQuota: unknown;
  let writeFailures: unknown;
  try {
    await session.send("Storage.overrideQuotaForOrigin", { origin, quotaSize });
    override = await session.send("Storage.getUsageAndQuota", { origin });
    expect(override).toMatchObject({ overrideActive: true, quota: quotaSize });
    pressure = await page.evaluate(async () => {
      const committed: string[] = [];
      const text = "quixi bounded browser quota record ".repeat(1900).slice(0, 65_536);
      for (let index = 0; index < 64; ++index) {
        const id = `pressure-${String(index).padStart(3, "0")}`;
        try { await window.quixiStorageProof!.request("put", { id, text }); committed.push(id); }
        catch (error) {
          const storageError = error as { code: string; message: string };
          return { committed, failedId: id, error: { code: storageError.code, message: storageError.message } };
        }
      }
      return { committed, failedId: null, error: null };
    });
    lowQuota = await session.send("Storage.getUsageAndQuota", { origin });
    writeFailures = await worker.evaluate(() => (globalThis as unknown as { quotaWriteFailures: unknown[] }).quotaWriteFailures);
  } finally {
    // CDP documents omission of quotaSize as restoring this origin's default.
    await session.send("Storage.overrideQuotaForOrigin", { origin });
  }
  const restoredQuota = await session.send("Storage.getUsageAndQuota", { origin });
  await page.evaluate(() => window.quixiStorageProof!.close());
  await page.reload();
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-state", "ready");
  const recovered = await page.evaluate(async () => ({
    diagnostics: await window.quixiStorageProof!.request("diagnostics", undefined),
    records: await window.quixiStorageProof!.request("list", { limit: 100 }),
    sentinel: await window.quixiStorageProof!.request("search", { query: "sentinel" }),
    pressureFTS: await window.quixiStorageProof!.request("search", { query: "quixi", limit: 100 }),
  }));
  const evidence = {
    origin, browserVersion: context.browser()?.version(), initial, beforeQuota, quotaSize, override, pressure, lowQuota,
    writeFailures, restoredQuota, recovered: {
      diagnostics: recovered.diagnostics,
      records: recovered.records.map(({id, text, updatedAt}) => ({id, textLength: text.length, updatedAt})),
      sentinel: recovered.sentinel, pressureFTS: recovered.pressureFTS.map(record => record.id),
    }, consoleErrors,
  };
  await testInfo.attach("browser-quota-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  expect(pressure?.failedId, "Bounded writes must actually hit the browser quota").toBeTruthy();
  expect(writeFailures).toEqual(expect.arrayContaining([expect.objectContaining({ name: "QuotaExceededError" })]));
  expect(restoredQuota.overrideActive).toBe(false);
  expect(recovered.diagnostics.integrity).toBe("ok");
  const expectedIds = ["sentinel", ...pressure!.committed].sort();
  expect(recovered.records.map(record => record.id)).toEqual(expectedIds);
  expect(recovered.diagnostics.recordCount).toBe(expectedIds.length);
  expect(recovered.diagnostics.operationCount).toBe(expectedIds.length);
  expect(recovered.sentinel).toHaveLength(1);
  expect(recovered.sentinel[0]!.text).toBe("Committed archive sentinel before browser quota failure");
  const expectedText = "quixi bounded browser quota record ".repeat(1900).slice(0, 65_536);
  for (const record of recovered.records.filter(record => record.id !== "sentinel")) expect(record.text).toBe(expectedText);
  expect(recovered.pressureFTS.map(record => record.id).sort()).toEqual(pressure!.committed);
  await page.evaluate(() => window.quixiStorageProof!.request("put", { id: "after-recovery", text: "Writes resume after restoring real browser quota" }));
  expect((await page.evaluate(() => window.quixiStorageProof!.request("diagnostics", undefined))).integrity).toBe("ok");
  await session.detach();
});
