import { localize } from "@/i18n";

export type RagInputKind = "package" | "image" | "video" | "document" | "unsupported";

const IMAGE_EXTENSION = /\.(?:jpg|jpeg|png|gif|webp)$/i;
const VIDEO_EXTENSION = /\.(?:mp4|m4v|mov)$/i;
const DOCUMENT_EXTENSION = /\.(?:pdf|txt|md|markdown|csv|tsv|json|jsonl|html?|xml|ya?ml)$/i;

export function getRagInputKind(blobName: string): RagInputKind {
  if (/\.shelby-rag\.json$/i.test(blobName) || /\.shelby-hot-rag\.json$/i.test(blobName)) return "package";
  if (IMAGE_EXTENSION.test(blobName)) return "image";
  if (VIDEO_EXTENSION.test(blobName)) return "video";
  if (DOCUMENT_EXTENSION.test(blobName)) return "document";
  return "unsupported";
}

export function unsupportedRagInputReason(blobName: string): string {
  const extension = blobName.split(".").pop()?.toUpperCase();
  return extension
    ? localize(
      `.${extension} is not supported yet. The blob was skipped instead of being misread as text.`,
      `Định dạng .${extension} chưa được hỗ trợ. Blob được bỏ qua thay vì đọc nhầm thành văn bản.`,
    )
    : localize(
      "This blob does not match a supported document, image, or video format, so it was skipped.",
      "Blob không khớp định dạng tài liệu, ảnh hoặc video được hỗ trợ nên đã được bỏ qua.",
    );
}
