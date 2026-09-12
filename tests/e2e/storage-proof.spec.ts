import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { StorageProofClient } from "../../packages/storage/src/client/index.ts";

declare global { interface Window { quixiStorageProof?: StorageProofClient } }

async function open(page: Page, namespace: string): Promise<void> {
  await page.goto(`/storage-proof?namespace=${namespace}`);
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-state", "ready");
}

test("real OPFS persistence, FTS and vec0 through the rendered proof", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const wasmResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(".wasm"));
  await open(page, `persistence-${crypto.randomUUID()}`);
  const wasmHash = createHash("sha256").update(await (await wasmResponse).body()).digest("hex");
  const artifacts = JSON.parse(readFileSync(new URL("../../packages/storage/sqlite/artifacts.json", import.meta.url), "utf8"));
  expect(wasmHash).toBe(artifacts.artifacts["sqlite3.wasm"].sha256);
  const initial = await page.evaluate(() => window.quixiStorageProof!.request("diagnostics", undefined));
  expect(initial.sqliteVersion).toBe("3.53.4");
  expect(initial.vectorVersion).toBe("v0.1.9");
  expect(initial.integrity).toBe("ok");
  await page.getByLabel("Record ID", { exact: true }).fill("retained");
  await page.getByLabel("Text", { exact: true }).fill("Café migration proof beyond the browser reload.");
  await page.getByRole("button", { name: "Save record", exact: true }).click();
  await expect(page.getByTestId("probe-result")).toContainText('"id": "retained"');
  await page.reload();
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-state", "ready");
  await page.getByLabel("Search text").fill("cafe");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByTestId("results")).toContainText("retained");
  const vector = await page.evaluate(() => window.quixiStorageProof!.request("vectorProbe", undefined));
  expect(vector.nearestId).toBe(1);
  expect(vector.distance).toBeCloseTo(Math.sqrt(0.02), 5);
  expect(errors).toEqual([]);
  await testInfo.attach("storage-diagnostics", { body: JSON.stringify(initial, null, 2), contentType: "application/json" });
  const environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent, origin: location.origin, secureContext: isSecureContext,
    crossOriginIsolated, webLocks: !!navigator.locks, opfs: !!navigator.storage?.getDirectory,
  }));
  await testInfo.attach("host-environment", { body: JSON.stringify({ ...environment, sqliteWasmSha256: wasmHash }, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("storage-proof.png"), fullPage: true });
});

test("committed history survives browser process restart", async ({ page, context, playwright, browserName, baseURL, storageProfile }) => {
  const namespace = `restart-${crypto.randomUUID()}`;
  await open(page, namespace);
  await page.evaluate(() => window.quixiStorageProof!.request("put", { id: "restart", text: "Retained across browser processes" }));
  await context.close();
  const reopened = await playwright[browserName].launchPersistentContext(storageProfile, {
    ...(baseURL ? { baseURL } : {}),
  });
  try {
    const nextPage = await reopened.newPage();
    await open(nextPage, namespace);
    const result = await nextPage.evaluate(async () => ({
      rows: await window.quixiStorageProof!.request("search", { query: "retained" }),
      diagnostics: await window.quixiStorageProof!.request("diagnostics", undefined),
    }));
    expect(result.rows).toEqual([{ id: "restart", text: "Retained across browser processes", updatedAt: expect.any(Number) }]);
    expect(result.diagnostics.operationCount).toBe(1);
    expect(result.diagnostics.integrity).toBe("ok");
  } finally { await reopened.close(); }
});

test("record and operation rollback, migration rollback, repeatable SQLITE_FULL", async ({ page }) => {
  await open(page, `rollback-${crypto.randomUUID()}`);
  const result = await page.evaluate(async () => {
    const client = window.quixiStorageProof!;
    await client.request("put", { id: "kept", text: "Committed before failures" });
    const before = await client.request("diagnostics", undefined);
    const rollback = await client.request("rollbackProbe", undefined);
    const migration = await client.request("migrationProbe", undefined);
    const full1 = await client.request("fullProbe", undefined);
    const full2 = await client.request("fullProbe", undefined);
    const after = await client.request("diagnostics", undefined);
    await client.request("put", { id: "after", text: "Writes still work" });
    return { before, rollback, migration, full1, full2, after };
  });
  expect(result.rollback.rolledBack).toBe(true);
  expect(result.migration.rolledBack).toBe(true);
  expect(result.full1).toEqual({ rejected: true, integrity: "ok" });
  expect(result.full2).toEqual(result.full1);
  expect(result.after.recordCount).toBe(result.before.recordCount);
  expect(result.after.operationCount).toBe(result.before.operationCount);
  expect(result.after.schemaVersion).toBe(1);
});

