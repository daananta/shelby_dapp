import { expect, test } from "@playwright/test";

test("commits a replacement document atomically in Chromium IndexedDB", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const rag = await import("/frontend/utils/ragOrama.ts");
    const owner = "0xchromium-index-test";
    const documentId = `${owner}:sach.pdf`;
    const makeDocument = (text: string) => ({
      manifest: { id: documentId, owner, source: "sach.pdf", displayName: "sach.pdf", revision: "e2e-v4", blobUrl: "https://example.test/sach.pdf", mimeType: "application/pdf", type: "text" as const, aliases: [], authors: [], pageCount: 1, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable" as const, status: "indexed" as const, indexedAt: Date.now() },
      pages: [{ id: `${documentId}:page:1`, owner, documentId, source: "sach.pdf", displayName: "sach.pdf", pageNumber: 1, totalPages: 1, rawText: text, normalizedText: text.toLowerCase(), extractionMethod: "text_layer" as const }],
      chunks: [{ id: `${documentId}:chunk:0`, owner, documentId, source: "sach.pdf", displayName: "sach.pdf", type: "text" as const, text, normalizedText: text.toLowerCase(), pageNumber: 1, totalPages: 1 }],
      stories: [],
    });
    await rag.setActiveRagOwner(owner);
    await rag.replaceDocument(makeDocument("Bản đầu"));
    await rag.replaceDocument(makeDocument("Bản thay thế"));
    return rag.getRagSources().map((source: { source: string; chunks: number }) => ({ source: source.source, chunks: source.chunks }));
  });
  expect(result).toEqual([{ source: "sach.pdf", chunks: 1 }]);
});
