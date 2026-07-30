import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { replaceDocument, setActiveRagOwner, setShelbyBlobInventory } from "@/utils/ragOrama";
import { runChatTool } from "@/utils/chatTools";

describe("chat tools", () => {
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
