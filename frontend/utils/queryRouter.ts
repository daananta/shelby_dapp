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

export function asksForLiveInventoryRefresh(question: string): boolean {
  return /(?:làm mới|đồng bộ lại|cập nhật lại|kiểm tra lại|mới nhất|hiện tại|ngay bây giờ|refresh|sync again|check again|latest|current|right now)/i.test(question);
}

const OWNED_DATA_CUE = /(?:\bmy\b|\bmine\b|\bi (?:have|uploaded|indexed|stored)\b|\bthis (?:blob|file|document|pdf|book|image|photo)\b|\bthe (?:blob|file|document|pdf|book|image|photo) i (?:uploaded|indexed|stored)\b|của\s+(?:tôi|mình)|tôi\s+(?:có|đã\s+(?:nạp|tải|lưu))|mình\s+(?:có|đã\s+(?:nạp|tải|lưu))|(?:blob|tệp|file|pdf|sách|tài liệu|ảnh|hình).*(?:đã nạp|đã tải|của tôi|của mình)|kho (?:dữ liệu|tri thức).*(?:của tôi|của mình)|\bmy (?:wallet|library|knowledge base)\b)/i;
const DOCUMENT_LOCATION_CUE = /(?:(?:in|inside|from|according to)\s+(?:my|this|the)?\s*(?:blob|file|document|pdf|book|knowledge base)|(?:trong|từ|theo)\s+(?:blob|tệp|file|pdf|sách|tài liệu|kho dữ liệu|kho tri thức))/i;
const CONCRETE_FILE_CUE = /(?:^|[\s"'“”‘’])[^\s/\\"'“”‘’]{1,120}\.(?:csv|docx?|html?|json|md|pdf|toml|tsx?|jsx?|txt|xml|ya?ml)(?:$|[\s?!,.)"'“”‘’])/i;

export function extractQuotedText(question: string): string | undefined {
  const matches = [...question.matchAll(/["“”'‘’]([^"“”'‘’]{8,})["“”'‘’]/g)];
  return matches.sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0))[0]?.[1]?.trim();
}

