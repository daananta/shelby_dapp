import { expect, test } from "@playwright/test";

test("loads the real Shelby Clay encoder in the Vite browser runtime", async ({ page }) => {
  await page.goto("/");
  const config = await page.evaluate(async () => {
    const { getErasureProvider } = await import("/frontend/utils/shelbyErasure.ts");
    const provider = await getErasureProvider();
    return {
      encoding: provider.config.enumIndex,
      dataChunks: provider.config.erasure_k,
      totalChunks: provider.config.erasure_n,
    };
  });

  expect(config.totalChunks).toBeGreaterThan(config.dataChunks);
  expect(config.encoding).toBeGreaterThanOrEqual(0);
});
