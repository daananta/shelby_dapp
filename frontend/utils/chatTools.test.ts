import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { invalidateShelbyBlobInventory, replaceDocument, setActiveRagOwner, setShelbyBlobInventory } from "@/utils/ragOrama";
import { asksForLiveBlobInventoryRefresh, isBlobInventoryAnswerConsistent, isBlobInventoryConfirmationFollowUp, readBlobInventory, runChatTool } from "@/utils/chatTools";

describe("chat tools", () => {
  it("recognizes only narrow inventory confirmation follow-ups", () => {
    expect(isBlobInventoryConfirmationFollowUp("chắc chưa?")).toBe(true);
    expect(isBlobInventoryConfirmationFollowUp("Kiểm tra lại đi")).toBe(true);
    expect(isBlobInventoryConfirmationFollowUp("Are you sure?")).toBe(true);
    expect(isBlobInventoryConfirmationFollowUp("Thời tiết hôm nay thế nào?")).toBe(false);
  });

  it("recognizes explicit requests for a live inventory refresh", () => {
    expect(asksForLiveBlobInventoryRefresh("Kiểm tra số blob hiện tại")).toBe(true);
    expect(asksForLiveBlobInventoryRefresh("Refresh my wallet blob count")).toBe(true);
    expect(asksForLiveBlobInventoryRefresh("Ví này có bao nhiêu blob?")).toBe(false);
  });

  it("routes an explicit live wallet inventory request to the inventory tool", async () => {
    const owner = "0xlive-inventory-test";
    await setActiveRagOwner(owner);
    await setShelbyBlobInventory(owner, ["one.txt", "two.pdf"]);

    const result = await runChatTool("Kiểm tra số blob hiện tại của ví tôi");

    expect(result).toMatchObject({
      name: "blob_inventory",
      data: { count: 2, status: "verified" },
    });
  });

  it("stops before hydrating tools when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runChatTool("Có bao nhiêu blob?", undefined, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not mistake a network-wide Shelby question for this wallet's inventory", async () => {
    await setActiveRagOwner("0xnetwork-question-test");
    await setShelbyBlobInventory("0xnetwork-question-test", ["private-note.txt"]);
    expect(await runChatTool("Shelby có bao nhiêu blob trên toàn mạng?")).toBeNull();
    expect((await runChatTool("Ví tôi có bao nhiêu blob?"))?.text).toContain("1 blob");
    expect(await runChatTool("How many blobs exist across the entire Shelby network?", undefined, { language: "en" })).toBeNull();
    expect((await runChatTool("How many blobs does my wallet have?", undefined, { language: "en" }))?.text).toContain("1 blob");
  });

  it("returns only the requested inventory detail", async () => {
    const owner = "0xinventory-summary-test";
    const names = ["one.pdf", "two.png", "three.txt", "four.mp4", "five.zip"];
    await setActiveRagOwner(owner);
    await setShelbyBlobInventory(owner, names);

    const summary = await runChatTool("Ví tôi có bao nhiêu blob?");
    expect(summary).toMatchObject({
      name: "blob_inventory",
      data: {
        kind: "blob_inventory",
        status: "verified",
        count: 5,
        examples: [],
      },
    });
    expect(summary?.text).toContain("5 blob");
    expect(summary?.text).not.toContain("one.pdf");
    expect(summary?.data?.names).toBeUndefined();

    const sample = await runChatTool("Ví tôi có những blob nào?");
    expect(sample?.data?.examples).toEqual(names.slice(0, 3));
    expect(sample?.text).toContain("one.pdf");
    expect(sample?.text).not.toContain("four.mp4");
    expect(sample?.data?.names).toBeUndefined();

    const full = await runChatTool("Liệt kê tất cả blob của tôi");
    expect(full?.data?.names).toEqual(names);
    expect(full?.text).toContain("five.zip");
  });

  it("rejects model phrasing that changes a verified inventory count or examples", async () => {
    const owner = "0xinventory-answer-check";
    await setActiveRagOwner(owner);
    await setShelbyBlobInventory(owner, ["one.pdf", "two.png"]);
    const count = readBlobInventory("count");
    const sample = readBlobInventory("sample");

    expect(isBlobInventoryAnswerConsistent(count, "Ví này có 2 blob.")).toBe(true);
    expect(isBlobInventoryAnswerConsistent(count, "Ví này có 3 blob.")).toBe(false);
    expect(isBlobInventoryAnswerConsistent(count, "Có 2 blob, không phải 3 blob.")).toBe(false);
    expect(isBlobInventoryAnswerConsistent(sample, "Có 2 blob, ví dụ one.pdf và two.png.")).toBe(true);
    expect(isBlobInventoryAnswerConsistent(sample, "Có 2 blob, ví dụ one.pdf.")).toBe(false);
  });

  it("does not present an invalidated inventory snapshot as current", async () => {
    const owner = "0xinventory-stale-test";
    await setActiveRagOwner(owner);
    await setShelbyBlobInventory(owner, ["cached.pdf"]);
    await invalidateShelbyBlobInventory(owner);

    const result = await runChatTool("Ví tôi có bao nhiêu blob?");
    expect(result?.data).toMatchObject({ status: "stale", count: 1 });
    expect(result?.text).toContain("chưa thể xác nhận số hiện tại");
  });

  it("does not call an old successful snapshot current", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-30T00:00:00Z").getTime());
    try {
      const owner = "0xinventory-old-test";
      await setActiveRagOwner(owner);
      await setShelbyBlobInventory(owner, ["cached.pdf"]);
      now.mockReturnValue(new Date("2026-07-30T00:06:00Z").getTime());

      const result = await runChatTool("Ví tôi có bao nhiêu blob?");

      expect(result?.data).toMatchObject({ status: "stale", freshness: "stale_cache", count: 1 });
      expect(result?.text).toContain("Snapshot này có thể đã cũ");
    } finally {
      now.mockRestore();
    }
  });

  it("shows the image and its indexed description instead of sending its filename to an LLM", async () => {
    const owner = "0ximage-tool-test";
    const documentId = `${owner}:cover.jpg`;
    await setActiveRagOwner(owner);
    await setShelbyBlobInventory(owner, ["cover.jpg"]);
    await replaceDocument({
      manifest: { id: documentId, owner, source: "cover.jpg", displayName: "cover.jpg", revision: "test", blobUrl: "https://example.test/cover.jpg", mimeType: "image/jpeg", type: "image", aliases: [], authors: [], pageCount: 0, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: 1 },
      pages: [],
      chunks: [{ id: `${documentId}:chunk:0`, owner, documentId, source: "cover.jpg", displayName: "cover.jpg", type: "image", text: "[Hình ảnh] Tên file: cover.jpg\n\nMô tả AI: Một chiếc xe thể thao màu đỏ trên cầu cùng các nhân vật anime.", normalizedText: "ảnh", pageNumber: 0, totalPages: 0, imageUrl: "https://example.test/cover.jpg" }],
      stories: [],
    });
    const result = await runChatTool("tôi có ảnh không, mô tả");
    expect(result).toMatchObject({ name: "show_images", imageUrls: ["https://example.test/cover.jpg"] });
    expect(result?.text).toContain("chiếc xe thể thao màu đỏ");

    const namedResult = await runChatTool("cover.jpg của tôi mô tả cái gì?");
    expect(namedResult).toMatchObject({ name: "show_images", imageUrls: ["https://example.test/cover.jpg"] });
    expect(namedResult?.text).toContain("chiếc xe thể thao màu đỏ");
  });

  it("returns an image preview for a filename even before cloud vision has described it", async () => {
    const owner = "0ximage-filename-test";
    const documentId = `${owner}:moai.webp`;
    await setActiveRagOwner(owner);
    await replaceDocument({
      manifest: { id: documentId, owner, source: "moai.webp", displayName: "moai.webp", revision: "test", blobUrl: "https://example.test/moai.webp", mimeType: "image/webp", type: "image", aliases: [], authors: [], pageCount: 0, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: 1 },
      pages: [],
      chunks: [{ id: `${documentId}:chunk:0`, owner, documentId, source: "moai.webp", displayName: "moai.webp", type: "image", text: "[Hình ảnh] Tên file: moai.webp. Chưa có mô tả.", normalizedText: "moai", pageNumber: 0, totalPages: 0, imageUrl: "https://example.test/moai.webp" }],
      stories: [],
    });
    const result = await runChatTool("moai.webp của tôi mô tả cái gì?");
    expect(result).toMatchObject({ name: "show_images", imageUrls: ["https://example.test/moai.webp"] });
    expect(result?.text).toContain("Chưa có mô tả đáng tin cậy");
  });

  it("uses a Cloud-resolved source without local pronoun parsing", async () => {
    const owner = "0ximage-follow-up-test";
    const documentId = `${owner}:anime2.jpeg`;
    await setActiveRagOwner(owner);
    await replaceDocument({
      manifest: { id: documentId, owner, source: "anime2.jpeg", displayName: "anime2.jpeg", revision: "test", blobUrl: "https://example.test/anime2.jpeg", mimeType: "image/jpeg", type: "image", aliases: [], authors: [], pageCount: 0, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: 1 },
      pages: [],
      chunks: [{ id: `${documentId}:chunk:0`, owner, documentId, source: "anime2.jpeg", displayName: "anime2.jpeg", type: "image", text: "[Hình ảnh] Tên file: anime2.jpeg\n\nMô tả AI: Một nhân vật anime đứng dưới bầu trời đêm.", normalizedText: "anime", pageNumber: 0, totalPages: 0, imageUrl: "https://example.test/anime2.jpeg" }],
      stories: [],
    });

    const first = await runChatTool("blob anime2.jpeg là gì");
    expect(first?.referencedSources).toEqual(["anime2.jpeg"]);
    const followUp = await runChatTool("hãy phân tích đối tượng vừa được đề cập", undefined, { preferredSources: first?.referencedSources, forceImage: true, forceImageDescription: true });
    expect(followUp).toMatchObject({ name: "show_images", referencedSources: ["anime2.jpeg"] });
    expect(followUp?.text).toContain("nhân vật anime");
    expect(followUp?.text).not.toContain("AGENTS.md");
  });

  it("does not let book inventory swallow a numbered-story request", async () => {
    await setActiveRagOwner("0xstory-tool-test");
    await setShelbyBlobInventory("0xstory-tool-test", ["sach.pdf"]);
    expect(await runChatTool("tôi có sách ko, kể câu chuyện thứ 112 trong sách")).toBeNull();
  });

  it("answers a page-count question from the persisted page index, without an LLM", async () => {
    const owner = "0xpage-count-tool-test";
    const documentId = `${owner}:co-hoc-tinh-hoa.pdf`;
    await setActiveRagOwner(owner);
    await replaceDocument({
      manifest: { id: documentId, owner, source: "co-hoc-tinh-hoa.pdf", displayName: "co-hoc-tinh-hoa.pdf", revision: "test", mimeType: "application/pdf", type: "text", title: { value: "Cổ học tinh hoa", confidence: 1, provenance: "user", userLocked: true }, aliases: ["co hoc"], authors: [], pageCount: 351, chunkCount: 1, ocrCoverage: 1, textCoverage: 0.98, embeddingStatus: "unavailable", status: "indexed", indexedAt: 1 },
      pages: [{ id: `${documentId}:page:1`, owner, documentId, source: "co-hoc-tinh-hoa.pdf", displayName: "co-hoc-tinh-hoa.pdf", pageNumber: 1, totalPages: 351, rawText: "Nội dung", normalizedText: "nội dung", extractionMethod: "text_layer" }],
      chunks: [{ id: `${documentId}:chunk:0`, owner, documentId, source: "co-hoc-tinh-hoa.pdf", displayName: "co-hoc-tinh-hoa.pdf", type: "text", text: "Nội dung", normalizedText: "nội dung", pageNumber: 1, totalPages: 351 }],
      stories: [],
    });
    const result = await runChatTool("Sách Cổ học tinh hoa bao nhiêu trang?");
    expect(result).toMatchObject({ name: "document_lookup" });
    expect(result?.text).toContain("351 trang");
    expect(result?.text).toContain("98% số trang");

    const english = await runChatTool("How many pages does the book Cổ học tinh hoa have?", undefined, { language: "en" });
    expect(english).toMatchObject({ name: "document_lookup" });
    expect(english?.text).toContain("351 pages");
    expect(english?.text).toContain("98% of its pages");
  });
});