export function classifyQueryIntent(question: string): RoutedQuery {
  const normalized = question.normalize("NFC").toLocaleLowerCase("vi-VN").trim();
  const quotedText = extractQuotedText(question);
  const ownedDataCue = OWNED_DATA_CUE.test(normalized);
  const documentLocationCue = DOCUMENT_LOCATION_CUE.test(normalized);
  const concreteFileCue = CONCRETE_FILE_CUE.test(question);
  const asksForImageCollection = /(?:ảnh|hình|images?|photos?)/i.test(normalized)
    && /(?:đã nạp|đã tải|có sẵn|indexed|available|uploaded|stored|blobs?|\bmy\b|của tôi|của mình)/i.test(normalized)
    && /(?:liệt kê|danh sách|nào|xem|hiển thị|list|which|what|show|inspect|browse|enumerate|available)/i.test(normalized);
  const asksAboutVisibleImageDetails = /(?:what (?:is|can be) visible|what (?:do|can) you see|visible details?|visual details?|describe (?:what is in|the contents? of|this|that|the) (?:image|photo|picture)|what does .{0,120}\.(?:avif|gif|jpe?g|png|webp) depict|read (?:the )?text (?:in|on) (?:this|that|the) (?:image|photo|picture)|chi tiết (?:nhìn thấy|thị giác|trong ảnh)|nhìn thấy gì|mô tả (?:nội dung )?(?:ảnh|hình)|đọc (?:chữ|văn bản).*(?:ảnh|hình))/i.test(normalized);
  const walletScopeCue = /(?:\b(?:my|connected|current|this)\s+(?:aptos\s+)?wallet\b|\bmy\s+(?:apt|aptos|shelby[\s_-]*usd)\s+balance\b|\bwallet\s+(?:connected|in this app)\b|ví\s+(?:của tôi|của mình|tôi|mình|này|đang kết nối)|(?:của tôi|của mình).{0,30}(?:địa chỉ ví|số dư)|(?:địa chỉ ví|số dư).{0,30}(?:của tôi|của mình)|(?:which|what) wallet is connected)/i.test(normalized);
  const walletFactCue = /(?:wallet address|địa chỉ.*ví|ví.*địa chỉ|\b(?:apt|aptos|shelby[\s_-]*usd)\s+balance\b|số dư|sequence number|authentication key|(?:which|what) wallet is connected|ví đang kết nối)/i.test(normalized);
  const inventoryScopeCue = ownedDataCue
    || /(?:\b(?:my|this|connected)\s+(?:aptos\s+)?wallet\b|ví\s+(?:của tôi|của mình|tôi|mình|này|đang kết nối)|\bindexed\b|\buploaded\b|đã (?:nạp|tải)|trong (?:thư viện|kho dữ liệu|kho tri thức))/i.test(normalized);
  if (quotedText && /(trang nào|ở trang|nằm.*trang|tìm.*trang|which page|what page|page number|find.*page|where.*page)/i.test(normalized)) {
    return { intent: "page_lookup", quotedText, documentScoped: true };
  }
  if (quotedText && /tìm.*(?:nguyên văn|câu)|(?:câu|đoạn|trích dẫn).*(?:có|nằm|xuất hiện).*(?:tài liệu|tệp|file|sách|pdf)|(?:trong|thuộc).*(?:tài liệu|tệp|file|sách|pdf).*nào|đối chiếu.*(?:câu|trích dẫn)|find.*(?:exact|quote|sentence)|does.*(?:appear|occur).*(?:document|file|book|pdf)|which.*(?:document|file|book|pdf).*(?:contains?|has)|verify.*(?:quote|sentence)/i.test(normalized)) {
    return { intent: "exact_quote", quotedText, documentScoped: true };
  }
  if (walletScopeCue && walletFactCue) {
    return { intent: "wallet", documentScoped: false };
  }
  if (/(câu chuyện|truyện)\s*(?:số|thứ)?\s*\d{1,4}|(tổng|bao nhiêu|mấy)\s+câu chuyện|\bstory\s*(?:number|no\.?|#)?\s*\d{1,4}\b|how many stories/i.test(normalized)) {
    return { intent: "story_lookup", documentScoped: true };
  }
  if (
    (ownedDataCue || documentLocationCue || concreteFileCue)
    && /(tên|tựa|tác giả|dài bao nhiêu trang|bao nhiêu trang|title|author|how many pages|page count).*(sách|pdf|tài liệu|book|document)|(sách|pdf|tài liệu|book|document).*(tên|tựa|tác giả|bao nhiêu trang|title|author|how many pages|page count)/i.test(normalized)
  ) {
    return { intent: "metadata", documentScoped: true };
  }
  // A concrete image filename is stronger evidence than generic words such as
  // "blob" or "file" that also appear in inventory questions.
  if (/\.(?:avif|gif|jpe?g|png|webp)(?:\s|$|[?!,.)])/i.test(normalized)) {
    return { intent: "image", documentScoped: true };
  }
  // Follow-ups such as “Which visible details support that description?” do
  // not repeat the word “image”, but still require a fresh pixel observation.
  if (asksAboutVisibleImageDetails) {
    return { intent: "image", documentScoped: true };
  }
  if (asksForImageCollection) {
    return { intent: "image", documentScoped: true };
  }
  if (inventoryScopeCue && /(?:liệt kê|danh sách|bao nhiêu|mấy|list|show|how many|which).*(blob|tệp|files?|documents?)|(?:kiểm tra|làm mới|cập nhật|check|refresh|update).*(?:blob|tệp|files?)|(?:do i have|tôi|mình).*(?:có|những|have).*(blob|tệp|files?|sách|pdf|ảnh|hình|books?|images?|photos?)|(?:what|which).*(?:blobs?|files?).*(?:do i have|are mine)|^(?:my|của tôi|của mình)\s+(?:blobs?|files?|documents?|books?|pdfs?|images?|photos?)\??$/i.test(normalized)) {
    return { intent: "inventory", documentScoped: true };
  }
  if (/(tóm tắt|summarize|study guide|đề cương|bản tóm tắt|tổng hợp)/i.test(normalized) && (ownedDataCue || documentLocationCue || /(?:tài liệu|đã nạp|indexed documents?|knowledge base)/i.test(normalized))) {
    return { intent: "summarize_study_guide", documentScoped: true };
  }
  if (/(ảnh|hình|photo|image)/i.test(normalized) && (ownedDataCue || documentLocationCue || /(?:mô tả|xem|hiển thị|mở|describe|show|display|open).*(?:ảnh|hình|photo|image)|(?:ảnh|hình|photo|image).*(?:đã nạp|đã tải|uploaded|indexed)/i.test(normalized))) {
    return { intent: "image", documentScoped: true };
  }
  if ((ownedDataCue || documentLocationCue) && /(sách|pdf|tài liệu|blob|tệp|file|trang|câu chuyện|truyện|kho dữ liệu|book|document|page|story|knowledge base)/i.test(normalized)) {
    return { intent: "document_semantic", documentScoped: true };
  }
  if (
    concreteFileCue
    && /(?:open|read|inspect|identify|summarize|explain|find|show|mở|đọc|kiểm tra|xác định|tóm tắt|giải thích|tìm|cho xem)/i.test(normalized)
  ) {
    return { intent: "document_semantic", documentScoped: true };
  }
  return { intent: "general", documentScoped: false };
}
