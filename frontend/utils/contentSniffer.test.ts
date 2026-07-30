import { describe, expect, it } from "vitest";
import { sniffRagContent } from "@/utils/contentSniffer";

describe("content-based Shelby blob detection", () => {
  it("detects a PDF even when the blob name has no useful extension", async () => {
    const result = await sniffRagContent(new Blob(["%PDF-1.7\nopaque bytes"]));
    expect(result).toMatchObject({ kind: "document", mimeType: "application/pdf", format: "PDF" });
  });

  it("does not trust a misleading file suffix", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
    expect(await sniffRagContent(png)).toMatchObject({ kind: "image", mimeType: "image/png" });
  });

  it.each([
    ["JPEG", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    ["GIF", [0x47, 0x49, 0x46, 0x38], "image/gif"],
    ["WEBP", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
  ])("recognizes %s image bytes after a time lock has opened", async (_format, signature, mimeType) => {
    expect(await sniffRagContent(new Blob([new Uint8Array(signature)]))).toMatchObject({ kind: "image", mimeType });
  });

  it("recognizes portable RAG packages from their payload", async () => {
    const value = JSON.stringify({ format: "shelby-rag-package", version: 1, documents: [] });
    expect(await sniffRagContent(new Blob([value]))).toMatchObject({ kind: "package", format: "SHELBY RAG" });
  });

  it("recognizes the lightweight Hot RAG manifest", async () => {
    const value = JSON.stringify({ format: "shelby-hot-rag-manifest", version: 1, snapshotId: "fixture", documents: [], shards: [] });
    expect(await sniffRagContent(new Blob([value]))).toMatchObject({ kind: "package", format: "SHELBY HOT RAG" });
  });

  it("fails safely for opaque binary data", async () => {
    const result = await sniffRagContent(new Blob([new Uint8Array([0, 1, 2, 3, 4, 5, 255])]));
    expect(result).toMatchObject({ kind: "unsupported", mimeType: "application/octet-stream" });
  });

  it("routes MP4 bytes to the video pipeline", async () => {
    const mp4 = new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])]);
    expect(await sniffRagContent(mp4)).toMatchObject({ kind: "video", mimeType: "video/mp4", format: "MP4 VIDEO" });
  });

  it("does not misroute an AVIF image container to the MP4 video pipeline", async () => {
    const avif = new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])]);
    expect(await sniffRagContent(avif)).toMatchObject({ kind: "unsupported", mimeType: "image/avif", format: "AVIF/HEIF" });
  });
});
