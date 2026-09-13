/** Probe a kept stress profile (a failed run keeps its browser profiles):
 * opens the seeded archive on the stress harness origin and times the light
 * diagnostics read and the report under two explicit deadlines.
 *
 *   node packages/app/tests/browser/probe-archive.mjs <profile-dir> <harness-dist-dir>
 */
import { preview } from "vite";
import { webkit } from "@playwright/test";
const [profile, dist] = process.argv.slice(2);
const server = await preview({ configFile: false, root: "packages/app/tests/browser", build: { outDir: dist }, preview: { host: "127.0.0.1", port: 4206, strictPort: true }, logLevel: "warn" });
const context = await webkit.launchPersistentContext(profile + "/webkit", { headless: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);
try {
  const page = await context.newPage();
  page.on("console", (m) => { if (m.text().startsWith("[probe]")) log(m.text()); });
  await page.goto("http://127.0.0.1:4206/?archive=test-probe-0&embedding=missing");
  await page.waitForTimeout(3000);
  const names = await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const out = []; for await (const [name] of root.entries()) out.push(name); return out; });
  log("opfs entries", names.join(","));
  const archive = names.map((n) => n.replace(/^quixi-/, "")).find((n) => n.startsWith("test-stress-"));
  if (!archive) throw new Error("no stress archive in profile");
  await page.evaluate(() => window.appAcceptance.close()).catch(() => {});
  await page.goto(`http://127.0.0.1:4206/?archive=${archive}&embedding=missing`);
  await page.getByRole("heading", { name: "Pick up where you left off." }).waitFor({ timeout: 120000 });
  log("opened", archive);
  const light = await page.evaluate(() => window.appAcceptance.stress.request("diagnostics", null));
  log("light", JSON.stringify(light).slice(0, 300));
  await page.evaluate(() => { window.__ticks = 0; setInterval(() => { window.__ticks++; if (window.__ticks % 10 === 0) console.log("[probe] page alive tick", window.__ticks); }, 1000); });
  await page.evaluate(() => { const original = window.setTimeout; window.setTimeout = function (fn, ms, ...rest) { if (ms >= 50000) console.log(`[probe] timer ${ms} ms armed at ${new Error().stack?.split("\n").slice(1, 6).join(" | ")}`); return original.call(window, fn, ms, ...rest); }; });
  const r1 = await page.evaluate(() => window.appAcceptance.stress.request("diagnosticsReport", null, 600000));
  log("report@600s", r1.ms.toFixed(0), "ms", JSON.stringify(r1.error), r1.value ? "ok " + JSON.stringify(r1.value.checks.find(c => c.id === "sqlite_integrity").measured) : "");
  await page.evaluate(() => window.appAcceptance.close()).catch(() => {});
} finally {
  await context.close().catch(() => {});
  await new Promise((done) => server.httpServer.close(done));
}
