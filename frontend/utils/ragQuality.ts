import type { RagSource } from "@/utils/ragOrama";
import { localize } from "@/i18n";

export interface RagQualityAssessment {
  state: "empty" | "ready" | "attention";
  indexedDocuments: number;
  warnings: string[];
}

/**
 * Conservative client-side quality gate. It never infers that a source is
 * answerable merely because an index record exists.
 */
export function assessRagQuality(sources: RagSource[]): RagQualityAssessment {
  const indexed = sources.filter((source) => source.status === "indexed");
  const warnings: string[] = [];
  for (const source of sources.filter((item) => item.status !== "indexed")) {
    const name = source.titleMetadata?.userLocked || (source.titleMetadata?.confidence ?? 0) >= 0.8 ? source.title ?? source.displayName : source.displayName;
    if (source.status === "failed") warnings.push(localize(
      `${name}: processing failed — ${source.error ?? "no error details"}`,
      `${name}: nạp thất bại — ${source.error ?? "không có chi tiết lỗi"}`,
    ));
    if (source.status === "upgrade_required") warnings.push(localize(`${name}: the old index needs to be rebuilt.`, `${name}: chỉ mục cũ cần được tạo lại.`));
  }
  if (!indexed.length) return {
    state: warnings.length ? "attention" : "empty",
    indexedDocuments: 0,
    warnings: warnings.length ? warnings : [localize("No indexed document evidence is available yet.", "Chưa có tài liệu đã index để kiểm chứng evidence.")],
  };
  for (const source of indexed) {
    const name = source.titleMetadata?.userLocked || (source.titleMetadata?.confidence ?? 0) >= 0.8 ? source.title ?? source.displayName : source.displayName;
    if (source.type === "text" && (!source.pageCount || !source.chunks)) {
      warnings.push(localize(`${name}: no page or chunk evidence is available for a reliable answer.`, `${name}: chưa có page/chunk evidence để trả lời đáng tin cậy.`));
      continue;
    }
    if (source.type === "text" && source.textCoverage !== undefined && source.textCoverage < 0.75) {
      const recommendation = source.ocrCoverage === undefined || source.ocrCoverage < 0.99
        ? localize(" Enable full-page OCR, then update RAG.", " Hãy bật OCR toàn bộ rồi Cập nhật RAG.")
        : localize(" OCR ran, but some pages still contain little text; inspect the original PDF.", " OCR đã chạy nhưng trang vẫn ít text; hãy kiểm tra PDF gốc.");
      warnings.push(localize(
        `${name}: readable content was found on only ${Math.round(source.textCoverage * 100)}% of its pages.${recommendation}`,
        `${name}: chỉ đọc được ${Math.round(source.textCoverage * 100)}% số trang.${recommendation}`,
      ));
    }
    if (source.type === "text" && (source.pageCount ?? 0) > 2 && source.chunks === 1) {
      warnings.push(localize(
        `${name}: this multi-page document produced only 1 chunk; check text coverage and OCR.`,
        `${name}: tài liệu nhiều trang nhưng chỉ tạo được 1 chunk; hãy kiểm tra text coverage/OCR.`,
      ));
    }
    if (source.type === "text" && source.embeddingStatus === "failed") {
      warnings.push(localize(
        `${name}: semantic search data could not be created. Keyword search still works; check the Gemini API key or quota, then update RAG.`,
        `${name}: chưa tạo được tìm kiếm theo ý nghĩa. Bạn vẫn có thể tìm bằng từ khóa; hãy kiểm tra Gemini API key/quota rồi cập nhật lại.`,
      ));
    }
  }
  return { state: warnings.length ? "attention" : "ready", indexedDocuments: indexed.length, warnings };
}
