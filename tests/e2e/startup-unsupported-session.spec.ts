import { test, expect } from "@playwright/test";

test("a session without origin-private storage shows a typed startup outcome", async ({ page, browserName }) => {
  test.skip(browserName !== "webkit", "Only the measured WebKit ephemeral context fails to provide OPFS; Chromium ephemeral contexts open normally");
  // Default ephemeral context: the diagnostic harness records this actual
  // WebKit failure before SQLite starts. No injection. The failing call varies
  // between runs (directory access or worker startup), so the outcome code is
  // recorded rather than pinned; the typed view and retry are required.
  await page.goto("/");
  const outcome = page.getByRole("alert");
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText("changes no archive data");
  await page.getByText("Technical details", { exact: true }).click();
  const code = await outcome.locator("code").innerText();
  const message = await outcome.locator("pre").innerText();
  test.info().annotations.push({ type: "startup-outcome", description: `${code}: ${message.slice(0, 300)}` });
  expect(["UNSUPPORTED", "UNKNOWN", "IO_ERROR"]).toContain(code);
  if (code === "UNSUPPORTED") {
    await expect(outcome.getByRole("heading", { level: 1 })).toHaveText("Local archive storage is unavailable in this session");
    await expect(outcome).toContainText("regular browser profile");
    expect(message).toContain("Local archive storage (OPFS) is unavailable in this session");
  }
  await expect(page.getByRole("button", { name: "New conversation", exact: true })).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await retry.click();
  await expect(retry).toBeEnabled();
  // The retry fails at whichever stage the ephemeral session refuses next; it
  // must still be a typed outcome with its message, and never the application.
  await expect(outcome).toBeVisible();
  await expect(outcome.getByRole("heading", { level: 1 })).not.toBeEmpty();
  await page.getByText("Technical details", { exact: true }).click();
  const retryCode = await outcome.locator("code").innerText();
  const retryMessage = await outcome.locator("pre").innerText();
  test.info().annotations.push({ type: "retry-outcome", description: `${retryCode}: ${retryMessage.slice(0, 300)}` });
  expect(["UNSUPPORTED", "UNKNOWN", "IO_ERROR"]).toContain(retryCode);
  await expect(page.getByRole("button", { name: "New conversation", exact: true })).toHaveCount(0);
});
