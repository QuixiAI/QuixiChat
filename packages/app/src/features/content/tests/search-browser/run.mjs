import { chromium, webkit, expect } from "@playwright/test";
import { browserEngines } from "../../../../../../../tooling/browser-engines.mjs";
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
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "../../../../../../.."),
  temporary = await mkdtemp(resolve(tmpdir(), "quixi-conversation-search-"));
const engines = browserEngines({ chromium, webkit });
const output = resolve(import.meta.dirname, "results/browser.json");
const report = {
  status: "running",
  startedAt: new Date().toISOString(),
  selectedEngines: engines.map(([name]) => name),
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
  },
  sourceSha256: {},
  hosts: [],
};
const save = async () => {
  await mkdir(resolve(import.meta.dirname, "results"), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
};
const files = [
  "package-lock.json",
  "apps/web/src/main.ts",
  "packages/app/src/AppRoot.tsx",
  "packages/app/src/runtime/library.ts",
  "packages/app/src/features/content/access.ts",
  "packages/app/src/features/content/ContentPartView.tsx",
  "packages/app/src/features/content/conversation-search.ts",
  "packages/app/src/features/content/ConversationSearchFocus.tsx",
  "packages/app/src/features/content/content.css",
  "packages/app/src/features/content/tests/search-browser/index.ts",
  "packages/app/src/features/content/tests/search-browser/run.mjs",
  "packages/storage/src/worker/archive-database.ts",
  "packages/storage/src/client/archive.ts",
  "packages/storage/src/worker/search/index.ts",
  "packages/storage/src/worker/search/sources.ts",
  "packages/storage/src/worker/views.ts",
  "packages/core/src/contracts/search.ts",
  "packages/storage/sqlite/dist/sqlite3.wasm",
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  );
let server;
try {
  report.sourceSha256 = await hashes();
  const outDir = resolve(temporary, "dist");
  await build({
    configFile: false,
    root: import.meta.dirname,
    logLevel: "warn",
    plugins: [
      {
        name: "retain-pdf-licenses",
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
    throw Error("No isolated origin");
  const origin = `http://127.0.0.1:${address.port}`;
  report.origin = origin;
  for (const [name, engine] of engines) {
    const context = await engine.launchPersistentContext(
      resolve(temporary, name),
      { headless: true },
    );
    const page = await context.newPage();
    const host = {
      name,
      status: "running",
      checks: [],
      pageErrors: [],
      externalRequests: [],
    };
    report.hosts.push(host);
    await save();
    page.on("pageerror", (error) => {
      if (host.pageErrors.length < 20) host.pageErrors.push(String(error));
    });
    context.on("request", (request) => {
      if (
        !request.url().startsWith(origin + "/") &&
        host.externalRequests.length < 20
      )
        host.externalRequests.push(request.url());
    });
    try {
      await page.goto(origin);
      await expect(
        page.getByRole("heading", { name: "Pick up where you left off." }),
      ).toBeVisible();
      const seeded = await page.evaluate(() =>
        window.conversationSearchTest.seed(),
      );
      host.seeded = seeded;
      await page
        .getByRole("button", { name: "Refresh library", exact: true })
        .click();
      await page
        .getByRole("complementary", { name: "Conversation library" })
        .getByRole("button", { name: "Search navigation fixture", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: "Search navigation fixture",
          exact: true,
        }),
      ).toBeVisible();
      const messages = page.getByRole("region", {
        name: "Conversation messages",
      });
      await expect(
        messages.getByText("Ordinary section 64.", { exact: true }),
      ).toBeVisible();
      await expect(messages.getByText(/cassowarylate/)).toHaveCount(0);
      await expect(messages.getByText(/descriptionfoxtrot/)).toHaveCount(0);
      const before = await page.evaluate(() =>
        window.conversationSearchTest.snapshot(),
      );
      const search = async (query) => {
        await page
          .getByRole("textbox", { name: "Search your history", exact: true })
          .fill(query);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect(
          page
            .getByRole("region", { name: "Search results" })
            .getByRole("button", {
              name: "Search navigation fixture",
              exact: true,
            }),
        ).toBeVisible();
      };
      const clickHit = () =>
        page
          .getByRole("region", { name: "Search results" })
          .getByRole("button", {
            name: "Search navigation fixture",
            exact: true,
          })
          .click();
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Unsent same-conversation draft");
      await search("harborneedle");
      await page.evaluate(() => window.conversationSearchTest.clearTrace());
      await clickHit();
      const focus = page.getByRole("region", {
        name: "Selected search content",
      });
      await expect(focus).toHaveAttribute(
        "data-focused-part-id",
        seeded.imagePartId,
      );
      await expect(
        focus.getByText("Message part 96", { exact: true }),
      ).toBeVisible();
      await expect(
        focus.locator('[data-search-field="filename"] mark'),
      ).toHaveText("harborneedle-chart.png");
      await expect(focus.locator(".quixi-content-part mark")).toHaveCount(0);
      await expect(focus.getByText(/descriptionfoxtrot/)).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message", exact: true }),
      ).toHaveValue("Unsent same-conversation draft");
      host.navigationTrace = await page.evaluate(() =>
        window.conversationSearchTest.trace(),
      );
      const parts = host.navigationTrace.filter(
        (call) => call.operation === "readMessageParts",
      );
      expect(parts.length).toBeGreaterThan(0);
      expect(
        parts.every(
          (call) =>
            call.args.page.cursor === null && call.args.page.maxItems === 64,
        ),
      ).toBe(true);
      expect(
        host.navigationTrace.some(
          (call) =>
            call.operation === "readEntity" &&
            call.args.collection === "parts" &&
            call.args.id === seeded.imagePartId,
        ),
      ).toBe(true);
      expect(
        host.navigationTrace.filter(
          (call) => call.operation === "resolveConversationSearchHit",
        ),
      ).toHaveLength(1);
      expect(
        host.navigationTrace.some((call) => call.operation === "commit"),
      ).toBe(false);
      host.checks.push(
        "actual webmain search resolves image filename at part96 beyond first64; exact canonical filename field is marked, description is not, and no preceding part pages or mutations are requested",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(focus).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        path: resolve(
          import.meta.dirname,
          `results/${name}-filename-mobile.png`,
        ),
        fullPage: true,
      });
      await focus.screenshot({
        path: resolve(
          import.meta.dirname,
          `results/${name}-filename-focus.png`,
        ),
      });
      await page.setViewportSize({ width: 1100, height: 850 });
      await focus
        .getByRole("button", { name: "Close selected content" })
        .click();
      await search("cassowarylate");
      await clickHit();
      await expect(focus).toHaveAttribute(
        "data-focused-part-id",
        seeded.latePartId,
      );
      await expect(focus.getByText(/cassowarylate appears/)).toBeVisible();
      await expect(focus.locator('[data-search-field="filename"]')).toHaveCount(
        0,
      );
      host.checks.push(
        "ordinary text result opens exact part95 without enumerating earlier part pages; same-conversation draft and canonical context remain intact",
      );
      await focus
        .getByRole("button", { name: "Close selected content" })
        .click();
      await search("descriptionfoxtrot");
      await clickHit();
      await expect(focus).toHaveAttribute(
        "data-focused-part-id",
        seeded.imagePartId,
      );
      await expect(focus.locator('[data-search-field="filename"]')).toHaveCount(
        0,
      );
      await expect(focus.locator("mark")).toHaveCount(0);
      await page
        .getByRole("complementary", { name: "Conversation library" })
        .getByRole("button", { name: "Search navigation fixture", exact: true })
        .click();
      await expect(focus).toHaveCount(0);
      await expect(
        messages.getByText("Ordinary section 64.", { exact: true }),
      ).toBeVisible();
      const after = await page.evaluate(() =>
        window.conversationSearchTest.snapshot(),
      );
      expect(after.diagnostics.canonicalRecords).toBe(
        before.diagnostics.canonicalRecords,
      );
      expect(after.diagnostics.syncOperations).toBe(
        before.diagnostics.syncOperations,
      );
      expect(after.view).toEqual(before.view);
      host.checks.push(
        "description source never receives filename marking; normal navigation clears focus and all display/search actions leave thread/context/canonical/sync unchanged",
      );
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("");
      await page
        .getByRole("complementary", { name: "Conversation library" })
        .getByRole("button", { name: "Draft conversation", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Draft conversation", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Keep this other conversation draft");
      await search("harborneedle");
      await clickHit();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Copy or clear your unsent message" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Draft conversation", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message", exact: true }),
      ).toHaveValue("Keep this other conversation draft");
      await expect(focus).toHaveCount(0);
      host.checks.push(
        "cross-conversation search refuses draft loss and retains original composer/context",
      );
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("");
      await page.evaluate(() =>
        window.conversationSearchTest.holdNextPartRead(),
      );
      await clickHit();
      await page.waitForFunction(() => window.conversationSearchTest.held());
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Typed while the result was opening");
      await page.evaluate(() => window.conversationSearchTest.release());
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Keep your current draft or response open" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Draft conversation", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message", exact: true }),
      ).toHaveValue("Typed while the result was opening");
      await expect(focus).toHaveCount(0);
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("");
      await page.evaluate(() =>
        window.conversationSearchTest.holdNextPartRead(),
      );
      await clickHit();
      await page.waitForFunction(() => window.conversationSearchTest.held());
      await page
        .getByRole("complementary", { name: "Conversation library" })
        .getByRole("button", { name: "Search navigation fixture", exact: true })
        .click();
      await page.evaluate(() => window.conversationSearchTest.release());
      await expect(
        page.getByRole("heading", {
          name: "Search navigation fixture",
          exact: true,
        }),
      ).toBeVisible();
      await expect(focus).toHaveCount(0);
      await expect(
        page.getByRole("status").filter({ hasText: "Opening the matching" }),
      ).toHaveCount(0);
      host.checks.push(
        "a delayed real metadata reply cannot discard a newly typed draft or restore focus after newer normal navigation",
      );
      await clickHit();
      await expect(focus).toHaveAttribute(
        "data-focused-part-id",
        seeded.imagePartId,
      );
      await focus
        .getByRole("button", { name: "Close selected content" })
        .click();
      await search("harborneedle");
      await page.evaluate(() => window.conversationSearchTest.tombstone());
      await clickHit();
      await expect(
        page.getByRole("alert").filter({ hasText: "Search again to refresh" }),
      ).toBeVisible();
      await expect(focus).toHaveCount(0);
      host.checks.push(
        "a retained search result is refused by the production resolver after canonical branch tombstoning; no current part is substituted",
      );
      expect(host.pageErrors).toEqual([]);
      expect(host.externalRequests).toEqual([]);
      host.checks.push(
        "390px viewport remains within layout bounds; no browser exceptions or external requests",
      );
      host.userAgent = await page.evaluate(() => navigator.userAgent);
      await page.evaluate(() => window.conversationSearchTest.close());
      host.status = "passed";
    } catch (error) {
      await page
        .screenshot({
          path: resolve(import.meta.dirname, `results/${name}-failure.png`),
          fullPage: true,
        })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
      await save();
    }
  }
  const after = await hashes();
  report.sourceStable =
    JSON.stringify(after) === JSON.stringify(report.sourceSha256);
  if (!report.sourceStable) {
    report.sourceSha256After = after;
    throw Error("Source changed during capture");
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
