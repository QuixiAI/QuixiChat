import { test, expect } from "./fixtures";

test("an interrupted first run shows a typed outcome, and retry recovers it", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Worker script interception is only deterministic in Chromium; WebKit is covered by startup-unsupported-session.spec.ts");
  // Let the namespace directory be created, then deny creation of its pool
  // directory inside the production storage workers: exactly the state an
  // interrupted first run leaves behind.
  let injected = 0;
  await context.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (body.includes("installOpfsSAHPoolVfs")) {
      body = `{ const original = FileSystemDirectoryHandle.prototype.getDirectoryHandle; FileSystemDirectoryHandle.prototype.getDirectoryHandle = function (name, options) { if (name === 'database' && options && options.create) throw new DOMException('Storage denied by host', 'NotAllowedError'); return original.call(this, name, options); }; }\n${body}`;
      injected++;
    }
    // Never let the injected script be cached: the recovery retry below must
    // load the genuine worker again.
    await route.fulfill({ response, body, headers: { ...response.headers(), "cache-control": "no-store" } });
  });
  await page.goto("/");
  const outcome = page.getByRole("alert");
  await expect(outcome).toBeVisible();
  expect(injected).toBeGreaterThan(0);
  await expect(outcome).toContainText("changes no archive data");
  await page.getByText("Technical details", { exact: true }).click();
  const code = await outcome.locator("code").innerText();
  expect(["UNSUPPORTED", "IO_ERROR"]).toContain(code);
  await expect(outcome.locator("pre")).toContainText("Storage denied by host");
  await expect(page.getByRole("button", { name: "New conversation", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toHaveCount(0);
  const heading = await outcome.getByRole("heading", { level: 1 }).innerText();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(outcome.getByRole("heading", { level: 1 })).toHaveText(heading);
  await expect(page.getByRole("button", { name: "New conversation", exact: true })).toHaveCount(0);
  // Lift the denial: the retry must recover a first run that was interrupted
  // after its namespace directory existed but before any database or blob
  // was written, and the application mounts on the fresh archive.
  await context.unroute("**/assets/*.js");
  await retry.click();
  await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New conversation", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
