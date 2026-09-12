import { test as base, expect } from "@playwright/test";
import { rm } from "node:fs/promises";

// WebKit ephemeral contexts cannot open OPFS on the measured macOS build.
// Give durability scenarios real, isolated profiles in both engines.
export const test = base.extend<{ storageProfile: string }>({
  storageProfile: async ({}, use, testInfo) => {
    const profile = testInfo.outputPath("browser-profile");
    try { await use(profile); }
    finally { await rm(profile, { recursive: true, force: true }); }
  },
  context: async ({ playwright, browserName, baseURL, storageProfile }, use) => {
    const context = await playwright[browserName].launchPersistentContext(storageProfile, {
      ...(baseURL ? { baseURL } : {}), viewport: { width: 1280, height: 900 },
    });
    try { await use(context); }
    finally { await context.close(); }
  },
});
export { expect };
