import type { RagInputKind } from "@/utils/ragInput";
import { localize } from "@/i18n";

export interface DetectedRagContent {
  kind: RagInputKind;
  mimeType: string;
  format: string;
  confidence: "high" | "medium" | "low";
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (!bytes.length) return true;
  let control = 0;
  let zero = 0;
  for (const byte of bytes) {
    if (byte === 0) zero += 1;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return zero / bytes.length < 0.01 && control / bytes.length < 0.03;
}

function textFormat(sample: string): Pick<DetectedRagContent, "mimeType" | "format"> {
  const trimmed = sample.replace(/^\uFEFF/, "").trimStart();
  if (/^(?:\{|\[)/.test(trimmed)) return { mimeType: "application/json", format: "JSON" };
  if (/^<!doctype\s+html|^<html\b/i.test(trimmed)) return { mimeType: "text/html", format: "HTML" };
  if (/^<\?xml\b/i.test(trimmed)) return { mimeType: "application/xml", format: "XML" };
  return { mimeType: "text/plain", format: "TEXT" };
}

/**
 * Shelby stores opaque bytes, so ingestion must inspect the payload itself.
 * Blob names are deliberately not used as a source of truth here.
 */
export async function sniffRagContent(blob: Blob): Promise<DetectedRagContent> {
  const bytes = new Uint8Array(await blob.slice(0, 16_384).arrayBuffer());

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { kind: "document", mimeType: "application/pdf", format: "PDF", confidence: "high" };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", mimeType: "image/png", format: "PNG", confidence: "high" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mimeType: "image/jpeg", format: "JPEG", confidence: "high" };
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { kind: "image", mimeType: "image/gif", format: "GIF", confidence: "high" };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { kind: "image", mimeType: "image/webp", format: "WEBP", confidence: "high" };
  }
  if (String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    return { kind: "video", mimeType: "video/mp4", format: "MP4 VIDEO", confidence: "high" };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return { kind: "unsupported", mimeType: "application/zip", format: "ZIP/OFFICE", confidence: "high" };
  }

  if (looksLikeText(bytes)) {
    const sample = utf8.decode(bytes);
    const detected = textFormat(sample);
    if (detected.mimeType === "application/json") {
      try {
        const value = JSON.parse(await blob.text()) as { format?: unknown; version?: unknown };
        if (value?.format === "shelby-rag-package" && value?.version === 1) {
          return { kind: "package", mimeType: "application/json", format: "SHELBY RAG", confidence: "high" };
        }
        if (value?.format === "shelby-hot-rag-manifest" && value?.version === 1) {
          return { kind: "package", mimeType: "application/json", format: "SHELBY HOT RAG", confidence: "high" };
        }
      } catch {
        // Malformed JSON is still searchable as text; the parser must not trust its extension.
      }
    }
    return { kind: "document", ...detected, confidence: "medium" };
  }

  return { kind: "unsupported", mimeType: "application/octet-stream", format: "BINARY", confidence: "low" };
}

export function unsupportedContentReason(content: DetectedRagContent): string {
  if (content.format === "ZIP/OFFICE") {
    return localize(
      "This file type is not supported yet. The ZIP/Office data remains safe on Shelby, but the app does not yet have the right unpacker to make it searchable.",
      "Chưa hỗ trợ loại tệp này. Dữ liệu ZIP/Office vẫn an toàn trên Shelby nhưng ứng dụng chưa có bộ giải nén phù hợp để tạo nội dung tìm kiếm.",
    );
  }
  return localize(
    "This file type is not supported yet. The data remains safe on Shelby, but the app could not identify a format it can make searchable.",
    "Chưa hỗ trợ loại tệp này. Dữ liệu vẫn an toàn trên Shelby nhưng ứng dụng chưa xác định được định dạng để tạo nội dung tìm kiếm.",
  );
}
