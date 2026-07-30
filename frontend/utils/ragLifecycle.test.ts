import { describe, expect, it } from "vitest";
import { assessRemoteSnapshot, blobPipelineRevision, needsLocalIndex, ragPipelineRevision } from "@/utils/ragLifecycle";
import type { RagSource } from "@/utils/ragOrama";

const source = (overrides: Partial<RagSource> = {}): RagSource => ({ source: "book.pdf", displayName: "book.pdf", aliases: [], authors: [], type: "text", status: "indexed", chunks: 10, pageCount: 10, ocrCoverage: 1, embeddingStatus: "ready", revision: "100:123:public:pipeline", indexedAt: 1, ...overrides });

describe("RAG lifecycle", () => {
  it("builds one shared pipeline revision for ingestion and dashboard freshness", () => {
    expect(ragPipelineRevision({ fullPdfOcr: true, cloudContentAnalysis: true, embeddingMode: "gemini", ragChunkSize: 1200 })).toBe("v10:quota-controls:quality-ocr-all:cloud-read-on:embedding-gemini:chunk-1200");
  });
  it("retries skipped blobs only when the ingestion pipeline changes", () => {
    expect(needsLocalIndex(source(), "100:123:public:pipeline")).toBe(false);
    expect(needsLocalIndex(source({ status: "skipped" }), "100:123:public:pipeline")).toBe(false);
    expect(needsLocalIndex(source({ status: "skipped" }), "changed")).toBe(true);
    expect(needsLocalIndex(source({ status: "failed" }), "100:123:public:pipeline")).toBe(true);
  });

  it("does not rebuild an existing enriched RAG just because cloud permissions are turned off", () => {
    const existing = source({
      revision: "100:123:public:v10:quota-controls:quality-ocr-smart:cloud-read-on:embedding-gemini:chunk-1200",
      embeddingProvider: "gemini",
    });
    const safeDefaults = "100:123:public:v10:quota-controls:quality-ocr-smart:cloud-read-off:embedding-off:chunk-1200";
    expect(needsLocalIndex(existing, safeDefaults)).toBe(false);
  });

  it("migrates a compatible v9 auto index without forcing a quota-spending rebuild", () => {
    const existing = source({
      revision: "100:123:public:v9:mp4-hot-rag:quality-ocr-smart:embedding-auto:chunk-1200",
      embeddingProvider: "gemini",
    });
    const safeDefaults = "100:123:public:v10:quota-controls:quality-ocr-smart:cloud-read-off:embedding-off:chunk-1200";
    expect(needsLocalIndex(existing, safeDefaults)).toBe(false);
  });

  it("does request an update when a previously disabled enrichment is enabled", () => {
    const existing = source({ revision: "100:123:public:v10:quota-controls:quality-ocr-smart:cloud-read-off:embedding-off:chunk-1200", embeddingStatus: "unavailable" });
    const enriched = "100:123:public:v10:quota-controls:quality-ocr-smart:cloud-read-on:embedding-gemini:chunk-1200";
    expect(needsLocalIndex(existing, enriched)).toBe(true);
  });

  it("detects a remote snapshot missing a newly registered blob", () => {
    const packageData: any = { format: "shelby-rag-package", version: 1, exportedAt: 1, sourceOwner: "0x1", inventory: { names: ["book.pdf"], fetchedAt: 1 }, documents: [{ manifest: { source: "book.pdf", sourceRevision: "100:123:public:pipeline" } }] };
    const result = assessRemoteSnapshot({ packageData, currentInventoryNames: ["book.pdf", "new.txt"], currentSources: [{ name: "book.pdf", contentIdentity: "100:123:public" }, { name: "new.txt", contentIdentity: "20:456:public" }] });
    expect(result.fresh).toBe(false);
    expect(result.missingInventoryNames).toContain("new.txt");
  });

  it("detects a remote snapshot that still contains a removed or restricted source", () => {
    const packageData: any = {
      format: "shelby-rag-package",
      version: 1,
      exportedAt: 1,
      sourceOwner: "0x1",
      inventory: { names: ["book.pdf", "old-private.pdf"], fetchedAt: 1 },
      documents: [
        { manifest: { source: "book.pdf", sourceRevision: "100:123:public:pipeline" } },
        { manifest: { source: "old-private.pdf", sourceRevision: "50:100:public:pipeline" } },
      ],
    };
    const result = assessRemoteSnapshot({
      packageData,
      currentInventoryNames: ["book.pdf"],
      currentSources: [{ name: "book.pdf", contentIdentity: "100:123:public" }],
    });
    expect(result.fresh).toBe(false);
    expect(result.extraInventoryNames).toEqual(["old-private.pdf"]);
  });

  it("builds a stable local revision from blob metadata and pipeline settings", () => {
    expect(blobPipelineRevision({ size: 100, creationMicros: 123 }, "public", "v6")).toBe("100:123:public:v6");
  });
});
