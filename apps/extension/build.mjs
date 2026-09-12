import { build } from "vite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Three bundles: the import page (module), and two classic scripts that are
 * injected into tabs (they cannot be ES modules) plus the module service worker. */
const root = fileURLToPath(new URL("./", import.meta.url));
const outDir = resolve(root, "dist");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
await build({ configFile: false, root, logLevel: "warn", build: { outDir, emptyOutDir: false, rollupOptions: { input: { import: resolve(root, "import.html") } } } });
for (const [entry, name] of [["src/bridge.ts", "bridge"], ["src/chatgpt-extractor.ts", "chatgpt-extractor"]])
  await build({ configFile: false, root, logLevel: "warn", build: { outDir, emptyOutDir: false, lib: { entry: resolve(root, entry), name: `quixi_${name.replace(/-/g, "_")}`, formats: ["iife"], fileName: () => `${name}.js` } } });
await build({ configFile: false, root, logLevel: "warn", build: { outDir, emptyOutDir: false, lib: { entry: resolve(root, "src/background.ts"), formats: ["es"], fileName: () => "background.js" } } });
// Test builds may pre-grant loopback origins so automated Chromium (which
// cannot answer permission prompts) exercises the same code path; the
// distributed manifest keeps host_permissions empty.
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const testOrigins = (process.env.QUIXI_EXTENSION_TEST_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
if (testOrigins.length) {
  if (testOrigins.some((origin) => !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\*$/.test(origin))) throw new Error("Test origins must be loopback match patterns");
  manifest.host_permissions = testOrigins;
  manifest.name = `${manifest.name} (test build)`;
}
writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Built the Quixi Import extension into ${outDir}`);
