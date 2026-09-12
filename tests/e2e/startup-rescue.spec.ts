import { test, expect } from "./fixtures";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const CLEAR_TEMPORARY = "I checked the download — clear temporary copy";

test("an archive that cannot be opened is rescued byte-exactly from the startup outcome view", async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "Worker script interception is only deterministic in Chromium");
  test.setTimeout(180_000);
  // First run: a normal archive with one conversation.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByText("Conversation settings", { exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Rescue me");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rescue me", exact: true })).toBeVisible();
  await page.close();
  // Second run: deny creation of the blob directory inside the production
  // storage workers, so the owner worker fails after the database opened while
  // the archive itself stays intact and readable by the rescue worker.
  let injected = 0;
  await context.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (body.includes("installOpfsSAHPoolVfs")) {
      body = `{ const original = FileSystemDirectoryHandle.prototype.getDirectoryHandle; FileSystemDirectoryHandle.prototype.getDirectoryHandle = function (name, options) { if (name === 'blobs' && options && options.create) throw new DOMException('Storage denied by host', 'NotAllowedError'); return original.call(this, name, options); }; }\n${body}`;
      injected++;
    }
    await route.fulfill({ response, body, headers: { ...response.headers(), "cache-control": "no-store" } });
  });
  // Headless Chromium would block on the native save picker; the host falls
  // back to a browser download when the picker is absent, as the shared app
  // browser harness also arranges.
  await context.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });
  const failed = await context.newPage();
  await failed.goto("/");
  const outcome = failed.getByRole("alert");
  await expect(outcome).toBeVisible();
  expect(injected).toBeGreaterThan(0);
  await expect(failed.getByRole("button", { name: "New conversation", exact: true })).toHaveCount(0);
  // Read-only history through the retained reader, before any export.
  const history = failed.getByRole("region", { name: "Read-only history" });
  await history.getByRole("button", { name: "Show history", exact: true }).click();
  await history.getByRole("button", { name: "Rescue me", exact: true }).click();
  const conversation = history.getByRole("article", { name: "Read-only conversation" });
  await expect(conversation.getByRole("heading", { level: 3 })).toHaveText("Rescue me");
  await expect(conversation).toContainText("No messages in this conversation.");
  await expect(history.getByRole("alert")).toHaveCount(0);
  await conversation.getByRole("button", { name: "Close conversation", exact: true }).click();
  await expect(history.getByRole("button", { name: "Rescue me", exact: true })).toBeVisible();
  const recovery = failed.getByRole("region", { name: "Archive recovery export" });
  await expect(recovery).toBeVisible();
  await recovery.getByRole("button", { name: "Prepare rescue archive", exact: true }).click();
  const ready = recovery.getByRole("status").filter({ hasText: "Rescue archive ready" });
  await expect(ready).toBeVisible({ timeout: 30_000 });
  await expect(ready).toContainText("schema ledger");
  const sha256 = (await ready.locator("code").innerText()).trim();
  expect(sha256).toMatch(/^[a-f0-9]{64}$/);
  const downloading = failed.waitForEvent("download");
  await recovery.getByRole("button", { name: "Save rescue archive", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^quixi-rescue-\d{4}-\d{2}-\d{2}\.tar$/);
  const bytes = await readFile(await download.path());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  const extracted = testInfo.outputPath("rescue");
  await mkdir(extracted, { recursive: true });
  const tarPath = testInfo.outputPath("rescue.tar");
  await writeFile(tarPath, bytes);
  expect(execFileSync("tar", ["-tf", tarPath], { encoding: "utf8" }).trim().split("\n")).toEqual(["format.json", "quixi.sqlite", "checksums.jsonl", "manifest.json"]);
  execFileSync("tar", ["-xf", tarPath, "-C", extracted]);
  expect(JSON.parse(await readFile(`${extracted}/format.json`, "utf8"))).toEqual({ format: "quixi-archive", version: 1, kind: "rescue" });
  const database = await readFile(`${extracted}/quixi.sqlite`);
  expect(database.subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
  expect(database[15]).toBe(0);
  const manifest = JSON.parse(await readFile(`${extracted}/manifest.json`, "utf8"));
  expect(manifest.recovery.databaseBytes).toBe(database.length);
  expect(manifest.recovery.databaseSha256).toBe(createHash("sha256").update(database).digest("hex"));
  expect(manifest.recovery.ledgerCompatible).toBe(true);
  expect(manifest.recovery.ledger.length).toBe(manifest.recovery.buildMigrations);
  expect(database.toString("latin1")).toContain("Rescue me");
  await expect(recovery.getByRole("button", { name: CLEAR_TEMPORARY, exact: true })).toBeVisible();
  await recovery.getByRole("button", { name: CLEAR_TEMPORARY, exact: true }).click();
  await expect(recovery.getByRole("button", { name: CLEAR_TEMPORARY, exact: true })).toHaveCount(0);
  await expect(recovery.getByRole("alert")).toHaveCount(0);
  // Lifting the denial: the untouched archive opens with its conversation.
  await context.unroute("**/assets/*.js");
  await failed.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(failed.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
  await expect(failed.getByRole("button", { name: /Rescue me/ })).toBeVisible();
  await expect(failed.getByRole("alert")).toHaveCount(0);
});
