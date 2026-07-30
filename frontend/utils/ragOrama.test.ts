import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { clearActiveRagWorkspace, deactivateActiveRagOwner, exportPortableRagPackage, findExactQuoteInPages, getRagSources, hasRemoteRagProvider, importPortableRagPackage, invalidateShelbyBlobInventory, lookupExactQuote, recordSourceFailure, replaceDocument, searchDocuments, setActiveRagOwner, setRemoteRagProvider, setShelbyBlobInventory } from "@/utils/ragOrama";
import type { DocumentReplacement, PageRecord } from "@/utils/ragTypes";

const quote = "Người ấy thấy Dương Bố ướt cả cho mượn cái áo thâm";

function replacement(owner: string, text = quote): DocumentReplacement {
  const documentId = `${owner}:sach.pdf`;
  const page: PageRecord = { id: `${documentId}:page:12`, owner, documentId, source: "sach.pdf", displayName: "sach.pdf", pageNumber: 12, totalPages: 351, rawText: `Một hôm trời mưa. ${text}. Một lúc trời tạnh.`, normalizedText: `một hôm trời mưa. ${text.toLocaleLowerCase("vi-VN")}. một lúc trời tạnh.`, extractionMethod: "text_layer" };
  return {
    manifest: { id: documentId, owner, source: "sach.pdf", displayName: "sach.pdf", revision: "fixture-v4", blobUrl: "https://example.test/sach.pdf", blobId: "blob-fixture-12", blobMerkleRoot: "0x1234abcd", blobSize: 4096, blobCreatedAtMicros: 1_700_000_000_000_000, accessTag: "public", mimeType: "application/pdf", type: "text", title: { value: "Cổ học tinh hoa", confidence: 1, provenance: "user", userLocked: true }, aliases: ["Co hoc tinh hoa"], authors: [], pageCount: 351, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: 1 },
    pages: [page],
    chunks: [{ id: `${documentId}:chunk:0`, owner, documentId, source: "sach.pdf", displayName: "sach.pdf", type: "text", text: page.rawText, normalizedText: page.normalizedText, pageNumber: 12, totalPages: 351 }],
    stories: [],
  };
}

