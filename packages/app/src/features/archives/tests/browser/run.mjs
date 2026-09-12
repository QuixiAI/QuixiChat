import { browserEngines } from "../../../../../../../tooling/browser-engines.mjs";
import { chromium, webkit, expect } from "@playwright/test";
import { build, preview } from "vite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, platform, release, arch } from "node:os";
import { resolve } from "node:path";
const selected = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, "../../../../../../../");
const resultDir = resolve(import.meta.dirname, "results");
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-restore-ui-"));
const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  selectedEngines: selected.map(([name]) => name),
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
  },
  sourceSha256: {},
  hosts: [],
  qualification:
    "Actual production web main/shared UI, managed selection client and OPFS; optional showSaveFilePicker disabled to select the production browser-download path. No provider requests.",
};
const sourceFiles = [
  "package-lock.json",
  "apps/web/src/main.ts",
  "apps/web/src/host/index.ts",
  "packages/app/src/AppRoot.tsx",
  "packages/app/src/styles.css",
  "apps/web/src/host/transfers.ts",
  "packages/core/src/contracts/transfer.ts",
  "packages/app/src/runtime/library.ts",
  "packages/app/src/features/archives/index.ts",
  "packages/app/src/features/archives/restore-controller.ts",
  "packages/app/src/features/archives/RestorePanel.tsx",
  "packages/app/src/features/archives/ExportPanel.tsx",
  "packages/app/src/features/archives/controller.ts",
  "packages/storage/src/client/selection.ts",
  "packages/storage/src/worker/selection.ts",
  "packages/storage/src/worker/archive-database.ts",
  "packages/app/src/features/archives/tests/browser/index.ts",
  "packages/app/src/features/archives/tests/browser/run.mjs",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = async () => {
  await mkdir(resultDir, { recursive: true });
  await writeFile(
    resolve(resultDir, "restore-ui-browser.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
};
const button = (page, name) => page.getByRole("button", { name, exact: true });
const snapshot = (page) =>
  page.evaluate(() => window.restoreAcceptance.snapshot());
const selection = (page) =>
  page.evaluate(() => window.restoreAcceptance.selection());
async function rename(page, title) {
  await page.getByText("Conversation settings", { exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await button(page, "Rename").click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}
async function library(page) {
  await button(page, "Library").click();
}
async function exports(page) {
  await button(page, "Export history").click();
  await expect(
    page.getByRole("heading", { name: "Restore a Quixi archive", exact: true }),
  ).toBeVisible();
}
let server;
try {
  for (const file of sourceFiles)
    report.sourceSha256[file] = hash(await readFile(resolve(root, file)));
  const outDir = resolve(temporary, "dist");
  await build({
    configFile: false,
    root: import.meta.dirname,
    build: { outDir, emptyOutDir: true, target: "esnext" },
    logLevel: "warn",
  });
  server = await preview({
    configFile: false,
    root: import.meta.dirname,
    build: { outDir },
    preview: {
      host: "127.0.0.1",
      port: 0,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    logLevel: "warn",
  });
  const port = server.httpServer.address().port,
    url = `http://127.0.0.1:${port}/`;
  report.origin = url;
  for (const [name, engine] of selected) {
    const evidence = {
      name,
      status: "running",
      checks: [],
      externalRequests: [],
      pageErrors: [],
    };
    report.hosts.push(evidence);
    await save();
    const profile = resolve(temporary, name);
    let context = await engine.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1280, height: 960 },
      acceptDownloads: true,
    });
    let page;
    const observe = (page) => {
      page.on("pageerror", (error) => evidence.pageErrors.push(String(error)));
      page.on("request", (request) => {
        if (!request.url().startsWith(url) && /^https?:/.test(request.url()))
          evidence.externalRequests.push(request.url());
      });
    };
    try {
      page = await context.newPage();
      observe(page);
      await page.goto(url);
      await expect(
        page.getByRole("heading", { name: "Pick up where you left off." }),
      ).toBeVisible({ timeout: 30000 });
      await button(page, "New conversation").click();
      await rename(page, "Before export notebook");
      evidence.raw = await page.evaluate(() =>
        window.restoreAcceptance.seedRaw(),
      );
      const before = await snapshot(page);
      evidence.originalSelection = before.selection;
      evidence.sourceCounts = {
        threads: before.threads.items.length,
        messages: before.messages.items.length,
        parts: before.parts.items.length,
        rawObjects: before.raw.items.length,
        syncOperations: before.sync.items.length,
      };
      evidence.schemaVersion = before.diagnostics.schemaVersion;
      await exports(page);
      await button(page, "Prepare Quixi archive").click();
      await expect(button(page, "Save prepared export")).toBeVisible({
        timeout: 30000,
      });
      const downloading = page.waitForEvent("download");
      await button(page, "Save prepared export").click();
      const download = await downloading;
      const saved = resolve(temporary, `${name}-portable.tar`);
      await download.saveAs(saved);
      const bytes = await readFile(saved);
      evidence.export = {
        name: download.suggestedFilename(),
        byteLength: bytes.length,
        sha256: hash(bytes),
      };
      expect(bytes.length).toBeGreaterThan(evidence.raw.byteLength);
      await button(
        page,
        "I checked the download — clear temporary copy",
      ).click();
      expect((await snapshot(page)).sync).toEqual(before.sync);
      evidence.checks.push(
        "Real shared export UI downloads a portable TAR with original synthetic bytes; explicit temporary cleanup leaves source canonical history unchanged",
      );
      await library(page);
      await rename(page, "After export notebook");
      const changed = await snapshot(page);
      await page
        .getByLabel("Message", { exact: true })
        .fill("Unsaved draft blocks restore review");
      await exports(page);
      const choosing = page.waitForEvent("filechooser");
      await button(page, "Choose portable archive").click();
      await (await choosing).setFiles(saved);
      await expect(
        page.getByRole("heading", { name: "Validated candidate", exact: true }),
      ).toBeVisible({ timeout: 60000 });
      expect(await selection(page)).toEqual(before.selection);
      expect((await snapshot(page)).sync).toEqual(changed.sync);
      await button(page, "Prepare replacement review").click();
      await expect(page.getByRole("alert")).toContainText(/unsent message/i);
      expect(await selection(page)).toEqual(before.selection);
      await library(page);
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
        "Unsaved draft blocks restore review",
      );
      await page.getByLabel("Message", { exact: true }).fill("");
      await exports(page);
      await button(page, "Prepare replacement review").click();
      await expect(
        page.getByRole("heading", { name: "Review replacement", exact: true }),
      ).toBeVisible();
      expect(await selection(page)).toEqual(before.selection);
      const readyJobs = await page.evaluate(() =>
        window.restoreAcceptance.jobs(),
      );
      const readyJob = readyJobs.items.find(
        (job) => job.kind === "restore" && job.state === "ready",
      );
      expect(readyJob).toBeTruthy();
      evidence.resumedJob = {
        jobId: readyJob.jobId,
        candidateArchiveId: readyJob.candidate.archiveId,
      };
      await page.reload();
      await expect(button(page, /After export notebook/)).toBeVisible({
        timeout: 30000,
      });
      await button(page, /After export notebook/).click();
      await exports(page);
      await expect(button(page, "Review saved restore")).toBeVisible({
        timeout: 30000,
      });
      await expect(
        button(page, "I reviewed this candidate — replace active archive"),
      ).toHaveCount(0);
      expect(await selection(page)).toEqual(before.selection);
      await button(page, "Review saved restore").click();
      await expect(
        page.getByRole("heading", { name: "Validated candidate", exact: true }),
      ).toBeVisible();
      await expect(
        button(page, "I reviewed this candidate — replace active archive"),
      ).toHaveCount(0);
      expect(await selection(page)).toEqual(before.selection);
      expect((await snapshot(page)).sync).toEqual(changed.sync);
      const resumedJobs = await page.evaluate(() =>
        window.restoreAcceptance.jobs(),
      );
      expect(
        resumedJobs.items.find((job) => job.jobId === readyJob.jobId).candidate,
      ).toEqual(readyJob.candidate);
      await button(page, "Prepare replacement review").click();
      await expect(
        page.getByRole("heading", { name: "Review replacement", exact: true }),
      ).toBeVisible();
      expect(await selection(page)).toEqual(before.selection);
      evidence.checks.push(
        "Reload discovers the same ready restore job; Review saved restore resumes its validated candidate and requires a fresh explicit review without implicit activation or canonical changes",
      );
      await library(page);
      await page
        .getByLabel("Message", { exact: true })
        .fill("New draft blocks reviewed replacement");
      await exports(page);
      await button(
        page,
        "I reviewed this candidate — replace active archive",
      ).click();
      await expect(page.getByRole("alert")).toContainText(/unsent message/i);
      expect(await selection(page)).toEqual(before.selection);
      await library(page);
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
        "New draft blocks reviewed replacement",
      );
      await page.getByLabel("Message", { exact: true }).fill("");
      await exports(page);
      await button(page, "Review again").click();
      evidence.checks.push(
        "Actual file picker stages and validates isolated candidate without activation; draft blocks both preparation of review and replacement while preserving its exact text",
      );
      const second = await context.newPage();
      observe(second);
      await second.goto(url);
      await button(second, /After export notebook/).click();
      await second
        .getByLabel("Message", { exact: true })
        .fill("Other tab draft survives archive selection");
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: resolve(resultDir, `${name}-review-mobile.png`),
        fullPage: true,
      });
      await button(
        page,
        "I reviewed this candidate — replace active archive",
      ).click();
      await expect(button(page, "Open restored archive")).toBeVisible({
        timeout: 30000,
      });
      await expect(button(page, "Open restored archive")).toBeEnabled();
      evidence.selected = await selection(page);
      expect(evidence.selected.archiveId).not.toBe(before.selection.archiveId);
      expect(evidence.selected.selectionRevision).toBe(
        before.selection.selectionRevision + 1,
      );
      await expect(second.getByLabel("Message", { exact: true })).toHaveValue(
        "Other tab draft survives archive selection",
      );
      await expect(button(second, "Open selected archive")).toBeVisible();
      await expect(button(second, "Open selected archive")).toBeDisabled();
      await expect(
        second.getByRole("heading", {
          name: "After export notebook",
          exact: true,
        }),
      ).toBeVisible();
      await second.screenshot({
        path: resolve(resultDir, `${name}-other-tab-draft.png`),
        fullPage: true,
      });
      evidence.checks.push(
        "Explicit reviewed replacement commits a new selection but does not remount; another tab receives a selection hint and retains its visible draft with opening disabled",
      );
      await button(page, "Open restored archive").click();
      await expect(button(page, /Before export notebook/)).toBeVisible({
        timeout: 30000,
      });
      await button(page, /Before export notebook/).click();
      await expect(
        page.getByRole("heading", {
          name: "Before export notebook",
          exact: true,
        }),
      ).toBeVisible();
      const restored = await snapshot(page);
      expect(restored.selection).toEqual(evidence.selected);
      expect(restored.threads).toEqual(before.threads);
      expect(restored.messages).toEqual(before.messages);
      expect(restored.parts).toEqual(before.parts);
      await expect(page.locator(".message.user")).toContainText(
        "Saved archive message 🧪",
      );
      expect(restored.states).toEqual(before.states);
      expect(restored.raw).toEqual(before.raw);
      expect(restored.sync).toEqual(before.sync);
      expect(restored.workspace).toEqual(before.workspace);
      evidence.verifiedRaw = await page.evaluate(
        (digest) => window.restoreAcceptance.verifyRaw(digest),
        evidence.raw.digest,
      );
      expect(evidence.verifiedRaw.sha256).toBe(evidence.raw.digest);
      expect(evidence.verifiedRaw.byteLength).toBe(evidence.raw.byteLength);
      expect(evidence.verifiedRaw.peakChunkBytes).toBeLessThanOrEqual(
        evidence.verifiedRaw.contractMaxChunkBytes,
      );
      expect(evidence.verifiedRaw.contractMaxChunkBytes).toBeLessThanOrEqual(
        1048576,
      );
      await second.close();
      const retained = await page.evaluate(
        (archiveId) => window.restoreAcceptance.retained(archiveId),
        before.selection.archiveId,
      );
      expect(retained.sync).toEqual(changed.sync);
      expect(retained.states).toEqual(changed.states);
      evidence.checks.push(
        "Separate Open restored archive remount shows exported history and original workspace with exact canonical and sync contents; old archive retains later edits and original blob bytes verify through bounded production transfers",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: resolve(resultDir, `${name}-restored-mobile.png`),
        fullPage: true,
      });
      evidence.userAgent = await page.evaluate(() => navigator.userAgent);
      evidence.expectedRestart = {
        states: restored.states,
        threads: restored.threads,
        sync: restored.sync,
        workspace: restored.workspace,
        messages: restored.messages,
        parts: restored.parts,
      };
    } catch (error) {
      if (page) {
        await page
          .screenshot({
            path: resolve(resultDir, `${name}-failure.png`),
            fullPage: true,
          })
          .catch(() => {});
        evidence.visibleFailure = await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable");
      }
      throw error;
    } finally {
      await context.close();
    }
    context = await engine.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
    });
    try {
      page = await context.newPage();
      observe(page);
      await page.goto(url);
      await expect(button(page, /Before export notebook/)).toBeVisible({
        timeout: 30000,
      });
      await button(page, /Before export notebook/).click();
      await expect(
        page.getByRole("heading", {
          name: "Before export notebook",
          exact: true,
        }),
      ).toBeVisible();
      const restarted = await snapshot(page);
      expect(restarted.selection).toEqual(evidence.selected);
      for (const key of [
        "states",
        "threads",
        "sync",
        "workspace",
        "messages",
        "parts",
      ])
        expect(restarted[key]).toEqual(evidence.expectedRestart[key]);
      await button(page, "New conversation").click();
      await expect(
        page.getByRole("heading", { name: "New conversation", exact: true }),
      ).toBeVisible();
      const afterNew = await snapshot(page);
      expect(afterNew.threads.items).toHaveLength(2);
      expect(
        afterNew.threads.items.every(
          (thread) => thread.workspaceId === restarted.workspace.workspaceId,
        ),
      ).toBe(true);
      evidence.checks.push(
        "Fresh browser process reopens the committed selection; new conversation uses the restored default workspace without altering prior history",
      );
      expect(evidence.externalRequests).toEqual([]);
      expect(evidence.pageErrors).toEqual([]);
      evidence.checks.push(
        "Production application stays within the local fixture origin; review and restored conversation fit the narrow viewport",
      );
      delete evidence.expectedRestart;
    } finally {
      await context.close();
    }
    evidence.status = "passed";
    await save();
    console.log(`${name}: ${evidence.checks.length} restore UI checks passed`);
  }
  report.sourceStable = true;
  for (const file of sourceFiles) {
    if (
      hash(await readFile(resolve(root, file))) !== report.sourceSha256[file]
    ) {
      report.sourceStable = false;
      (report.changedDuringRun ??= []).push(file);
    }
  }
  report.status = report.sourceStable ? "passed" : "source_changed";
  if (!report.sourceStable) process.exitCode = 1;
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
