import { test, expect } from "@playwright/test";

test("unavailable OPFS produces actionable failure without enabling writes", async ({ page, context }) => {
  // Deterministically exercise denial on each engine. The diagnostic harness
  // separately measures WebKit's actual ephemeral-profile failure.
  let injected = false;
  await context.route("**/assets/*.js", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (body.includes("installOpfsSAHPoolVfs")) {
      body = `navigator.storage.getDirectory = async () => { throw new DOMException('Storage denied by host', 'NotAllowedError'); };\n${body}`;
      injected = true;
    }
    await route.fulfill({ response, body });
  });
  await page.goto(`/storage-proof?namespace=unavailable-${crypto.randomUUID()}`);
  const status = page.getByTestId("storage-status");
  await expect(status).toHaveAttribute("data-state", "error");
  expect(injected).toBe(true);
  await expect(status).toContainText("OPFS");
  await expect(status).toContainText("regular browser profile");
  await expect(page.getByRole("button", { name: "Save record", exact: true })).toBeDisabled();
  await expect(page.getByTestId("diagnostics")).toBeEmpty();
});
