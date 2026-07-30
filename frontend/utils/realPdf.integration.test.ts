import { describe, expect, it } from "vitest";
import { findExactQuoteInPages } from "@/utils/ragOrama";
import { normalizeSearchText } from "@/utils/textExtractor";
import type { PageRecord } from "@/utils/ragTypes";

const realPdf = process.env.SHELBY_REAL_PDF;
const suite = realPdf ? describe : describe.skip;

suite("real Shelby sach.pdf", () => {
  it("extracts the Dương Bố quote and returns PDF page 12", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await pdfjs.getDocument(realPdf!).promise;
    expect(pdf.numPages).toBe(351);
    const page = await pdf.getPage(12);
    const content = await page.getTextContent();
    const rawText = content.items.map((item: any) => item.str).join(" ");
    const record: PageRecord = { id: "real:12", owner: "real", documentId: "real:sach.pdf", source: "sach.pdf", displayName: "sach.pdf", pageNumber: 12, totalPages: pdf.numPages, rawText, normalizedText: normalizeSearchText(rawText), extractionMethod: "text_layer" };
    expect(findExactQuoteInPages([record], "Người ấy thấy Dương Bố ướt cả cho mượn cái áo thâm")).toMatchObject({ method: "exact", pageNumber: 12 });
    await pdf.destroy();
  });
});
