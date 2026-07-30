import { describe, expect, it } from "vitest";
import { ocrPdfPages } from "@/utils/pdfOcr";

describe("local PDF OCR cancellation", () => {
  it("exits before loading PDF/OCR workers when cancellation was requested", async () => {
    const result = await ocrPdfPages("unused.pdf", [{ pageNumber: 1, totalPages: 1, text: "" }], true, undefined, () => true);
    expect(result).toEqual({ pages: [], attemptedPages: 0, cancelled: true });
  });
});
