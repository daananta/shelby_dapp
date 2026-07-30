import { expect, test } from "@playwright/test";

test("shows a safe recovery state when the Shelby client key is missing", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__SHELBY_E2E__ = "remote-error";
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet to start", exact: true }).first().click();

  await expect(page.getByTestId("shelby-load-error")).toBeVisible();
  await expect(page.getByText("Shelby is not connected yet", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/This is not a wallet problem/).first()).toBeVisible();
  await expect(page.getByText("Shelby unavailable · 0 on-device documents", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();

  const visibleText = await page.locator("body").innerText();
  expect(visibleText).not.toMatch(/query getBlobs|anonymous requests|authorization: bearer|0x1234567890abcdef1234567890abcdef/i);
});
