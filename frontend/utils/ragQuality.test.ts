import { describe, expect, it } from "vitest";
import { assessRagQuality } from "@/utils/ragQuality";
import type { RagSource } from "@/utils/ragOrama";

const source = (overrides: Partial<RagSource> = {}): RagSource => ({ source: "book.pdf", displayName: "book.pdf", aliases: [], authors: [], type: "text", status: "indexed", chunks: 20, pageCount: 100, ocrCoverage: 1, textCoverage: 1, embeddingStatus: "ready", revision: "test", indexedAt: 1, ...overrides });

describe("RAG quality gate", () => {
  it("does not claim readiness without indexed evidence", () => {
    expect(assessRagQuality([])).toMatchObject({ state: "empty", indexedDocuments: 0 });
  });

  it("flags low page coverage and failed semantic retrieval", () => {
    const assessment = assessRagQuality([source({ textCoverage: 0.5, ocrCoverage: 0.2, embeddingStatus: "failed" })]);
    expect(assessment.state).toBe("attention");
    expect(assessment.warnings.join(" ")).toContain("50%");
    expect(assessment.warnings.join(" ")).toContain("semantic search data could not be created");
  });

  it("marks complete page-level evidence ready", () => {
    expect(assessRagQuality([source()])).toEqual({ state: "ready", indexedDocuments: 1, warnings: [] });
  });

  it("treats one chunk as normal for an image but suspicious for a multi-page text document", () => {
    const image = source({ source: "anime.jpeg", displayName: "anime.jpeg", type: "image", pageCount: 0, chunks: 1, textCoverage: undefined });
    expect(assessRagQuality([image]).state).toBe("ready");
    const thinPdf = source({ pageCount: 20, chunks: 1 });
    expect(assessRagQuality([thinPdf]).warnings.join(" ")).toContain("produced only 1 chunk");
  });

  it("surfaces ingestion failures instead of reporting an empty workspace", () => {
    const failed = source({ status: "failed", chunks: 0, error: "Không đọc được định dạng" });
    const assessment = assessRagQuality([failed]);
    expect(assessment.state).toBe("attention");
    expect(assessment.warnings.join(" ")).toContain("Không đọc được định dạng");
  });
});
