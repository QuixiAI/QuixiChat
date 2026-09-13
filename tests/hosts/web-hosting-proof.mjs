/** Plan 24: the self-hosted web image (deploy/docker) served on loopback:
 * isolation headers, SPA fallback, asset 404s, media types, the absent
 * model, the callback route's policy, and in both browser engines the
 * page's cross-origin isolation, the storage backend and origin stability
 * across a reload. Never pulls or publishes an image.
 *
 *   docker build -f deploy/docker/Dockerfile -t quixi-web:local .
 *   node tests/hosts/web-hosting-proof.mjs [--image quixi-web:local] [--keep]
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { browserEngines } from "../../tooling/browser-engines.mjs";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const image = args.includes("--image") ? args[args.indexOf("--image") + 1] : "quixi-web:local";
const keep = args.includes("--keep");
const name = `quixi-web-hosting-${randomUUID()}`;
const output = resolve(root, "docs/validation/results/web-hosting-macos.json");
const report = {
  status: "failed", startedAt: new Date().toISOString(), image, checks: [], hosts: [],
  environment: { platform: platform(), release: release(), arch: arch(), node: process.version, docker: null },
  scope: "Locally built image served over loopback HTTP; no public proxy, TLS, CDN or registry claim. Browser engines are Playwright's Chromium and WebKit on macOS, not a Linux desktop result.",
};
const run = (...argv) => execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
const check = (condition, label) => { if (!condition) throw new Error(`check failed: ${label}`); report.checks.push(label); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let base = null;
try {
  report.environment.docker = run("docker", "--version");
  report.imageId = run("docker", "image", "inspect", image, "--format", "{{.Id}}");
  run("docker", "run", "--detach", "--rm", "--pull", "never", "--name", name, "--read-only",
    "--tmpfs", "/var/cache/nginx", "--tmpfs", "/var/run", "--tmpfs", "/tmp", "--publish", "127.0.0.1::8080", image);
  const address = run("docker", "port", name, "8080/tcp");
  check(address.startsWith("127.0.0.1:"), "the server is published only on loopback");
  base = `http://${address}`;
  for (let attempt = 0; ; attempt++) {
    try { await fetch(`${base}/`); break; } catch { if (attempt === 100) throw new Error("nginx did not become ready"); await new Promise((r) => setTimeout(r, 100)); }
  }
  const get = async (path) => { const response = await fetch(`${base}${path}`, { redirect: "manual" }); return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) }; };
  // Isolation headers on the document and on every asset the document references.
  const index = await get("/");
  check(index.status === 200 && index.headers["content-type"]?.startsWith("text/html"), "the root document is served as HTML");
  check(index.headers["cross-origin-opener-policy"] === "same-origin" && index.headers["cross-origin-embedder-policy"] === "require-corp", "the root document carries COOP same-origin and COEP require-corp");
  const html = index.body.toString("utf8");
  const referenced = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  check(referenced.length >= 1, `the document references ${referenced.length} same-origin assets`);
  const types = { ".js": "javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/", ".json": "application/json", ".woff2": "font/woff2" };
  for (const path of referenced) {
    const asset = await get(path);
    check(asset.status === 200, `referenced asset ${path} is served`);
    check(asset.headers["cross-origin-opener-policy"] === "same-origin" && asset.headers["cross-origin-embedder-policy"] === "require-corp", `referenced asset ${path} carries the isolation headers`);
    const extension = Object.keys(types).find((e) => path.endsWith(e));
    if (extension) check((asset.headers["content-type"] ?? "").includes(types[extension]), `${path} is served as ${types[extension]}`);
  }
  // Every built asset is reachable with its exact bytes; WASM must be application/wasm for streaming compilation.
  const built = run("docker", "run", "--rm", "--pull", "never", "--entrypoint", "/bin/sh", image, "-c", "cd /usr/share/nginx/html && find . -type f | sort").split("\n").map((f) => f.slice(1));
  const wasm = built.filter((f) => f.endsWith(".wasm"));
  for (const path of wasm) { const asset = await get(path); check(asset.status === 200 && asset.headers["content-type"] === "application/wasm", `${path} is served as application/wasm`); }
  report.builtFiles = built.length; report.wasmFiles = wasm;
  // SPA fallback: an application route returns the document; a missing asset does not.
  const route = await get(`/library/${randomUUID()}`);
  check(route.status === 200 && route.body.equals(index.body), "an application route falls back to the root document");
  const missing = await get(`/assets/${randomUUID()}.js`);
  check(missing.status === 404, "a missing asset is a 404, not the document");
  const model = await get("/models/arctic-xs.qxmodel");
  check(model.status === 404, "the embedding model is absent from the image (semantic search reports unavailable)");
  const listing = await get("/assets/");
  check(listing.status === 403 || listing.status === 404, "the assets directory is not listed");
  // The callback route keeps its own policy and is not logged.
  const marker = `synthetic-${randomUUID()}`;
  const callback = await get(`/oauth/callback.html?code=${marker}`);
  check(callback.status === 200, "the OAuth callback document is served");
  for (const [key, value] of Object.entries({ "referrer-policy": "no-referrer", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" }))
    check(callback.headers[key] === value, `the callback route sends ${key}`);
  check(!callback.body.includes(marker), "the callback response does not reflect its query");
  const logs = run("docker", "logs", name);
  check(!logs.includes(marker) && !logs.includes("/oauth/callback.html"), "callback requests are absent from nginx logs");
  check(logs.includes("GET / ") || logs.includes("GET /assets/"), "ordinary requests are logged");
  report.indexSha256 = sha256(index.body);
  // Browser engines: isolation, the storage backend on this origin, and the same origin after a reload.
  for (const [engine, launcher] of browserEngines({ chromium, webkit })) {
    const host = { name: engine, status: "failed", checks: [] };
    report.hosts.push(host);
    const context = await launcher.launchPersistentContext(resolve("/tmp", `${name}-${engine}`), { headless: true });
    const errors = [];
    try {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${base}/`);
      host.userAgent = await page.evaluate(() => navigator.userAgent);
      check(await page.evaluate(() => globalThis.crossOriginIsolated === true), `${engine}: the page is cross-origin isolated`); host.checks.push("cross-origin isolated");
      await page.getByRole("heading", { name: "Pick up where you left off." }).waitFor({ timeout: 60_000 });
      host.checks.push("landing rendered");
      // Onboarding step 2 reads the actual device state on this origin.
      // The library pager also has a Next; onboarding's is the later one in document order.
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      const capability = page.getByTestId("capability-check");
      await capability.waitFor({ timeout: 60_000 });
      const backend = page.getByTestId("storage-backend");
      await backend.waitFor({ timeout: 60_000 });
      const text = await backend.textContent();
      check(/SQLite WASM \/ OPFS · schema \d+ · integrity ok/.test(text ?? ""), `${engine}: onboarding reports the SQLite WASM / OPFS backend with integrity ok`); host.backend = text; host.checks.push("storage backend reported");
      const capabilities = (await capability.textContent()) ?? "";
      check(capabilities.includes("✓ SQLite WASM") && capabilities.includes("✓ OPFS") && capabilities.includes("FTS5"), `${engine}: the capability check reports SQLite WASM, OPFS and FTS5 on the container origin`); host.checks.push("capabilities reported");
      check(!capabilities.includes("✓ Local model provided by this host"), `${engine}: the capability check does not claim a host-provided model (the image ships none)`); host.checks.push("no model claimed");
      host.capabilities = capabilities;
      await page.reload();
      await page.getByRole("heading", { name: "Pick up where you left off." }).waitFor({ timeout: 60_000 });
      check(await page.evaluate(() => globalThis.crossOriginIsolated === true), `${engine}: isolation holds after a reload on the same origin`); host.checks.push("isolation after reload");
      check(errors.length === 0, `${engine}: no page errors`); host.checks.push("no page errors");
      host.status = "passed";
    } catch (error) { host.error = String(error); host.pageErrors = errors; throw error; }
    finally { await context.close().catch(() => {}); }
  }
  report.sourceSha256 = Object.fromEntries(await Promise.all(["deploy/docker/Dockerfile", "deploy/docker/nginx.conf", "tests/hosts/web-hosting-proof.mjs"].map(async (p) => [p, sha256(await readFile(resolve(root, p)))])));
  report.status = "passed";
} catch (error) {
  report.error = String(error?.message ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, "docs/validation/results"), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (keep && base) console.log(`container ${name} kept at ${base}`);
  else { try { run("docker", "stop", name); } catch { /* already gone */ } }
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, hosts: report.hosts.map((h) => ({ name: h.name, status: h.status, checks: h.checks.length })) }));
}