describe("v4 page store", () => {
  it("does not return late search results after Stop", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(searchDocuments("bất kỳ", 4, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("finds the real quote deterministically at page 12", () => {
    const record = replacement("0xquote").pages;
    expect(findExactQuoteInPages(record, quote)).toMatchObject({ method: "exact", pageNumber: 12, totalPages: 351 });
  });

  it("does not treat quote words scattered across a page as a fuzzy match", () => {
    const fixture = replacement("0xscattered");
    const scattered = quote.split(/\s+/).map((word, index) => `${word} nội dung-khác-${index}`).join(" ");
    fixture.pages[0].rawText = scattered;
    fixture.pages[0].normalizedText = scattered.toLocaleLowerCase("vi-VN");
    expect(findExactQuoteInPages(fixture.pages, quote)).toBeNull();
  });

  it("accepts a small OCR omission only inside a contiguous quote window", () => {
    const fixture = replacement("0xfuzzy-window", quote.replace("ướt cả", "ướt"));
    const result = findExactQuoteInPages(fixture.pages, quote);
    expect(result).toMatchObject({ method: "fuzzy", pageNumber: 12 });
    expect(result?.excerpt).toContain("Dương Bố");
  });

  it("rejects empty and unbounded fuzzy quote work", () => {
    expect(findExactQuoteInPages(replacement("0xempty").pages, "   ")).toBeNull();
    const longQuote = Array.from({ length: 65 }, (_, index) => `từ${index}`).join(" ");
    const almostLongQuote = longQuote.replace("từ32", "khác32");
    expect(findExactQuoteInPages(replacement("0xlong-fuzzy", almostLongQuote).pages, longQuote)).toBeNull();
  });

  it("attaches the chunk that actually contains an exact quote", async () => {
    await setActiveRagOwner("0xexact-chunk");
    const fixture = replacement("0xexact-chunk");
    fixture.manifest.chunkCount = 2;
    fixture.chunks = [
      { ...fixture.chunks[0], id: "0xexact-chunk:sach.pdf:chunk:noise", text: "Một đoạn khác trên cùng trang", normalizedText: "một đoạn khác trên cùng trang" },
      { ...fixture.chunks[0], id: "0xexact-chunk:sach.pdf:chunk:quote" },
    ];
    await replaceDocument(fixture);
    expect((await lookupExactQuote(quote))?.provenance?.chunkId).toBe("0xexact-chunk:sach.pdf:chunk:quote");
  });

  it("replaces the same document atomically without doubling chunks", async () => {
    await setActiveRagOwner("0xatomic");
    await replaceDocument(replacement("0xatomic"));
    await replaceDocument(replacement("0xatomic", `${quote} lần cập nhật`));
    expect(getRagSources()).toHaveLength(1);
    expect(getRagSources()[0].chunks).toBe(1);
  });

  it("marks a failed retry as failed instead of leaving a stale indexed badge", async () => {
    await setActiveRagOwner("0xretry-failure");
    await replaceDocument(replacement("0xretry-failure"));
    await recordSourceFailure({ source: "sach.pdf", displayName: "sach.pdf", type: "text" }, new Error("OCR worker crashed"));
    expect(getRagSources()[0]).toMatchObject({ status: "failed", error: "Latest processing attempt failed: OCR worker crashed" });
    expect(await searchDocuments("Dương Bố áo thâm", 4)).toHaveLength(0);
  });

  it("retrieves lexical evidence without starting an embedding provider when the index has no vectors", async () => {
    await setActiveRagOwner("0xlexical-only");
    await replaceDocument(replacement("0xlexical-only"));
    const results = await searchDocuments("Dương Bố mượn áo thâm", 4);
    expect(results[0]).toMatchObject({ method: "lexical", pageNumber: 12, source: "sach.pdf" });
    expect(results[0].provenance).toMatchObject({ owner: "0xlexical-only", accessTag: "public", blobId: "blob-fixture-12", blobMerkleRoot: "0x1234abcd", chunkId: "0xlexical-only:sach.pdf:chunk:0", extractionMethod: "text_layer" });
  });

  it("isolates persisted indexes by wallet", async () => {
    await setActiveRagOwner("0xwallet-a");
    await replaceDocument(replacement("0xwallet-a"));
    await setActiveRagOwner("0xwallet-b");
    expect(getRagSources()).toHaveLength(0);
    await setActiveRagOwner("0xwallet-a");
    expect(getRagSources()[0].title).toBe("Cổ học tinh hoa");
  });

  it("removes wallet A data and remote search authority from memory after disconnect without deleting its persisted index", async () => {
    const owner = "0xdisconnect-a";
    await setActiveRagOwner(owner);
    await replaceDocument(replacement(owner, "dữ liệu riêng của ví A"));
    setRemoteRagProvider({
      id: "disconnect-remote",
      search: async () => [{
        method: "lexical",
        documentId: "remote:private.pdf",
        source: "private.pdf",
        displayName: "private.pdf",
        pageNumber: 1,
        totalPages: 1,
        excerpt: "dữ liệu từ provider của ví A",
        score: 1,
      }],
    });

    expect((await searchDocuments("dữ liệu riêng", 4)).length).toBeGreaterThan(0);
    expect(hasRemoteRagProvider()).toBe(true);

    expect(await deactivateActiveRagOwner(owner)).toBe(true);
    expect(getRagSources()).toHaveLength(0);
    expect(hasRemoteRagProvider()).toBe(false);
    expect(await searchDocuments("dữ liệu riêng provider", 4)).toHaveLength(0);

    await setActiveRagOwner(owner);
    expect(getRagSources()).toMatchObject([{ source: "sach.pdf" }]);
    expect((await searchDocuments("dữ liệu riêng", 4))[0]?.excerpt).toContain("ví A");
  });

  it("does not let a late disconnect cleanup clear a newer wallet", async () => {
    await setActiveRagOwner("0xdisconnect-b");
    await replaceDocument(replacement("0xdisconnect-b", "dữ liệu ví B vẫn hoạt động"));

    expect(await deactivateActiveRagOwner("0xdisconnect-a")).toBe(false);
    expect((await searchDocuments("dữ liệu ví B", 2))[0]?.excerpt).toContain("ví B");
  });

  it("serializes rapid wallet switches and keeps the last requested owner active", async () => {
    await setActiveRagOwner("0xrace-a");
    await replaceDocument(replacement("0xrace-a", "nội dung ví A"));
    await setActiveRagOwner("0xrace-b");
    await replaceDocument(replacement("0xrace-b", "nội dung ví B"));
    await setActiveRagOwner("0xrace-neutral");

    await Promise.all([setActiveRagOwner("0xrace-a"), setActiveRagOwner("0xrace-b")]);

    expect(getRagSources()).toMatchObject([{ source: "sach.pdf" }]);
    expect((await searchDocuments("nội dung ví B", 1))[0]?.excerpt).toContain("nội dung ví B");
  });

  it("exports portable lexical evidence and imports it for another active wallet", async () => {
    await setActiveRagOwner("0xpackage-source");
    await replaceDocument(replacement("0xpackage-source"));
    await setShelbyBlobInventory("0xpackage-source", ["sach.pdf", "old.shelby-rag.json"]);
    const portable = await exportPortableRagPackage();
    expect(portable.documents[0].chunks[0]).not.toHaveProperty("embedding");
    expect(portable.documents[0].manifest).toMatchObject({ blobId: "blob-fixture-12", blobMerkleRoot: "0x1234abcd", accessTag: "public" });
    expect(JSON.stringify(portable)).not.toMatch(/api.?key|private.?key/i);
    expect(portable.inventory?.names).toEqual(["sach.pdf"]);
    await setActiveRagOwner("0xpackage-target");
    expect(await importPortableRagPackage(portable)).toBe(1);
    expect(getRagSources()).toMatchObject([{ source: "sach.pdf", chunks: 1, revision: "fixture-v4", indexedAt: 1 }]);
  });

  it("exports deterministic bytes for the same local revision so upload can resume", async () => {
    await setActiveRagOwner("0xdeterministic-export");
    await replaceDocument(replacement("0xdeterministic-export"));
    await setShelbyBlobInventory("0xdeterministic-export", ["sach.pdf"], ["sach.pdf"]);
    const first = await exportPortableRagPackage({ exportedAt: 1_700_000_123_456 });
    const second = await exportPortableRagPackage({ exportedAt: 1_700_000_123_456 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("removes derived evidence when a source is deleted or no longer eligible", async () => {
    await setActiveRagOwner("0xpolicy-reconcile");
    await replaceDocument(replacement("0xpolicy-reconcile"));
    await setShelbyBlobInventory("0xpolicy-reconcile", ["sach.pdf"], ["sach.pdf"]);
    expect(await searchDocuments("Dương Bố", 2)).toHaveLength(1);

    await setShelbyBlobInventory("0xpolicy-reconcile", ["sach.pdf"], []);

    expect(getRagSources()).toHaveLength(0);
    expect(await searchDocuments("Dương Bố", 2)).toHaveLength(0);
    expect((await exportPortableRagPackage({ exportedAt: 10 })).documents).toHaveLength(0);
  });

  it("fails closed during an unverified policy refresh without deleting local evidence", async () => {
    await setActiveRagOwner("0xpolicy-offline");
    await replaceDocument(replacement("0xpolicy-offline"));
    await setShelbyBlobInventory("0xpolicy-offline", ["sach.pdf"], ["sach.pdf"]);
    await invalidateShelbyBlobInventory("0xpolicy-offline");
    expect(await searchDocuments("Dương Bố", 2)).toHaveLength(0);

    await setShelbyBlobInventory("0xpolicy-offline", ["sach.pdf"], ["sach.pdf"]);
    expect(await searchDocuments("Dương Bố", 2)).toHaveLength(1);
  });

  it("searches a Shelby snapshot on demand without restoring it to IndexedDB", async () => {
    await setActiveRagOwner("0xremote-source");
    await replaceDocument(replacement("0xremote-source", "Shelby hot storage cho phép đọc kho tri thức theo nhu cầu"));
    const portable = await exportPortableRagPackage();
    await setActiveRagOwner("0xremote-reader");
    setRemoteRagProvider({ id: "remote-fixture", load: async () => portable });
    try {
      expect(getRagSources()).toHaveLength(0);
      const [result] = await searchDocuments("hot storage kho tri thức", 4);
      expect(result).toMatchObject({ source: "sach.pdf", method: "lexical" });
      expect(result.provenance?.owner).toBe("0xremote-source");
      expect(getRagSources()).toHaveLength(0);
    } finally {
      setRemoteRagProvider(null);
    }
  });

  it("still queries Shelby when local search already fills the result limit", async () => {
    await setActiveRagOwner("0xmerge-local-remote");
    await replaceDocument(replacement("0xmerge-local-remote", "kết quả local gần đúng"));
    setRemoteRagProvider({
      id: "remote-better-match",
      mode: "hot",
      search: async () => [{
        method: "lexical",
        documentId: "remote:answer.pdf",
        source: "answer.pdf",
        displayName: "answer.pdf",
        pageNumber: 1,
        totalPages: 1,
        excerpt: "kết quả chính xác từ Shelby",
        score: 10,
      }],
    });
    try {
      const result = await searchDocuments("kết quả", 1);
      expect(result[0]).toMatchObject({ source: "answer.pdf", excerpt: "kết quả chính xác từ Shelby" });
    } finally {
      setRemoteRagProvider(null);
    }
  });

  it("keeps valid local results when a Shelby snapshot read fails", async () => {
    await setActiveRagOwner("0xremote-fallback");
    await replaceDocument(replacement("0xremote-fallback", "nội dung dự phòng trên máy"));
    setRemoteRagProvider({ id: "broken-remote", mode: "hot", search: async () => { throw new Error("range read failed"); } });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const [result] = await searchDocuments("nội dung dự phòng", 2);
      expect(result?.excerpt).toContain("dự phòng trên máy");
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      setRemoteRagProvider(null);
    }
  });

  it("erases only the active wallet's local RAG evidence", async () => {
    await setActiveRagOwner("0xclear-a");
    await replaceDocument(replacement("0xclear-a"));
    await setActiveRagOwner("0xclear-b");
    await replaceDocument(replacement("0xclear-b"));

    await setActiveRagOwner("0xclear-a");
    await clearActiveRagWorkspace();
    expect(getRagSources()).toHaveLength(0);

    await setActiveRagOwner("0xclear-b");
    expect(getRagSources()).toMatchObject([{ source: "sach.pdf", title: "Cổ học tinh hoa" }]);
  });

  it("does not clear the new wallet when an old wallet cleanup finishes late", async () => {
    await setActiveRagOwner("0xlate-clear-a");
    await replaceDocument(replacement("0xlate-clear-a"));
    await setActiveRagOwner("0xlate-clear-b");
    await replaceDocument(replacement("0xlate-clear-b", "dữ liệu ví B vẫn còn"));

    expect(await clearActiveRagWorkspace("0xlate-clear-a")).toBe(false);
    expect(getRagSources()).toHaveLength(1);
    expect((await searchDocuments("dữ liệu ví B", 1))[0]?.excerpt).toContain("ví B vẫn còn");
  });
});
