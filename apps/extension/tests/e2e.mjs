import { build, preview } from "vite";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir, platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** End to end in real Chromium: the built MV3 extension extracts from a
 * synthetic ChatGPT web origin (the observed session/list/conversation
 * endpoints, served locally), stages the bundle, pairs with the shared import
 * panel and transfers it; the production importer stores it. Incremental
 * "only new" runs, an expired session and a changed provider shape are
 * exercised against the same fixture server. No real provider is contacted. */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const extensionRoot = resolve(root, "apps/extension");
const temporary = await mkdtemp(resolve(tmpdir(), "quixi-extension-e2e-"));
const providerPort = 4301, quixiPort = 4302;
const providerOrigin = `http://127.0.0.1:${providerPort}`, quixiOrigin = `http://127.0.0.1:${quixiPort}`;
const report = { status: "running", startedAt: new Date().toISOString(), checks: [], providerRequests: [], sourceSha256: {}, environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version } };
const save = async () => { await mkdir(resolve(root, "test-results"), { recursive: true }); await writeFile(resolve(root, "test-results/extension-e2e.json"), JSON.stringify(report, null, 2) + "\n"); };
const fixture = JSON.parse(await readFile(resolve(root, "packages/importers/tests/fixtures/chatgpt-observed.synthetic.json"), "utf8"));
/** Synthetic provider: conversations are keyed by id; update_time drives "only new". */
const conversations = new Map();
const seed = (id, title, updateTime, text) => {
  const record = structuredClone(fixture[0]);
  record.conversation_id = id; record.title = title; record.update_time = updateTime; record.create_time = updateTime - 100;
  const user = Object.values(record.mapping).find((node) => node.message?.author?.role === "user");
  user.message.content.parts[0] = text;
  conversations.set(id, record);
};
seed("web-conversation-1", "Comet design", 1_780_000_000, "Describe a fictional comet named Ilyra.");
seed("web-conversation-2", "Garden planning", 1_780_000_500, "Plan a small balcony garden with tomatoes and basil.");
let sessionValid = true, breakShape = false;
const provider = createServer((request, response) => {
  const url = new URL(request.url, providerOrigin);
  report.providerRequests.push({ path: url.pathname + url.search, authorization: request.headers.authorization ? "bearer" : "none" });
  const json = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  if (url.pathname === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>Synthetic ChatGPT</title><p>Synthetic provider page for the Quixi extension proof.</p>"); return; }
  if (url.pathname === "/fixture/expire") { sessionValid = false; return json(200, { ok: true }); }
  if (url.pathname === "/fixture/restore") { sessionValid = true; breakShape = false; return json(200, { ok: true }); }
  if (url.pathname === "/fixture/break-shape") { breakShape = true; return json(200, { ok: true }); }
  if (url.pathname === "/fixture/add") { seed("web-conversation-3", "Late addition", 1_780_001_000, "Summarize the comet and the garden in one sentence."); return json(200, { ok: true }); }
  if (url.pathname === "/api/auth/session") return json(200, sessionValid ? { accessToken: "synthetic-token", user: { id: "u" } } : {});
  if (request.headers.authorization !== "Bearer synthetic-token") return json(401, { detail: "unauthorized" });
  if (url.pathname === "/backend-api/conversations") {
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
    const items = [...conversations.values()].sort((a, b) => b.update_time - a.update_time).map((record) => ({ id: record.conversation_id, title: record.title, create_time: record.create_time, update_time: record.update_time }));
    return json(200, breakShape ? { conversations: items } : { items: items.slice(offset, offset + limit), total: items.length, limit, offset });
  }
  const conversation = url.pathname.match(/^\/backend-api\/conversation\/(.+)$/);
  if (conversation) { const record = conversations.get(decodeURIComponent(conversation[1])); return record ? json(200, record) : json(404, { detail: "not found" }); }
  json(404, { detail: "unknown" });
});
await new Promise((resolve) => provider.listen(providerPort, "127.0.0.1", resolve));
let server, context;
try {
  for (const file of ["apps/extension/manifest.json", "apps/extension/src/import.ts", "apps/extension/src/transfer.ts", "apps/extension/src/bridge.ts", "apps/extension/src/chatgpt.ts", "apps/extension/src/chatgpt-extractor.ts", "apps/extension/build.mjs", "apps/extension/tests/e2e.mjs", "apps/web/src/host/extension-bridge.ts", "packages/core/src/contracts/extension-import.ts", "packages/app/src/features/imports/controller.ts", "packages/app/src/features/imports/ImportPanel.tsx", "packages/importers/src/normalize.ts"])
    report.sourceSha256[file] = createHash("sha256").update(await readFile(resolve(root, file))).digest("hex");
  execFileSync(process.execPath, [resolve(extensionRoot, "build.mjs")], { cwd: extensionRoot, env: { ...process.env, QUIXI_EXTENSION_TEST_ORIGINS: `${providerOrigin}/*,${quixiOrigin}/*` }, stdio: "inherit" });
  report.manifest = JSON.parse(await readFile(resolve(extensionRoot, "dist/manifest.json"), "utf8"));
  const harness = resolve(root, "packages/app/src/features/imports/tests/browser");
  const buildOptions = { outDir: resolve(temporary, "dist"), emptyOutDir: true, rollupOptions: { input: resolve(harness, "index.html") } };
  await build({ configFile: false, root: harness, build: buildOptions, logLevel: "warn" });
  server = await preview({ configFile: false, root: harness, build: buildOptions, preview: { host: "127.0.0.1", port: quixiPort, strictPort: true }, logLevel: "warn" });
  const extensionPath = resolve(extensionRoot, "dist");
  context = await chromium.launchPersistentContext(resolve(temporary, "profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = worker.url().split("/")[2];
  report.extensionId = extensionId;
  const archive = `test-extension-${randomUUID()}`;
  const app = await context.newPage();
  app.on("pageerror", (error) => report.checks.push(`page error: ${error}`));
  await app.goto(`${quixiOrigin}/?archive=${archive}`);
  await expect(app.getByRole("heading", { name: "Import your history" })).toBeVisible();
  const code = await app.getByTestId("extension-pairing-code").textContent();
  await app.getByLabel("Source account label").fill("Web account");
  const ext = await context.newPage();
  const extConsole = [];
  ext.on("console", (message) => extConsole.push(`${message.type()}: ${message.text()}`));
  ext.on("pageerror", (error) => extConsole.push(`pageerror: ${error}`));
  report.diagnostics = { extConsole, opfs: async () => ext.evaluate(async () => { const out = []; const root = await navigator.storage.getDirectory(); try { const dir = await root.getDirectoryHandle("bundles"); for await (const [name, handle] of dir.entries()) out.push([name, (await handle.getFile()).size]); } catch (error) { out.push(String(error)); } return out; }), panel: async () => app.locator(".quixi-imports").innerText(), extStatus: async () => ext.locator("#status").textContent(), tabs: async () => ext.evaluate(() => chrome.tabs.query({})), probe: async (origin) => ext.evaluate(async (origin) => {
    const race = (promise, label) => Promise.race([promise.then((value) => `${label}: ok ${JSON.stringify(value).slice(0, 200)}`, (error) => `${label}: error ${error.message}`), new Promise((resolve) => setTimeout(() => resolve(`${label}: timeout`), 5000))]);
    const out = [];
    out.push(await race(chrome.permissions.contains({ origins: [`${origin}/*`] }), "contains"));
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    out.push(`query: ${tabs.length} ${tabs[0]?.id}`);
    if (tabs[0]) {
      out.push(await race(chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ["bridge.js"] }), "inject"));
      out.push(await race(new Promise((resolve, reject) => { const port = chrome.tabs.connect(tabs[0].id, { name: "quixi-import" }); port.onMessage.addListener((m) => resolve(m)); port.onDisconnect.addListener(() => reject(new Error(`disconnect ${chrome.runtime.lastError?.message}`))); port.postMessage({ kind: "ping" }); }), "ping"));
    }
    return out;
  }, origin) };
  await ext.goto(`chrome-extension://${extensionId}/import.html`);
  await expect(ext.getByRole("heading", { name: "Quixi Import" })).toBeVisible();
  const configure = async () => {
    await ext.getByLabel("Quixi origin").fill(quixiOrigin);
    await ext.getByLabel(/Pairing code/).fill(code);
    await ext.getByLabel(/Source account label/).fill("Web account");
    await ext.locator("details summary").click().catch(() => {});
    await ext.getByLabel(/ChatGPT origin/).fill(providerOrigin);
  };
  await configure();
  const status = () => ext.locator("#status");
  const threads = () => app.evaluate(() => window.panelTest.threads()).then((page) => page.items.length);
  // 1. Expired session: a distinct visible failure, nothing transferred.
  await fetch(`${providerOrigin}/fixture/expire`);
  await ext.getByRole("button", { name: "Start" }).click();
  await expect(status()).toContainText("not signed in", { timeout: 30_000 });
  expect(await threads()).toBe(0);
  report.checks.push("an expired provider session is reported as a distinct visible failure before any transfer");
  await fetch(`${providerOrigin}/fixture/restore`);
  // 2. Changed provider shape: distinct failure, no guessing.
  await fetch(`${providerOrigin}/fixture/break-shape`);
  await ext.getByRole("button", { name: "Start" }).click();
  await expect(status()).toContainText("expected shape", { timeout: 30_000 });
  report.checks.push("a changed list shape is reported as a provider format change");
  await fetch(`${providerOrigin}/fixture/restore`);
  // 3. Full extraction, offer, explicit acceptance, import.
  await ext.getByRole("button", { name: "Start" }).click();
  await expect(status()).toContainText("Offered to the Quixi page", { timeout: 60_000 });
  await app.bringToFront();
  const offer = app.getByRole("group", { name: "Extension offer" });
  await expect(offer).toContainText("2 conversations");
  await expect(offer).toContainText("extracted from the provider page");
  await offer.getByRole("button", { name: "Accept and import", exact: true }).click();
  await expect(app.getByRole("status").filter({ hasText: "Import complete." })).toBeVisible({ timeout: 120_000 });
  await expect(status()).toContainText("Import complete", { timeout: 30_000 });
  expect(await threads()).toBe(2);
  const sources = (await app.evaluate(() => window.panelTest.records("importSources"))).items;
  expect(sources.filter((source) => source.method === "extension").length).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await app.evaluate(() => window.panelTest.search("balcony garden"))).items.length, { timeout: 60_000, intervals: [500] }).toBeGreaterThanOrEqual(1);
  report.firstRun = { threads: 2, providerRequests: report.providerRequests.length };
  report.checks.push("the extension extracts two conversations from the synthetic ChatGPT origin in the signed-in tab, stages and offers them, the page accepts explicitly, and the production importer stores them with extension provenance and lexical searchability");
  // 4. Only new: nothing changed, nothing sent.
  await ext.bringToFront();
  await ext.getByRole("button", { name: "Start" }).click();
  await expect(status()).toContainText("Nothing new to import", { timeout: 60_000 });
  expect(await threads()).toBe(2);
  report.checks.push("a second extraction with the saved checkpoint finds nothing newer and sends nothing");
  // 5. A new conversation appears: only it is extracted and imported.
  await fetch(`${providerOrigin}/fixture/add`);
  const before = report.providerRequests.length;
  await ext.getByRole("button", { name: "Start" }).click();
  await expect(status()).toContainText("Offered to the Quixi page", { timeout: 60_000 });
  await app.bringToFront();
  await expect(offer).toContainText("1 conversations");
  await offer.getByRole("button", { name: "Accept and import", exact: true }).click();
  await expect(app.getByRole("status").filter({ hasText: "Import complete." })).toBeVisible({ timeout: 120_000 });
  await expect(status()).toContainText("Import complete", { timeout: 30_000 });
  expect(await threads()).toBe(3);
  const fetched = report.providerRequests.slice(before).filter((entry) => entry.path.startsWith("/backend-api/conversation/"));
  expect(fetched.length).toBe(1);
  report.checks.push("after the provider gains one conversation, only that conversation is fetched, offered and imported");
  await ext.screenshot({ path: resolve(root, "test-results/extension-e2e-import-page.png"), fullPage: true });
  await app.screenshot({ path: resolve(root, "test-results/extension-e2e-app.png"), fullPage: true });
  report.extConsole = report.diagnostics.extConsole; delete report.diagnostics;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.stack ?? error);
  if (report.diagnostics) {
    try { report.tabs = await report.diagnostics.tabs(); } catch { /* page gone */ }
    try {
      report.probe = await report.diagnostics.probe(quixiOrigin);
    } catch (probeError) { report.probe = String(probeError); }
    try { report.panelText = await report.diagnostics.panel(); report.extStatus = await report.diagnostics.extStatus(); } catch { /* pages gone */ }
    try { report.opfs = await report.diagnostics.opfs(); } catch { /* page gone */ }
    console.error("PANEL", JSON.stringify(report.panelText).slice(-400), "EXTSTATUS", JSON.stringify(report.extStatus), "OPFS", JSON.stringify(report.opfs));
    report.extConsole = report.diagnostics.extConsole; delete report.diagnostics; console.error("TABS", JSON.stringify(report.tabs?.map((tab) => [tab.id, tab.url])), "PROBE", JSON.stringify(report.probe), "CONSOLE", JSON.stringify(report.extConsole));
  }
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
  await context?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  await new Promise((resolve) => provider.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
console.log(`${report.status}: ${report.checks.length} extension checks`);
