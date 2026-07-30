import { expect, test } from "@playwright/test";

test("extracts a generated PDF through the browser PDF.js worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const makePdf = (text: string) => {
      const content = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
      const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
        "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        `5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
      ];
      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      for (const object of objects) {
        offsets.push(pdf.length);
        pdf += object;
      }
      const xref = pdf.length;
      pdf += "xref\n0 6\n0000000000 65535 f \n";
      for (let index = 1; index <= 5; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
      return `${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    };
    const url = URL.createObjectURL(new Blob([makePdf("Shelby browser PDF worker evidence")], { type: "application/pdf" }));
    try {
      const { extractPagesFromUrl } = await import("/frontend/utils/textExtractor.ts");
      const pages = await extractPagesFromUrl(url, "worker-proof.pdf", 10);
      return { count: pages.length, text: pages[0]?.text };
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  expect(errors).toEqual([]);
  expect(result).toEqual({ count: 1, text: "Shelby browser PDF worker evidence" });
});
