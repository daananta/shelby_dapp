import { describe, expect, it } from "vitest";
import { estimateRagBatchProgress, estimateRagFileProgress, ragStageStep } from "@/utils/ragProgress";

describe("RAG indexing progress", () => {
  it("maps stable stages to the five visible steps", () => {
    expect([
      ragStageStep("access"),
      ragStageStep("download"),
      ragStageStep("ocr"),
      ragStageStep("embed"),
      ragStageStep("complete"),
    ]).toEqual([0, 1, 2, 3, 4]);
  });

  it("uses the stage key instead of localized display text", () => {
    expect(estimateRagFileProgress("download", "Downloading blob")).toBe(18);
    expect(estimateRagFileProgress("download", "Tải blob")).toBe(18);
    expect(estimateRagFileProgress("complete", "Complete")).toBe(100);
    expect(estimateRagFileProgress("complete", "Hoàn tất")).toBe(100);
  });

  it("uses real percentages and ratios inside a bounded stage range", () => {
    expect(estimateRagFileProgress("ocr", "OCR page 2/4")).toBe(62);
    expect(estimateRagFileProgress("embed", "Embedding 50%")).toBe(86);
    expect(estimateRagFileProgress("extract", "Reading 999%")).toBe(48);
  });

  it("does not count a completed file twice in the batch percentage", () => {
    expect(estimateRagBatchProgress(1, 2, "complete", 100)).toBe(50);
    expect(estimateRagBatchProgress(1, 2, "access", 7)).toBe(54);
    expect(estimateRagBatchProgress(2, 2, "complete", 100)).toBe(100);
  });
});
