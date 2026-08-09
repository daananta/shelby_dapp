import { expect, test } from "@playwright/test";

test("renders the Shelby product without boilerplate copy", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  expect(pageErrors).toEqual([]);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("translate", "no");
  await expect(page.locator('meta[name="google"]')).toHaveAttribute("content", "notranslate");
  await expect(page.getByText("Shelby RAG Explorer", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ask your Shelby data. Get evidence back." })).toBeVisible();
  await expect(page.getByText("Boilerplate Template", { exact: true })).toHaveCount(0);
  await expect(page.getByText("template docs", { exact: false })).toHaveCount(0);
});

test("loads the wallet runtime only after the visitor asks to connect", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.getByTestId("wallet-runtime")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect wallet to start", exact: true }).first().click();
  await expect.poll(() => pageErrors).toEqual([]);
  await expect(page.getByTestId("wallet-runtime")).toBeVisible();
});

test("shows a deterministic page-level RAG proof without a wallet", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the wallet-free demo", exact: true }).click();
  await expect(page.getByText("Wallet-free walkthrough · sample data", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to home", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Find source", exact: true }).click();
  await expect(page.getByText("page 2/3", { exact: false })).toBeVisible();
  await expect(page.getByText("DEMO ONLY", { exact: true })).toBeVisible();
});

test("switches to Vietnamese and remembers the visitor's choice", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "Dùng tiếng Việt", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.getByRole("heading", { name: "Hỏi dữ liệu Shelby. Nhận lại bằng chứng." })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.getByRole("heading", { name: "Hỏi dữ liệu Shelby. Nhận lại bằng chứng." })).toBeVisible();

  await page.getByRole("button", { name: "Use English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Ask your Shelby data. Get evidence back." })).toBeVisible();
});

test("keeps the bilingual landing page readable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Shelby RAG", exact: true })).toBeVisible();
  const layout = await page.evaluate(() => {
    const quote = [...document.querySelectorAll("p")].find((element) =>
      element.textContent?.includes("consensus mechanism"),
    );
    const quoteCard = quote?.closest(".rounded-2xl");
    return {
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      quoteCardRight: quoteCard?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
      viewportWidth: window.innerWidth,
    };
  });

  expect(layout.hasHorizontalOverflow).toBe(false);
  expect(layout.quoteCardRight).toBeLessThanOrEqual(layout.viewportWidth);
});

test("defaults to ShelbyNet and preserves dormant Testnet data without enabling the network", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("shelby-rag-explorer.network-v1", "testnet");
    localStorage.setItem("shelby-rag-explorer.testnet-preservation-proof", "keep-me");
  });
  await page.goto("/");
  const selector = page.getByLabel("Shelby network").first();
  await expect(selector).toHaveValue("shelbynet");
  await expect(page.getByText("ShelbyNet is a developer network; its data may be reset.", { exact: true })).toBeVisible();
  expect(await selector.getByRole("option", { name: "Shelby Testnet · Temporarily unavailable" }).evaluate((option) => (option as HTMLOptionElement).disabled)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("shelby-rag-explorer.network-v1"))).toBe("shelbynet");
  expect(await page.evaluate(() => localStorage.getItem("shelby-rag-explorer.testnet-preservation-proof"))).toBe("keep-me");
});
