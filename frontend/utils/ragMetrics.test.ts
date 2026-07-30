import { describe, expect, it } from "vitest";
import { summarizeRagSources } from "@/utils/ragMetrics";
import type { RagSource } from "@/utils/ragOrama";

const source = (overrides: Partial<RagSource>): RagSource => ({
  source: "doc.pdf", displayName: "doc.pdf", aliases: [], authors: [], type: "text", status: "indexed", chunks: 1,
  ocrCoverage: 0, embeddingStatus: "unavailable", revision: "test", indexedAt: 1, ...overrides,
});

describe("RAG metrics", () => {
  it("reports only persisted, indexed evidence", () => {
    const metrics = summarizeRagSources([
      source({ pageCount: 100, chunks: 40, textCoverage: 0.9, ocrCoverage: 0.2, embeddingStatus: "ready" }),
      source({ source: "second.pdf", pageCount: 50, chunks: 20, textCoverage: 0.6, ocrCoverage: 1, embeddingStatus: "failed" }),
      source({ source: "skipped.mp4", type: "image", status: "skipped", chunks: 0 }),
    ]);
    expect(metrics).toMatchObject({ documents: 2, pages: 150, chunks: 60, semanticReady: 1 });
    expect(metrics.textCoverage).toBeCloseTo(0.8);
    expect(metrics.ocrCoverage).toBeCloseTo(0.466666, 4);
  });
});
