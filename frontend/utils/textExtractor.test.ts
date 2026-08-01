import { describe, expect, it, vi } from "vitest";

const pdfMocks = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdfMocks.getDocument,
}));

import { chunkText, extractSinglePageFromUrl, extractSourceMapText, inferDocumentMetadata, isUsefulExtractedText, normalizeSearchText } from "@/utils/textExtractor";

const pages = [
  { pageNumber: 1, totalPages: 351, text: "https://thuviensach.vn" },
  { pageNumber: 2, totalPages: 351, text: "TIỂU TỰ Đây là phần mở đầu của sách" },
];

describe("document metadata", () => {
  it("does not promote an inner heading to the book title", () => {
    expect(inferDocumentMetadata(pages, "sach.pdf").title).toBeUndefined();
  });

  it("prefers cover OCR and preserves a user override", () => {
    expect(inferDocumentMetadata(pages, "sach.pdf", "CỔ HỌC TINH HOA").title).toMatchObject({ value: "Cổ học tinh hoa", provenance: "local_ocr" });
    const locked = { value: "Tên do tôi đặt", confidence: 1, provenance: "user" as const, userLocked: true };
    expect(inferDocumentMetadata(pages, "sach.pdf", "CỔ HỌC TINH HOA", { title: "Tên cloud" }, locked).title).toEqual(locked);
  });

  it("normalizes Vietnamese Unicode and whitespace", () => {
    expect(normalizeSearchText("  NGƯỜI   ấy\n thấy Dương Bố  ")).toBe("người ấy thấy dương bố");
  });

  it("keeps every chunk within the configured bound for long scan-like text", () => {
    const chunks = chunkText(`Bắt đầu ${"rất dài ".repeat(80)}kết thúc`, 120, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
    expect(chunks.at(-1)).toContain("kết thúc");
  });

  it("hard-splits a single token that has no whitespace", () => {
    const chunks = chunkText("x".repeat(310), 120, 20);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
    expect(chunks.join("").length).toBeGreaterThanOrEqual(310);
  });

  it("extracts useful source-map content without indexing encoded mappings", () => {
    const result = extractSourceMapText(JSON.stringify({ version: 3, file: "index.js", sources: ["src/app.ts"], sourcesContent: ["export const answer = 42;"], names: ["answer"], mappings: "AAAA,MAAM" }), "index.js.map");
    expect(result).toContain("src/app.ts");
    expect(result).toContain("export const answer = 42;");
    expect(result).not.toContain("AAAA,MAAM");
  });

  it("flags a long but repetitive PDF text layer as OCR-worthy", () => {
    expect(isUsefulExtractedText("AAAA ".repeat(80))).toBe(false);
    expect(isUsefulExtractedText("Trí tuệ của người xưa được kể lại qua nhiều câu chuyện xử án, ứng xử và đạo lý trong đời sống.")).toBe(true);
  });

  it("passes authenticated Shelby headers to PDF.js when rereading receipt evidence", async () => {
    const cleanup = vi.fn();
    const destroy = vi.fn();
    pdfMocks.getDocument.mockReturnValue({
      destroy: vi.fn(),
      promise: Promise.resolve({
        numPages: 1,
        destroy,
        getPage: vi.fn().mockResolvedValue({
          cleanup,
          getTextContent: vi.fn().mockResolvedValue({ items: [{ str: "Shelby evidence" }] }),
        }),
      }),
    });

    await expect(extractSinglePageFromUrl(
      "https://api.testnet.shelby.xyz/blob.pdf",
      "blob.pdf",
      1,
      "application/pdf",
      undefined,
      { Authorization: "Bearer AG-test-client" },
    )).resolves.toMatchObject({ pageNumber: 1, text: "Shelby evidence" });

    expect(pdfMocks.getDocument).toHaveBeenCalledWith({
      url: "https://api.testnet.shelby.xyz/blob.pdf",
      httpHeaders: { Authorization: "Bearer AG-test-client" },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys a failed PDF loading task used by receipt verification", async () => {
    const destroyLoadingTask = vi.fn();
    pdfMocks.getDocument.mockReturnValue({
      destroy: destroyLoadingTask,
      promise: Promise.reject(new Error("PDF unavailable")),
    });

    await expect(extractSinglePageFromUrl(
      "https://api.testnet.shelby.xyz/blob.pdf",
      "blob.pdf",
      1,
      "application/pdf",
    )).rejects.toThrow("PDF unavailable");

    expect(destroyLoadingTask).toHaveBeenCalledOnce();
  });
});
