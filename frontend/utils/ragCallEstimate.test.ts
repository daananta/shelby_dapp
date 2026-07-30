import { describe, expect, it } from "vitest";
import { estimateRagGeminiCalls } from "@/utils/ragCallEstimate";

describe("RAG Gemini call estimate", () => {
  it("shows zero cloud calls when both indexing permissions are off", () => {
    expect(estimateRagGeminiCalls([{ name: "scan.pdf", size: 1_000_000 }], { contentAnalysis: false, semanticSearch: false, fullPdfOcr: false, chunkSize: 1_200 })).toMatchObject({ contentCallsMinimum: 0, semanticCallsApproximate: 0 });
  });

  it("uses known page and chunk counts when re-indexing", () => {
    const estimate = estimateRagGeminiCalls([{ name: "book.pdf", existing: { pageCount: 171, textCoverage: 0.9, chunks: 298 } }], { contentAnalysis: true, semanticSearch: true, fullPdfOcr: true, chunkSize: 1_200 });
    expect(estimate.contentCallsMinimum).toBe(171);
    expect(estimate.semanticCallsApproximate).toBe(15);
    expect(estimate.contentCallsUncertain).toBe(false);
  });

  it("marks page estimates uncertain for a new PDF", () => {
    const estimate = estimateRagGeminiCalls([{ name: "new.pdf", size: 900_000 }], { contentAnalysis: true, semanticSearch: false, fullPdfOcr: false, chunkSize: 1_200 });
    expect(estimate.contentCallsMinimum).toBe(1);
    expect(estimate.contentCallsUncertain).toBe(true);
  });
});
