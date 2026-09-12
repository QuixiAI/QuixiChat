import { browserNames } from "./tooling/browser-engines.mjs";
const selectedBrowsers = browserNames();
import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const externalBaseURL = process.env.QUIXI_TEST_BASE_URL;
const outputDir = process.env.QUIXI_TEST_OUTPUT_DIR ?? "test-results";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 2,
  outputDir,
  reporter: [["list"], ["json", { outputFile: join(outputDir, "browser-results.json") }]],
  use: { baseURL: externalBaseURL ?? "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: selectedBrowsers.map(name => ({ name, use: devices[name === "chromium" ? "Desktop Chrome" : "Desktop Safari"] })),
  ...(externalBaseURL ? {} : { webServer: {
    command: "npx vite preview apps/web --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  } }),
});
