import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Keep this sandbox behavior test independent from the language-default test.
  await page.addInitScript(() => {
    localStorage.setItem("shelby-rag-explorer.language", "vi");
    (window as any).__SHELBY_E2E__ = true;
  });
});

test("keeps sandbox purchases available without exposing the faucet banner", async ({ page }) => {
  // Force large desktop viewport
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto("/");

  // 1. Click "Kết nối ví để bắt đầu"
  const startConnectBtn = page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first();
  await expect(startConnectBtn).toBeVisible();
  await startConnectBtn.click();

  // 2. Sandbox plumbing remains available for demos, but its internal balance
  // and faucet are no longer shown in the product header.
  await expect(page.getByText("Sandbox Mode:")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Faucet 100 USD" })).toHaveCount(0);

  // Scroll inner list container to the bottom to expose the locked blob
  await page.locator('.custom-scrollbar').first().evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(500);

  // 3. Verify Demo Blobs exist
  const publicBlob = page.getByText("Hướng dẫn Shelby RAG (Public)");
  await expect(publicBlob).toBeVisible();

  const lockedBlob = page.getByText("Kế hoạch Shelby 2026 (Locked - 50 ShelbyUSD)");
  await expect(lockedBlob).toBeVisible();

  // 4. Verify and Click "Mua quyền" for the locked blob
  const buyBtn = page.getByRole("button", { name: "Mua quyền" });
  await expect(buyBtn).toBeVisible();
  await buyBtn.click();

  // 5. Verify "Mua quyền" button disappears (since it's unlocked)
  await expect(buyBtn).not.toBeVisible();
});
