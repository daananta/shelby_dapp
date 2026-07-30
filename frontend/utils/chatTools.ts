import { aptosClient } from "@/utils/aptosClient";
import { getImageDocuments, getRagSources, getShelbyBlobInventory, getVectorDB, updateImageDescription } from "@/utils/ragOrama";
import { describeImageWithCloud, getStoredCloudApiKey } from "@/utils/aiProvider";
import { SHELBYUSD_FA_METADATA_ADDRESS } from "@shelby-protocol/sdk/browser";

export interface ChatToolResult {
  name: "wallet_address" | "apt_balance" | "shelbyusd_balance" | "account_info" | "blob_inventory" | "document_inventory" | "document_lookup" | "show_images" | "identity" | "calculator";
  text: string;
  imageUrls?: string[];
  links?: { label: string; url: string }[];
  /** Stable RAG sources referenced by this tool result for follow-up resolution. */
  referencedSources?: string[];
}

export interface ChatToolContext {
  preferredSources?: string[];
  forceImage?: boolean;
  forceImageDescription?: boolean;
  allowCloudDescription?: boolean;
  /** Defaults to Vietnamese to preserve existing callers and deterministic tests. */
  language?: "en" | "vi";
}

const OCTAS_PER_APT = 100_000_000n;

function formatApt(balance: bigint): string {
  const whole = balance / OCTAS_PER_APT;
  const fraction = (balance % OCTAS_PER_APT).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} APT`;
}

function formatAssetAmount(raw: number, decimals: number): string {
  const value = raw / 10 ** decimals;
  return value.toLocaleString("en-US", { maximumFractionDigits: Math.min(decimals, 8) });
}

function calculateBasicExpression(question: string): number | null {
  // Accept only arithmetic, optionally followed by "=". A tiny recursive
  // descent evaluator avoids passing user text to eval/Function.
  const source = question.trim().replace(/\?$/, "").replace(/=$/, "").replace(/\s+/g, "");
  if (!/^[0-9()+\-*/.]+$/.test(source) || !/[0-9]/.test(source)) return null;
  let cursor = 0;
  const readFactor = (): number => {
    if (source[cursor] === "+") { cursor += 1; return readFactor(); }
    if (source[cursor] === "-") { cursor += 1; return -readFactor(); }
    if (source[cursor] === "(") {
      cursor += 1;
      const value = readExpression();
      if (source[cursor] !== ")") throw new Error("Thiếu dấu đóng ngoặc");
      cursor += 1;
      return value;
    }
    const match = source.slice(cursor).match(/^(?:\d+\.?\d*|\.\d+)/);
    if (!match) throw new Error("Biểu thức không hợp lệ");
    cursor += match[0].length;
    return Number(match[0]);
  };
  const readTerm = (): number => {
    let value = readFactor();
    while (source[cursor] === "*" || source[cursor] === "/") {
      const operator = source[cursor++];
      const right = readFactor();
      if (operator === "/" && right === 0) throw new Error("Không thể chia cho 0");
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };
  const readExpression = (): number => {
    let value = readTerm();
    while (source[cursor] === "+" || source[cursor] === "-") {
      const operator = source[cursor++];
      value = operator === "+" ? value + readTerm() : value - readTerm();
    }
    return value;
  };
  try {
    const value = readExpression();
    return cursor === source.length && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic browser-side tools. These intentionally run before the LLM so
 * wallet state and Shelby inventory are never guessed from RAG text.
 */
export async function runChatTool(question: string, address?: string, context: ChatToolContext = {}, signal?: AbortSignal): Promise<ChatToolResult | null> {
  signal?.throwIfAborted();
  const normalized = question.toLowerCase();
  const t = (english: string, vietnamese: string) => context.language === "en" ? english : vietnamese;

  if (/(địa chỉ.*ví|ví.*địa chỉ|wallet address)/i.test(normalized)) {
    if (!address) {
      return {
        name: "wallet_address",
        text: t("Connect your Aptos wallet first to view its address.", "Hãy kết nối ví Aptos trước để xem địa chỉ."),
      };
    }
    return {
      name: "wallet_address",
      text: t(`Your Aptos wallet address is:\n${address}`, `Địa chỉ ví Aptos của bạn là:\n${address}`),
    };
  }

  if (/^(tôi là ai|tôi là người nào|who am i)\??$/i.test(normalized)) {
    if (!address) {
      return {
        name: "identity",
        text: t(
          "Your wallet is not connected. Once connected, I can only identify its address — not infer your personal identity.",
          "Bạn chưa kết nối ví. Khi kết nối, tôi chỉ có thể nhận diện địa chỉ ví — không suy ra danh tính cá nhân của bạn.",
        ),
      };
    }
    return {
      name: "identity",
      text: t(
        `You are using Aptos wallet ${address}. I do not infer your personal identity beyond the wallet information you connected.`,
        `Bạn đang sử dụng ví Aptos ${address}. Tôi không suy ra danh tính cá nhân ngoài thông tin ví bạn đã kết nối.`,
      ),
    };
  }

  if (/^(bạn là ai|bạn là gì|who are you|what are you)\??$/i.test(normalized)) {
    return {
      name: "identity",
      text: t(
        "I am Shelby RAG Explorer — an in-browser assistant for finding Shelby blobs, reading documents, and using read-only Aptos tools.",
        "Tôi là Shelby RAG Explorer — trợ lý trong browser giúp bạn tìm kiếm blob Shelby, đọc tài liệu và dùng các công cụ Aptos read-only.",
      ),
    };
  }

  if (/(ai\s*·?\s*công cụ|công cụ.*là gì|tool.*là gì|what.*(?:ai\s*·?\s*)?tool|what does.*tool.*mean)/i.test(normalized)) {
    return {
      name: "identity",
      text: t(
        "The “AI · tool” label means the answer came from a live data tool in the app, such as Aptos RPC or your Shelby blob list — not an LLM guess based on RAG.",
        "Nhãn “AI · công cụ” nghĩa là câu trả lời được tạo từ một công cụ dữ liệu thật trong app (ví dụ Aptos RPC hoặc danh sách blob Shelby), không phải LLM suy đoán từ RAG.",
      ),
    };
  }

  const mathResult = calculateBasicExpression(normalized);
  if (mathResult !== null) {
    return { name: "calculator", text: t(`Result: ${mathResult}`, `Kết quả: ${mathResult}`) };
  }

  if (/shelby[\s_-]*usd/i.test(normalized) && /(số dư|balance|bao nhiêu)/i.test(normalized)) {
    if (!address) {
      return {
        name: "shelbyusd_balance",
        text: t("Connect your Aptos wallet first to check ShelbyUSD.", "Hãy kết nối ví Aptos trước để kiểm tra ShelbyUSD."),
      };
    }
    const aptos = aptosClient();
    const [balance, metadata] = await Promise.all([
      aptos.getBalance({ accountAddress: address, asset: SHELBYUSD_FA_METADATA_ADDRESS }),
      aptos.getFungibleAssetMetadata({ options: { where: { asset_type: { _eq: SHELBYUSD_FA_METADATA_ADDRESS } }, limit: 1 } }),
    ]);
    signal?.throwIfAborted();
    const decimals = metadata[0]?.decimals ?? 6;
    return {
      name: "shelbyusd_balance",
      text: t(
        `The current ShelbyUSD balance of wallet ${address.slice(0, 8)}…${address.slice(-6)} is ${formatAssetAmount(balance, decimals)} ShelbyUSD.`,
        `Số dư ShelbyUSD hiện tại của ví ${address.slice(0, 8)}…${address.slice(-6)} là ${formatAssetAmount(balance, decimals)} ShelbyUSD.`,
      ),
    };
  }

  if (/(số dư|balance|bao nhiêu\s+apt|apt.*bao nhiêu)/i.test(normalized)) {
    if (!address) {
      return {
        name: "apt_balance",
        text: t("Connect your Aptos wallet first to check its balance.", "Hãy kết nối ví Aptos trước để kiểm tra số dư."),
      };
    }
    const balance = await aptosClient().getBalance({ accountAddress: address, asset: "0x1::aptos_coin::AptosCoin" });
    signal?.throwIfAborted();
    return {
      name: "apt_balance",
      text: t(
        `The current Aptos balance of wallet ${address.slice(0, 8)}…${address.slice(-6)} is ${formatApt(BigInt(balance))}.`,
        `Số dư Aptos hiện tại của ví ${address.slice(0, 8)}…${address.slice(-6)} là ${formatApt(BigInt(balance))}.`,
      ),
    };
  }

  if (/(thông tin (tài khoản|ví)|account info|sequence number|authentication key)/i.test(normalized)) {
    if (!address) {
      return {
        name: "account_info",
        text: t("Connect your Aptos wallet first to view its on-chain information.", "Hãy kết nối ví Aptos trước để xem thông tin on-chain."),
      };
    }
    const info = await aptosClient().getAccountInfo({ accountAddress: address });
    signal?.throwIfAborted();
    return {
      name: "account_info",
      text: t(
        `On-chain information for wallet ${address.slice(0, 8)}…${address.slice(-6)}:\n- Sequence number: ${info.sequence_number}\n- Authentication key: ${info.authentication_key}`,
        `Thông tin on-chain của ví ${address.slice(0, 8)}…${address.slice(-6)}:\n- Sequence number: ${info.sequence_number}\n- Authentication key: ${info.authentication_key}`,
      ),
    };
  }

  // General questions and wallet RPC tools never need to open the local RAG
  // database. Hydrate only when the remaining document/image tools may use it.
  const mayUseLocalData = Boolean(
    context.forceImage
    || context.preferredSources?.length
    || /(?:blob|tệp|files?|trang|pages?|sách|books?|pdf|tài liệu|documents?|kho dữ liệu|knowledge base|ảnh|hình|photos?|images?|câu chuyện|truyện|stor(?:y|ies)|\.(?:avif|gif|jpe?g|png|webp))/i.test(normalized)
  );
  if (!mayUseLocalData) return null;
  await getVectorDB();
  signal?.throwIfAborted();

  const asksForBlobInventory = /(danh sách|liệt kê|bao nhiêu|mấy)\s+(blob|tệp|file)|(list|show|how many|which|what).*(blobs?|files?)/i.test(normalized);
  const asksAboutOwnInventory = /(ví|kho|tài khoản|của\s+(?:tôi|mình)|tôi\s+(?:có|đang)|mình\s+(?:có|đang)|wallet|library|account|\bmy\b|\bi have\b|\bdo i\b)/i.test(normalized);
  if (asksForBlobInventory && asksAboutOwnInventory && !/(toàn mạng|toàn bộ mạng|shelby\s+(?:có|đang có)|entire network|network-wide|across (?:the )?shelby network|does shelby have)/i.test(normalized)) {
    const inventory = getShelbyBlobInventory();
    if (!inventory) {
      return {
        name: "blob_inventory",
        text: t(
          "The blob list has not been loaded. Select Refresh in the Shelby Library.",
          "Chưa tải danh sách blob. Hãy bấm Làm mới trong Kho Shelby.",
        ),
      };
    }
    return {
      name: "blob_inventory",
      text: t(
        `This wallet has ${inventory.names.length} ${inventory.names.length === 1 ? "blob" : "blobs"} on Shelby:\n- ${inventory.names.join("\n- ")}`,
        `Ví này có tổng cộng ${inventory.names.length} blob trên Shelby:\n- ${inventory.names.join("\n- ")}`,
      ),
    };
  }

  if (/(bao nhiêu|mấy|tổng số|dài bao nhiêu)\s+trang|how many pages|page count/i.test(normalized)) {
    const documents = getRagSources().filter((source) => source.type === "text" && source.status === "indexed" && source.pageCount);
    const normalizedTerms = normalized.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3 && !/(bao|nhiêu|mấy|tổng|trang|sách|pdf|tài|liệu|của|tôi|cuốn|how|many|pages?|page|count|does|document|book|the|have)/i.test(term));
    const score = (source: typeof documents[number]) => {
      const haystack = `${source.title ?? ""} ${source.aliases.join(" ")} ${source.displayName} ${source.source}`.toLocaleLowerCase("vi-VN");
      return normalizedTerms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    };
    const ranked = documents.map((source) => ({ source, score: score(source) })).sort((a, b) => b.score - a.score);
    const selected = normalizedTerms.length && ranked[0]?.score ? [ranked[0].source] : documents.length === 1 ? documents : [];
    if (selected.length) {
      const source = selected[0];
      return {
        name: "document_lookup",
        text: t(
          `Document ${source.title ? `“${source.title}”` : source.displayName} has exactly ${source.pageCount} pages in the RAG page index.${source.textCoverage !== undefined ? ` Readable content was found on ${Math.round(source.textCoverage * 100)}% of its pages.` : ""}`,
          `Tài liệu ${source.title ? `“${source.title}”` : source.displayName} có chính xác ${source.pageCount} trang trong page index RAG.${source.textCoverage !== undefined ? ` Nội dung đọc được ở ${Math.round(source.textCoverage * 100)}% số trang.` : ""}`,
        ),
        links: source.blobUrl
          ? [{ label: t(`Open ${source.displayName}`, `Mở ${source.displayName}`), url: source.blobUrl }]
          : undefined,
      };
    }
    if (documents.length > 1) {
      return {
        name: "document_lookup",
        text: t(
          `Please name the book so I can return an exact page count. Indexed PDFs: ${documents.map((source) => `${source.title ?? source.displayName} (${source.pageCount} pages)`).join(", ")}.`,
          `Hãy nêu tên sách để trả số trang chính xác. Các PDF đã index: ${documents.map((source) => `${source.title ?? source.displayName} (${source.pageCount} trang)`).join(", ")}.`,
        ),
      };
    }
  }

  const asksForStory = /(?:câu chuyện|truyện)\s*(?:số|thứ)?\s*\d{1,4}/i.test(normalized);
  if (!asksForStory && /(tôi|mình).*(có|những).*(sách|pdf)|(sách|pdf).*(nào|đâu|ở đâu|của tôi)|(?:do i have|my|which|what).*(?:books?|pdfs?)|(?:books?|pdfs?).*(?:do i have|mine|where|which|what)/i.test(normalized)) {
    const inventory = getShelbyBlobInventory();
    const indexed = getRagSources().filter((source) => source.type === "text" && /\.pdf$/i.test(source.source));
    const pdfNames = inventory?.names.filter((name) => /\.pdf$/i.test(name)) ?? [];
    const books = pdfNames.map((name) => {
      const metadata = indexed.find((source) => source.source === name);
      return { name, title: metadata?.title, aliases: metadata?.aliases ?? [], pages: metadata?.pageCount, url: metadata?.blobUrl, confirmed: (metadata?.titleMetadata?.confidence ?? 0) >= 0.7 };
    });
    if (!books.length) {
      return {
        name: "document_inventory",
        text: t("This wallet's Shelby Library does not contain any PDF blobs.", "Kho Shelby của ví này không có blob PDF nào."),
      };
    }
    const words = normalized.split(/\s+/).filter((word) => word.length >= 3 && !/(sách|pdf|của|tôi|đâu|nào|những|không|ko|books?|mine|have|which|what|where|does|there|the)/i.test(word));
    const matched = books.find((book) => words.some((word) => `${book.title ?? ""} ${book.aliases.join(" ")} ${book.name}`.toLowerCase().includes(word)));
    if (/(có|không|ko)\??$|do i have|is there|does.*(?:exist|appear)/i.test(normalized) && words.length) {
      if (!matched) {
        return {
          name: "document_inventory",
          text: t(
            `No book matching “${words.join(" ")}” was found in the confirmed manifest. You can edit its name or aliases on the document card and ask again.`,
            `Không tìm thấy sách khớp với “${words.join(" ")}” trong manifest đã xác nhận. Bạn có thể sửa tên/aliases ngay trên card tài liệu rồi hỏi lại.`,
          ),
        };
      }
      return {
        name: "document_inventory",
        text: t(
          `Yes. ${matched.title ? `“${matched.title}”` : matched.name} is stored in blob ${matched.name}${matched.pages ? ` and has ${matched.pages} pages` : ""}.${matched.confirmed ? "" : " This title has low confidence; please confirm it on the document card."}`,
          `Có. Sách ${matched.title ? `“${matched.title}”` : matched.name} nằm trong blob ${matched.name}${matched.pages ? `, ${matched.pages} trang` : ""}.${matched.confirmed ? "" : " Tên này chưa có độ tin cậy cao; hãy xác nhận trên card tài liệu."}`,
        ),
        links: matched.url
          ? [{ label: t(`Open ${matched.name}`, `Mở ${matched.name}`), url: matched.url }]
          : undefined,
      };
    }
    if (/(đâu|ở đâu|where)/i.test(normalized) && (matched || books.length === 1)) {
      const book = matched ?? books[0];
      return {
        name: "document_inventory",
        text: t(
          `${book.title ? `“${book.title}”` : book.name} is stored in blob ${book.name}${book.pages ? ` and has ${book.pages} pages` : ""}.`,
          `Sách ${book.title ? `“${book.title}”` : book.name} nằm trong blob ${book.name}${book.pages ? `, ${book.pages} trang` : ""}.`,
        ),
        links: book.url
          ? [{ label: t(`Open ${book.name}`, `Mở ${book.name}`), url: book.url }]
          : undefined,
      };
    }
    return {
      name: "document_inventory",
      text: t(
        `This wallet's Shelby Library contains ${books.length} PDF ${books.length === 1 ? "book" : "books"}:\n${books.map((book) => `- ${book.title ? `${book.title} — ` : ""}${book.name}${book.pages ? ` (${book.pages} pages)` : ""}`).join("\n")}`,
        `Trong kho Shelby của ví có tổng cộng ${books.length} sách PDF:\n${books.map((book) => `- ${book.title ? `${book.title} — ` : ""}${book.name}${book.pages ? ` (${book.pages} trang)` : ""}`).join("\n")}`,
      ),
      links: books.flatMap((book) => book.url
        ? [{ label: t(`Open ${book.name}`, `Mở ${book.name}`), url: book.url }]
        : []),
    };
  }

  const imageDocuments = await getImageDocuments();
  signal?.throwIfAborted();
  const contextualImages = context.preferredSources?.length
    ? imageDocuments.filter((image) => context.preferredSources!.includes(image.source))
    : [];
  const requestedImageByName = imageDocuments.some((image) => {
    const names = [image.source, image.displayName].map((value) => value.toLocaleLowerCase("vi-VN"));
    return names.some((name) => name && normalized.includes(name));
  });
  const asksForImage = requestedImageByName || context.forceImage || /((blob|tệp|file).*(ảnh|hình)|(ảnh|hình).*(blob|tệp|file)|(tôi|mình).*(có).*(ảnh|hình)|(ảnh|hình).*(nào|không|ko)|(xem|hiển thị|mở).*?(ảnh|hình)|(mô tả|nội dung).*(ảnh|hình)|(?:show|display|open|describe).*(?:images?|photos?)|(?:images?|photos?).*(?:which|what|available|do i have)|(?:what is|what's).*(?:in|shown).*(?:image|photo))/i.test(normalized);
  const asksForImageDescription = context.forceImageDescription || /(mô tả|nội dung|trong ảnh|ảnh.*gì|hình.*gì|describe|what.*(?:in|shown).*(?:image|photo)|image.*(?:content|show)|photo.*(?:content|show))/i.test(normalized);
  if (asksForImage) {
    if (!imageDocuments.length) {
      return {
        name: "show_images",
        text: t("No image blobs have been indexed in the RAG yet.", "Không có blob ảnh nào đã được index trong RAG."),
      };
    }
    const matched = imageDocuments.filter((image) => normalized.includes(image.source.toLowerCase()) || normalized.includes(image.displayName.toLowerCase()));
    const selected = (matched.length ? matched : contextualImages.length ? contextualImages : imageDocuments).slice(0, asksForImageDescription ? 1 : 4);
    if (!asksForImageDescription) {
      return {
        name: "show_images",
        text: t(
          `${selected.length} indexed image ${selected.length === 1 ? "blob is" : "blobs are"} available:\n- ${selected.map((image) => image.displayName).join("\n- ")}\n\nI attached previews for you to inspect.`,
          `Có ${selected.length} blob ảnh đã index:\n- ${selected.map((image) => image.displayName).join("\n- ")}\n\nTôi đã đính kèm preview để bạn xem ngay.`,
        ),
        imageUrls: selected.map((image) => image.url),
        referencedSources: selected.map((image) => image.source),
      };
    }
    const image = selected[0];
    const apiKey = getStoredCloudApiKey();
    let description = image.description;
    if (apiKey && context.allowCloudDescription !== false) {
      description = (await describeImageWithCloud(image.url, image.displayName, apiKey, signal)) ?? undefined;
      signal?.throwIfAborted();
      if (description) await updateImageDescription(image.source, description);
      signal?.throwIfAborted();
    }
    if (description) {
      return {
        name: "show_images",
        text: t(`This is ${image.displayName}.\n\n${description}`, `Đây là ảnh ${image.displayName}.\n\n${description}`),
        imageUrls: [image.url],
        links: [{ label: t("Open original image", "Mở ảnh gốc"), url: image.url }],
        referencedSources: [image.source],
      };
    }
    return {
      name: "show_images",
      text: t(
        `This is ${image.displayName}. No reliable description is available yet. Enable AI Chat and save a Gemini API key if you want AI to inspect the original image.`,
        `Đây là ảnh ${image.displayName}. Chưa có mô tả đáng tin cậy; hãy bật Chat AI và lưu Gemini API key nếu bạn muốn AI phân tích trực tiếp ảnh gốc.`,
      ),
      imageUrls: [image.url],
      links: [{ label: t("Open original image", "Mở ảnh gốc"), url: image.url }],
      referencedSources: [image.source],
    };
  }

  if (/(khả năng|có thể làm gì|skill|công cụ|what can you do|capabilit(?:y|ies)|what tools)/i.test(normalized)) {
    return {
      name: "blob_inventory",
      text: t(
        "I can use these live data tools:\n- View your wallet address, APT and ShelbyUSD balances, and on-chain account information.\n- List blobs and PDF books in your Shelby Library.\n- Display and describe indexed image blobs.\n- Calculate basic arithmetic.\n- Search and cite PDF or text content in the RAG.\nI can also answer with Gemini Cloud using your own API key.",
        "Tôi có các công cụ dữ liệu trực tiếp:\n- Xem địa chỉ ví, số dư APT, ShelbyUSD và thông tin account on-chain.\n- Liệt kê blob/sách PDF trong kho Shelby.\n- Hiển thị và mô tả ảnh blob đã index.\n- Tính phép toán cơ bản.\n- Tìm kiếm và trích dẫn PDF/text trong RAG.\nNgoài ra có thể trả lời bằng Gemini Cloud với API key riêng của bạn.",
      ),
    };
  }

  return null;
}
