export type QueryIntent =
  | "general"
  | "wallet"
  | "inventory"
  | "metadata"
  | "exact_quote"
  | "page_lookup"
  | "story_lookup"
  | "image"
  | "document_semantic"
  | "summarize_study_guide";

export interface RoutedQuery {
  intent: QueryIntent;
  quotedText?: string;
  documentScoped: boolean;
}

const OWNED_DATA_CUE = /(?:\bmy\b|\bmine\b|\bi (?:have|uploaded|indexed|stored)\b|\bthis (?:blob|file|document|pdf|book|image|photo)\b|\bthe (?:blob|file|document|pdf|book|image|photo) i (?:uploaded|indexed|stored)\b|của\s+(?:tôi|mình)|tôi\s+(?:có|đã\s+(?:nạp|tải|lưu))|mình\s+(?:có|đã\s+(?:nạp|tải|lưu))|(?:blob|tệp|file|pdf|sách|tài liệu|ảnh|hình).*(?:đã nạp|đã tải|của tôi|của mình)|kho (?:dữ liệu|tri thức).*(?:của tôi|của mình)|\bmy (?:wallet|library|knowledge base)\b)/i;
const DOCUMENT_LOCATION_CUE = /(?:(?:in|inside|from|according to)\s+(?:my|this|the)?\s*(?:blob|file|document|pdf|book|knowledge base)|(?:trong|từ|theo)\s+(?:blob|tệp|file|pdf|sách|tài liệu|kho dữ liệu|kho tri thức))/i;

export function extractQuotedText(question: string): string | undefined {
  const matches = [...question.matchAll(/["“”'‘’]([^"“”'‘’]{8,})["“”'‘’]/g)];
  return matches.sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))[0]?.[1]?.trim();
}

export function classifyQueryIntent(question: string): RoutedQuery {
  const normalized = question.normalize("NFC").toLocaleLowerCase("vi-VN").trim();
  const quotedText = extractQuotedText(question);
  const ownedDataCue = OWNED_DATA_CUE.test(normalized);
  const documentLocationCue = DOCUMENT_LOCATION_CUE.test(normalized);
  if (quotedText && /(trang nào|ở trang|nằm.*trang|tìm.*trang|which page|what page|page number|find.*page|where.*page)/i.test(normalized)) {
    return { intent: "page_lookup", quotedText, documentScoped: true };
  }
  if (quotedText && /tìm.*(?:nguyên văn|câu)|(?:câu|đoạn|trích dẫn).*(?:có|nằm|xuất hiện).*(?:tài liệu|tệp|file|sách|pdf)|(?:trong|thuộc).*(?:tài liệu|tệp|file|sách|pdf).*nào|đối chiếu.*(?:câu|trích dẫn)|find.*(?:exact|quote|sentence)|does.*(?:appear|occur).*(?:document|file|book|pdf)|which.*(?:document|file|book|pdf).*(?:contains?|has)|verify.*(?:quote|sentence)/i.test(normalized)) {
    return { intent: "exact_quote", quotedText, documentScoped: true };
  }
  if (/(địa chỉ.*ví|ví.*địa chỉ|wallet address|số dư|balance|sequence number|authentication key|shelby[\s_-]*usd)/i.test(normalized)) {
    return { intent: "wallet", documentScoped: false };
  }
  if (/(câu chuyện|truyện)\s*(?:số|thứ)?\s*\d{1,4}|(tổng|bao nhiêu|mấy)\s+câu chuyện|\bstory\s*(?:number|no\.?|#)?\s*\d{1,4}\b|how many stories/i.test(normalized)) {
    return { intent: "story_lookup", documentScoped: true };
  }
  if (/(tên|tựa|tác giả|dài bao nhiêu trang|bao nhiêu trang|title|author|how many pages|page count).*(sách|pdf|tài liệu|book|document)|(sách|pdf|tài liệu|book|document).*(tên|tựa|tác giả|bao nhiêu trang|title|author|how many pages|page count)/i.test(normalized)) {
    return { intent: "metadata", documentScoped: true };
  }
  if (/(liệt kê|danh sách|bao nhiêu|mấy|list|show|how many|which).*(blob|tệp|files?|documents?)|(?:kiểm tra|làm mới|cập nhật|check|refresh|update).*(?:blob|tệp|files?)|(?:do i have|tôi|mình).*(?:có|những|have).*(sách|pdf|ảnh|hình|books?|images?|photos?)|^(?:my|của tôi|của mình)\s+(?:blobs?|files?|documents?|books?|pdfs?|images?|photos?)\??$/i.test(normalized)) {
    return { intent: "inventory", documentScoped: true };
  }
  if (/(tóm tắt|summarize|study guide|đề cương|bản tóm tắt|tổng hợp)/i.test(normalized) && (ownedDataCue || documentLocationCue || /(?:tài liệu|đã nạp|indexed documents?|knowledge base)/i.test(normalized))) {
    return { intent: "summarize_study_guide", documentScoped: true };
  }
  // A Shelby blob name is often the only way a visitor refers to an image.
  // Treat it as image intent even when Vietnamese words like “ảnh” are absent.
  if (/\.(?:avif|gif|jpe?g|png|webp)(?:\s|$|[?!,.)])/i.test(normalized)) {
    return { intent: "image", documentScoped: true };
  }
  if (/(ảnh|hình|photo|image)/i.test(normalized) && (ownedDataCue || documentLocationCue || /(?:mô tả|xem|hiển thị|mở|describe|show|display|open).*(?:ảnh|hình|photo|image)|(?:ảnh|hình|photo|image).*(?:đã nạp|đã tải|uploaded|indexed)/i.test(normalized))) {
    return { intent: "image", documentScoped: true };
  }
  if ((ownedDataCue || documentLocationCue) && /(sách|pdf|tài liệu|blob|tệp|file|trang|câu chuyện|truyện|kho dữ liệu|book|document|page|story|knowledge base)/i.test(normalized)) {
    return { intent: "document_semantic", documentScoped: true };
  }
  return { intent: "general", documentScoped: false };
}