test("one owner across tabs, forwarded writes, graceful handoff", async ({ page, context }) => {
  const namespace = `handoff-${crypto.randomUUID()}`;
  await open(page, namespace);
  const follower = await context.newPage();
  await open(follower, namespace);
  const ownerBefore = await page.evaluate(() => window.quixiStorageProof!.request("diagnostics", undefined));
  const followerBefore = await follower.evaluate(() => window.quixiStorageProof!.request("diagnostics", undefined));
  expect(followerBefore.ownerId).toBe(ownerBefore.ownerId);
  await follower.evaluate(() => window.quixiStorageProof!.request("put", { id: "forwarded", text: "Other tab committed" }));
  await expect.poll(() => page.evaluate(async () => (await window.quixiStorageProof!.request("list", {})).length)).toBe(1);
  const invalidProbe = await follower.evaluate(async () => {
    try { await window.quixiStorageProof!.request("beginInterruptedWrite", { id: "bad-forward" }); }
    catch (error) { return (error as { code: string }).code; }
  });
  expect(invalidProbe).toBe("INVALID_REQUEST");
  await page.evaluate(() => window.quixiStorageProof!.close());
  const ownerAfter = await follower.evaluate(() => window.quixiStorageProof!.request("diagnostics", undefined));
  expect(ownerAfter.ownerId).not.toBe(ownerBefore.ownerId);
  expect(ownerAfter.recordCount).toBe(1);
  await follower.evaluate(() => window.quixiStorageProof!.request("put", { id: "after-handoff", text: "New owner works" }));
});

test("owner death rolls back an uncommitted transaction and permits takeover", async ({ page, context }) => {
  const namespace = `crash-${crypto.randomUUID()}`;
  await open(page, namespace);
  await page.evaluate(() => window.quixiStorageProof!.request("put", { id: "committed", text: "Survives crash" }));
  const follower = await context.newPage();
  await open(follower, namespace);
  await page.evaluate(async () => {
    await window.quixiStorageProof!.request("beginInterruptedWrite", { id: "interrupted" });
    window.quixiStorageProof!.terminate();
  });
  await expect.poll(async () => {
    try { return await follower.evaluate(() => window.quixiStorageProof!.request("list", {})); }
    catch { return null; }
  }).toEqual([{ id: "committed", text: "Survives crash", updatedAt: expect.any(Number) }]);
  const diagnostics = await follower.evaluate(() => window.quixiStorageProof!.request("diagnostics", undefined));
  expect(diagnostics.integrity).toBe("ok");
});

test("bounded requests, pagination, and FTS update/removal", async ({ page }) => {
  await open(page, `bounds-${crypto.randomUUID()}`);
  const result = await page.evaluate(async () => {
    const client = window.quixiStorageProof!;
    let oversize: string | undefined;
    try { await client.request("put", { id: "oversize", text: "x".repeat(65_537) }); }
    catch (error) { oversize = (error as { code: string }).code; }
    const flooded = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => client.request("put", { id: String(i).padStart(3, "0"), text: `record ${i}` })));
    const overflow = flooded.filter(r => r.status === "rejected" && r.reason.code === "OVERLOADED").length;
    const first = await client.request("list", { limit: 2 });
    const next = await client.request("list", { limit: 2, afterId: first.at(-1)!.id });
    await client.request("put", { id: "replace", text: "oldterm" });
    await client.request("put", { id: "replace", text: "newterm" });
    const old = await client.request("search", { query: "oldterm" });
    const updated = await client.request("search", { query: "newterm" });
    await client.request("remove", { id: "replace" });
    const removed = await client.request("search", { query: "newterm" });
    return { oversize, overflow, first, next, old, updated, removed };
  });
  expect(result.oversize).toBe("INVALID_REQUEST");
  expect(result.overflow).toBeGreaterThan(0);
  expect(result.first).toHaveLength(2);
  expect(result.next).toHaveLength(2);
  expect(result.next[0]!.id > result.first[1]!.id).toBe(true);
  expect(result.old).toEqual([]);
  expect(result.updated).toHaveLength(1);
  expect(result.removed).toEqual([]);
});
