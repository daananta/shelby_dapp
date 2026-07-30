import { expect, test } from "@playwright/test";

const pdfUrl = process.env.SHELBY_REAL_PDF_URL;
const suite = pdfUrl ? test : test.skip;

suite("extracts a real Shelby PDF in the browser worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  let result: { count: number; page12: string };
  try {
    result = await page.evaluate(async (url) => {
      const { extractPagesFromUrl } = await import("/frontend/utils/textExtractor.ts");
      const pages = await extractPagesFromUrl(url, "sach.pdf", 500);
      return { count: pages.length, page12: pages[11]?.text };
    }, pdfUrl);
  } catch (error) {
    throw new Error(`PDF worker evaluation failed at ${page.url()}: ${error instanceof Error ? error.message : String(error)}\n${errors.join("\n")}`);
  }
  expect(result.count).toBe(351);
  expect(result.page12).toContain("Người ấy thấy Dương Bố ướt cả cho mượn cái áo thâm");
});
