import { browserNames } from "../../../tooling/browser-engines.mjs";
const selectedBrowsers = browserNames();
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "host.spec.ts", timeout: 30_000, workers: 1,
  outputDir: "../../../test-results/web-host",
  reporter: [["list"], ["json", { outputFile: "test-results/web-host-results.json" }]],
  use: { baseURL: "http://127.0.0.1:4196", trace: "retain-on-failure" },
  projects: selectedBrowsers.map(name => ({ name, use: devices[name === "chromium" ? "Desktop Chrome" : "Desktop Safari"] })),
  webServer: { command: "node apps/web/tests/server.mjs", url: "http://127.0.0.1:4196/tests/host.html", reuseExistingServer: false, cwd: "../../.." },
});
