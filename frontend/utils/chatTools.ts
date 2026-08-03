import { aptosClient } from "@/utils/aptosClient";
import { getImageDocuments, getRagSources, getShelbyBlobInventory, getVectorDB, type ImageDocument } from "@/utils/ragOrama";
import { asksForLiveInventoryRefresh } from "@/utils/queryRouter";
import { SHELBYUSD_FA_METADATA_ADDRESS } from "@shelby-protocol/sdk/browser";
import type { ConnectedWalletDetail } from "../../shared/agentTools";

export interface ChatToolResult {
  name: "wallet_address" | "apt_balance" | "shelbyusd_balance" | "account_info" | "blob_inventory" | "document_inventory" | "document_lookup" | "show_images" | "identity" | "calculator";
  text: string;
  imageUrls?: string[];
  links?: { label: string; url: string }[];
  /** Stable RAG sources referenced by this tool result for follow-up resolution. */
  referencedSources?: string[];
  data?: BlobInventoryToolData;
  walletData?: WalletToolData;
}

export interface ChatToolContext {
  preferredSources?: string[];
  /** Defaults to Vietnamese to preserve existing callers and deterministic tests. */
  language?: "en" | "vi";
}

export interface IndexedImageAnalysisContext {
  preferredSources?: string[];
  language?: "en" | "vi";
  provider: "gemini" | "qwen";
  describeImage: (image: ImageDocument, question: string, signal?: AbortSignal) => Promise<string | null>;
}

export type IndexedImageAnalysisOutcome =
  | { ok: true; cached: boolean; result: ChatToolResult }
  | {
    ok: false;
    code: "no_indexed_images" | "image_not_found" | "image_source_required" | "image_analysis_empty";
    candidates: string[];
  };

export interface BlobInventoryToolData {
  kind: "blob_inventory";
  status: "verified" | "stale" | "not_loaded";
  count?: number;
  examples: string[];
  names?: string[];
  truncated?: boolean;
  fetchedAt?: number;
  observedAt: number;
  ageMs?: number;
  freshness: "recent_cache" | "stale_cache" | "unavailable";
}

export interface ChatToolObservation {
  version: 1;
  kind: "blob_inventory";
  status: BlobInventoryToolData["status"];
  observedAt: number;
  fetchedAt?: number;
}

export interface WalletToolData {
  kind: "connected_wallet";
  detail: ConnectedWalletDetail;
  connected: boolean;
  address?: string;
  formattedAmount?: string;
  sequenceNumber?: string;
  authenticationKey?: string;
}

const OCTAS_PER_APT = 100_000_000n;
const BLOB_EXAMPLE_LIMIT = 3;
const BLOB_LIST_LIMIT = 100;
const RECENT_INVENTORY_MS = 5 * 60_000;
const RUNTIME_VISION_CACHE_MS = 5 * 60_000;
const RUNTIME_VISION_CACHE_LIMIT = 24;
const runtimeVisionCache = new Map<string, { description: string; createdAt: number }>();

export type BlobInventoryDetail = "count" | "sample" | "all";

/**
 * Executes structured runtime vision after the model chooses the vision tool.
 * It deliberately does not parse conversational phrases; source resolution is
 * restricted to the tool argument or the most recently shown image context.
 */
export async function analyzeIndexedImage(
  source: string | undefined,
  question: string,
  context: IndexedImageAnalysisContext,
  signal?: AbortSignal,
): Promise<IndexedImageAnalysisOutcome> {
  signal?.throwIfAborted();
  const images = await getImageDocuments();
  signal?.throwIfAborted();
  if (!images.length) return { ok: false, code: "no_indexed_images", candidates: [] };

  const normalizedSource = source?.trim().toLocaleLowerCase("en-US");
  const explicitlySelected = normalizedSource
    ? images.filter((image) => (
      image.source.toLocaleLowerCase("en-US") === normalizedSource
      || image.displayName.toLocaleLowerCase("en-US") === normalizedSource
    ))
    : [];
  if (normalizedSource && explicitlySelected.length !== 1) {
    return {
      ok: false,
      code: "image_not_found",
      candidates: images.slice(0, 8).map((image) => image.source),
    };
  }

  const preferred = !normalizedSource && context.preferredSources?.length
    ? images.filter((image) => context.preferredSources!.includes(image.source))
    : [];
  const selected = explicitlySelected[0]
    ?? (preferred.length === 1 ? preferred[0] : undefined)
    ?? (!normalizedSource && !preferred.length && images.length === 1 ? images[0] : undefined);
  if (!selected) {
    return {
      ok: false,
      code: "image_source_required",
      candidates: (preferred.length ? preferred : images).slice(0, 8).map((image) => image.source),
    };
  }

  const normalizedQuestion = question.trim().replace(/\s+/g, " ").toLocaleLowerCase(context.language === "vi" ? "vi-VN" : "en-US").slice(0, 1_000);
  if (!normalizedQuestion) {
    return { ok: false, code: "image_analysis_empty", candidates: [selected.source] };
  }
  const cacheKey = `${selected.owner}\u0000${selected.source}\u0000${selected.revision}\u0000${context.provider}\u0000${context.language ?? "en"}\u0000${normalizedQuestion}`;
  const cachedEntry = runtimeVisionCache.get(cacheKey);
  if (cachedEntry && Date.now() - cachedEntry.createdAt > RUNTIME_VISION_CACHE_MS) {
    runtimeVisionCache.delete(cacheKey);
  }
  let description = runtimeVisionCache.get(cacheKey)?.description;
  const cached = Boolean(description);
  if (!description) {
    description = (await context.describeImage(selected, question.trim().slice(0, 1_000), signal))?.trim();
    signal?.throwIfAborted();
    if (!description) {
      return { ok: false, code: "image_analysis_empty", candidates: [selected.source] };
    }
    runtimeVisionCache.set(cacheKey, { description, createdAt: Date.now() });
    while (runtimeVisionCache.size > RUNTIME_VISION_CACHE_LIMIT) {
      runtimeVisionCache.delete(runtimeVisionCache.keys().next().value!);
    }
  }
  const t = (english: string, vietnamese: string) => context.language === "vi" ? vietnamese : english;
  return {
    ok: true,
    cached,
    result: {
      name: "show_images",
      text: t(
        `Visual analysis of ${selected.displayName}:\n\n${description}`,
        `Phân tích hình ảnh ${selected.displayName}:\n\n${description}`,
      ),
      imageUrls: [selected.url],
      links: [{ label: t("Open original image", "Mở ảnh gốc"), url: selected.url }],
      referencedSources: [selected.source],
    },
  };
}

export function asksForCompleteBlobList(question: string): boolean {
  return /(?:liệt kê|danh sách|hiển thị).*(?:tất cả|toàn bộ)|(?:tất cả|toàn bộ).*(?:blob|tệp|file)|(?:list|show).*(?:all|every).*(?:blobs?|files?)|(?:full|complete)\s+list/i.test(question);
}

export function blobInventoryDetailForQuestion(question: string): BlobInventoryDetail {
  if (asksForCompleteBlobList(question)) return "all";
  if (/(?:danh sách|liệt kê|hiển thị|những)\s+(?:blob|tệp|file)|(?:blob|tệp|file).*(?:nào|gì)|(?:list|show|which|what).*(?:blobs?|files?)/i.test(question)) return "sample";
  return "count";
}

/**
 * Narrow fail-safe for a structurally known inventory turn. The model remains
 * responsible for normal conversational routing; these short confirmations
 * must not be answered from memory without rereading the app snapshot.
 */
export function isBlobInventoryConfirmationFollowUp(question: string): boolean {
  return /^(?:chắc\s*(?:chưa|chứ|không)?|(?:bạn\s+)?có\s+chắc(?:\s+không)?|thật\s+(?:không|chứ)|xác\s+nhận(?:\s+lại)?(?:\s+đi)?|kiểm\s+tra\s+lại(?:\s+đi)?|are\s+you\s+sure|really|confirm(?:\s+that)?|check\s+again)\s*[?!.]*$/i.test(question.trim());
}

export function asksForLiveBlobInventoryRefresh(question: string): boolean {
  return asksForLiveInventoryRefresh(question);
}

export function createChatToolObservation(result: ChatToolResult | null | undefined): ChatToolObservation | undefined {
  if (result?.data?.kind !== "blob_inventory") return undefined;
  return {
    version: 1,
    kind: "blob_inventory",
    status: result.data.status,
    observedAt: result.data.observedAt,
    fetchedAt: result.data.fetchedAt,
  };
}

export function readBlobInventory(
  detail: BlobInventoryDetail = "count",
  context: Pick<ChatToolContext, "language"> = {},
): ChatToolResult {
  const t = (english: string, vietnamese: string) => context.language === "en" ? english : vietnamese;
  const inventory = getShelbyBlobInventory();
  const observedAt = Date.now();
  if (!inventory) {
    return {
      name: "blob_inventory",
      text: t(
        "The Shelby blob list has not been loaded yet. Select Refresh in the Library, then ask again.",
        "Danh sách blob Shelby chưa được tải. Hãy bấm Làm mới trong Thư viện rồi hỏi lại.",
      ),
      data: { kind: "blob_inventory", status: "not_loaded", examples: [], observedAt, freshness: "unavailable" },
    };
  }

  const count = inventory.names.length;
  const examples = detail === "sample" ? inventory.names.slice(0, BLOB_EXAMPLE_LIMIT) : [];
  const names = detail === "all" ? inventory.names.slice(0, BLOB_LIST_LIMIT) : undefined;
  const truncated = detail === "all" && inventory.names.length > BLOB_LIST_LIMIT;
  const ageMs = inventory.fetchedAt > 0 ? Math.max(0, observedAt - inventory.fetchedAt) : Number.POSITIVE_INFINITY;
  const freshness = inventory.verified && ageMs <= RECENT_INVENTORY_MS ? "recent_cache" : "stale_cache";
  const data: BlobInventoryToolData = {
    kind: "blob_inventory",
    status: freshness === "recent_cache" ? "verified" : "stale",
    count,
    examples,
    names,
    truncated,
    fetchedAt: inventory.fetchedAt,
    observedAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
    freshness,
  };

  if (!inventory.verified) {
    return {
      name: "blob_inventory",
      text: t(
        `The last successful refresh found ${count} ${count === 1 ? "blob" : "blobs"}, but the latest Shelby refresh failed, so I cannot confirm the current count. Select Refresh in the Library and try again.`,
        `Lần làm mới thành công trước ghi nhận ${count} blob, nhưng lần đồng bộ Shelby gần nhất bị lỗi nên chưa thể xác nhận số hiện tại. Hãy bấm Làm mới trong Thư viện rồi thử lại.`,
      ),
      data,
    };
  }

  const fetchedLabel = inventory.fetchedAt > 0
    ? new Date(inventory.fetchedAt).toLocaleString(context.language === "en" ? "en-US" : "vi-VN")
    : t("an unknown time", "thời điểm không xác định");
  if (freshness === "stale_cache") {
    return {
      name: "blob_inventory",
      text: t(
        `The last successful Shelby refresh at ${fetchedLabel} found ${count} ${count === 1 ? "blob" : "blobs"}. This snapshot may be outdated; select Refresh in the Library before treating it as current.`,
        `Lần đồng bộ Shelby thành công gần nhất lúc ${fetchedLabel} ghi nhận ${count} blob. Snapshot này có thể đã cũ; hãy bấm Làm mới trong Thư viện trước khi xem đó là số hiện tại.`,
      ),
      data,
    };
  }

  if (detail === "all") {
    const list = names?.length ? `\n- ${names.join("\n- ")}` : "";
    const limitNote = truncated
      ? t(`\n\nShowing the first ${BLOB_LIST_LIMIT} of ${count} blobs.`, `\n\nĐang hiển thị ${BLOB_LIST_LIMIT} blob đầu tiên trong tổng số ${count}.`)
      : "";
    return {
      name: "blob_inventory",
      text: t(
        `The Shelby snapshot refreshed at ${fetchedLabel} contains ${count} ${count === 1 ? "blob" : "blobs"}:${list}${limitNote}`,
        `Snapshot Shelby được làm mới lúc ${fetchedLabel} có ${count} blob:${list}${limitNote}`,
      ),
      data,
    };
  }

  const exampleText = examples.length
    ? t(` Examples include ${examples.join(", ")}.`, ` Ví dụ: ${examples.join(", ")}.`)
    : "";
  return {
    name: "blob_inventory",
    text: t(
      `The Shelby snapshot refreshed at ${fetchedLabel} contains ${count} ${count === 1 ? "blob" : "blobs"}.${exampleText}`,
      `Snapshot Shelby được làm mới lúc ${fetchedLabel} có ${count} blob.${exampleText}`,
    ),
    data,
  };
}

/**
 * Returns facts rather than presentation copy so an AI provider can phrase the
 * answer naturally. Filename filtering is model-selected through tool args;
 * this function does not classify the user's sentence.
 */
export function readBlobInventoryForAgent(
  request: { detail: BlobInventoryDetail; nameQuery?: string },
): Record<string, unknown> {
  const inventory = getShelbyBlobInventory();
  const observedAt = Date.now();
  if (!inventory) {
    return {
      ok: false,
      status: "not_loaded",
      freshness: "unavailable",
      observedAt,
      refreshRequired: true,
    };
  }

  const ageMs = inventory.fetchedAt > 0 ? Math.max(0, observedAt - inventory.fetchedAt) : Number.POSITIVE_INFINITY;
  const recent = inventory.verified && ageMs <= RECENT_INVENTORY_MS;
  const nameQuery = request.nameQuery?.trim().slice(0, 200);
  const normalizedQuery = nameQuery?.toLocaleLowerCase("en-US");
  const allMatchingNames = normalizedQuery
    ? inventory.names.filter((name) => name.toLocaleLowerCase("en-US").includes(normalizedQuery))
    : [];
  const matchingNames = allMatchingNames.slice(0, BLOB_LIST_LIMIT);
  const disclosedNames = nameQuery
    ? matchingNames.slice(0, BLOB_EXAMPLE_LIMIT)
    : request.detail === "sample" || request.detail === "all"
      ? inventory.names.slice(0, BLOB_EXAMPLE_LIMIT)
      : [];
  const expectedCount = nameQuery ? allMatchingNames.length : inventory.names.length;

  return {
    ok: true,
    status: recent ? "verified" : "stale",
    freshness: recent ? "recent_cache" : "stale_cache",
    count: inventory.names.length,
    ...(nameQuery ? {
      nameQuery,
      matchedCount: allMatchingNames.length,
      matches: matchingNames,
      truncated: allMatchingNames.length > BLOB_LIST_LIMIT,
    } : request.detail === "all" ? {
      names: inventory.names.slice(0, BLOB_LIST_LIMIT),
      truncated: inventory.names.length > BLOB_LIST_LIMIT,
    } : request.detail === "sample" ? {
      examples: inventory.names.slice(0, BLOB_EXAMPLE_LIMIT),
    } : {}),
    fetchedAt: inventory.fetchedAt,
    observedAt,
    ...(Number.isFinite(ageMs) ? { ageMs } : {}),
    refreshRequired: !recent,
    lastRefreshSucceeded: inventory.verified,
    answerContract: {
      scope: "wallet_blob_inventory",
      requiredExactStrings: disclosedNames,
      count: {
        allowedValues: [...new Set([inventory.names.length, expectedCount])],
        requiredValues: expectedCount > 0 ? [expectedCount] : [],
        units: ["blob", "blobs", "tệp", "file", "files"],
      },
    },
  };
}

/** Rejects model phrasing that changes an app-verified inventory fact. */
export function isBlobInventoryAnswerConsistent(result: ChatToolResult, answer: string): boolean {
  const data = result.data;
  if (result.name !== "blob_inventory" || data?.kind !== "blob_inventory" || data.count === undefined) return false;
  const statedCounts = [...answer.matchAll(/(\d[\d\s.,]*)\s*(?:blobs?|tệp|files?)/giu)]
    .map((match) => Number(match[1].replace(/\D/g, "")))
    .filter(Number.isFinite);
  if (!statedCounts.length || statedCounts.some((count) => count !== data.count)) return false;
  const disclosedNames = data.names ?? data.examples;
  return disclosedNames.every((name) => answer.includes(name));
}

function formatApt(balance: bigint): string {
  const whole = balance / OCTAS_PER_APT;
  const fraction = (balance % OCTAS_PER_APT).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} APT`;
}

function formatAssetAmount(raw: number, decimals: number): string {
  const value = raw / 10 ** decimals;
  return value.toLocaleString("en-US", { maximumFractionDigits: Math.min(decimals, 8) });
}

/** Reads one explicit public fact from the Aptos wallet connected to the app. */
export async function readConnectedWallet(
  detail: ConnectedWalletDetail,
  address?: string,
  context: Pick<ChatToolContext, "language"> = {},
  signal?: AbortSignal,
): Promise<ChatToolResult> {
  signal?.throwIfAborted();
  const t = (english: string, vietnamese: string) => context.language === "en" ? english : vietnamese;
  if (!address) {
    return {
      name: detail === "address" ? "wallet_address" : detail === "apt_balance" ? "apt_balance" : detail === "shelbyusd_balance" ? "shelbyusd_balance" : "account_info",
      text: t(
        "No Aptos wallet is connected to this app. Connect one first, then ask again.",
        "Chưa có ví Aptos nào kết nối với ứng dụng. Hãy kết nối ví rồi hỏi lại.",
      ),
      walletData: { kind: "connected_wallet", detail, connected: false },
    };
  }

  if (detail === "address") {
    return {
      name: "wallet_address",
      text: t(`Your connected Aptos wallet address is:\n${address}`, `Địa chỉ ví Aptos đang kết nối của bạn là:\n${address}`),
      walletData: { kind: "connected_wallet", detail, connected: true, address },
    };
  }

  const aptos = aptosClient();
  if (detail === "apt_balance") {
    const rawBalance = await aptos.getBalance({ accountAddress: address, asset: "0x1::aptos_coin::AptosCoin" });
    signal?.throwIfAborted();
    const formattedAmount = formatApt(BigInt(rawBalance));
    return {
      name: "apt_balance",
      text: t(
        `The current Aptos balance of wallet ${address.slice(0, 8)}…${address.slice(-6)} is ${formattedAmount}.`,
        `Số dư Aptos hiện tại của ví ${address.slice(0, 8)}…${address.slice(-6)} là ${formattedAmount}.`,
      ),
      walletData: { kind: "connected_wallet", detail, connected: true, address, formattedAmount },
    };
  }

  if (detail === "shelbyusd_balance") {
    const [balance, metadata] = await Promise.all([
      aptos.getBalance({ accountAddress: address, asset: SHELBYUSD_FA_METADATA_ADDRESS }),
      aptos.getFungibleAssetMetadata({ options: { where: { asset_type: { _eq: SHELBYUSD_FA_METADATA_ADDRESS } }, limit: 1 } }),
    ]);
    signal?.throwIfAborted();
    const decimals = metadata[0]?.decimals ?? 6;
    const formattedAmount = `${formatAssetAmount(balance, decimals)} ShelbyUSD`;
    return {
      name: "shelbyusd_balance",
      text: t(
        `The current ShelbyUSD balance of wallet ${address.slice(0, 8)}…${address.slice(-6)} is ${formattedAmount}.`,
        `Số dư ShelbyUSD hiện tại của ví ${address.slice(0, 8)}…${address.slice(-6)} là ${formattedAmount}.`,
      ),
      walletData: { kind: "connected_wallet", detail, connected: true, address, formattedAmount },
    };
  }

  const info = await aptos.getAccountInfo({ accountAddress: address });
  signal?.throwIfAborted();
  return {
    name: "account_info",
    text: t(
      `On-chain information for wallet ${address.slice(0, 8)}…${address.slice(-6)}:\n- Sequence number: ${info.sequence_number}\n- Authentication key: ${info.authentication_key}`,
      `Thông tin on-chain của ví ${address.slice(0, 8)}…${address.slice(-6)}:\n- Sequence number: ${info.sequence_number}\n- Authentication key: ${info.authentication_key}`,
    ),
    walletData: {
      kind: "connected_wallet",
      detail,
      connected: true,
      address,
      sequenceNumber: info.sequence_number,
      authenticationKey: info.authentication_key,
    },
  };
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
    return readConnectedWallet("address", address, context, signal);
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
    return readConnectedWallet("shelbyusd_balance", address, context, signal);
  }

  if (/(số dư|balance|bao nhiêu\s+apt|apt.*bao nhiêu)/i.test(normalized)) {
    return readConnectedWallet("apt_balance", address, context, signal);
  }

  if (/(thông tin (tài khoản|ví)|account info|sequence number|authentication key)/i.test(normalized)) {
    return readConnectedWallet("account_info", address, context, signal);
  }

  const asksForBlobInventory = /(?:danh sách|liệt kê)(?:\s+(?:tất cả|toàn bộ))?\s+(?:blob|tệp|file)|(?:bao nhiêu|mấy)\s+(?:blob|tệp|file)|(?:blob|tệp|file).*(?:nào|gì)|(list|show|how many|which|what).*(blobs?|files?)/i.test(normalized)
    || (asksForLiveBlobInventoryRefresh(normalized) && /(?:blob|tệp|files?)/i.test(normalized));
  const asksAboutOwnInventory = /(ví|kho|tài khoản|của\s+(?:tôi|mình)|tôi\s+(?:có|đang)|mình\s+(?:có|đang)|wallet|library|account|\bmy\b|\bi have\b|\bdo i\b)/i.test(normalized);
  const explicitlyOpensNamedImage = /\.(?:avif|gif|jpe?g|png|webp)(?:\s|$|[?!,.)])/i.test(normalized)
    && /(?:show|display|open|describe|view|preview|xem|hiển thị|mở|mô tả)/i.test(normalized);
  if (
    asksForBlobInventory
    && asksAboutOwnInventory
    && !explicitlyOpensNamedImage
    && !/(toàn mạng|toàn bộ mạng|shelby\s+(?:có|đang có)|entire network|network-wide|across (?:the )?shelby network|does shelby have)/i.test(normalized)
  ) {
    return readBlobInventory(blobInventoryDetailForQuestion(question), context);
  }

  // General questions, wallet RPC and blob inventory never need to open the
  // local RAG database. Hydrate only when document/image tools may use it.
  const mayUseLocalData = Boolean(
    context.preferredSources?.length
    || /(?:blob|tệp|files?|trang|pages?|sách|books?|pdf|tài liệu|documents?|kho dữ liệu|knowledge base|ảnh|hình|photos?|images?|câu chuyện|truyện|stor(?:y|ies)|\.(?:avif|gif|jpe?g|png|webp))/i.test(normalized)
  );
  if (!mayUseLocalData) return null;
  await getVectorDB();
  signal?.throwIfAborted();

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
  const asksForImage = requestedImageByName || /((blob|tệp|file).*(ảnh|hình)|(ảnh|hình).*(blob|tệp|file)|(tôi|mình).*(có).*(ảnh|hình)|(ảnh|hình).*(nào|không|ko)|(?:liệt kê|danh sách|xem|hiển thị|mở).*?(ảnh|hình)|(mô tả|nội dung).*(ảnh|hình)|(?:list|show|display|open|describe|inspect|browse|enumerate).*(?:images?|photos?)|(?:images?|photos?).*(?:which|what|available|do i have)|(?:what is|what's).*(?:in|shown).*(?:image|photo))/i.test(normalized);
  const asksForImageDescription = /(mô tả|nội dung|trong ảnh|ảnh.*gì|hình.*gì|describe|what.*(?:in|shown).*(?:image|photo)|image.*(?:content|show)|photo.*(?:content|show))/i.test(normalized);
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
    const description = image.description;
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
        `This is ${image.displayName}. Its preview is available, but the original pixels have not been analyzed yet.`,
        `Đây là ảnh ${image.displayName}. Preview đã sẵn sàng, nhưng pixel ảnh gốc chưa được phân tích.`,
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
        "I can use these live data tools:\n- View your wallet address, APT and ShelbyUSD balances, and on-chain account information.\n- List blobs and PDF books in your Shelby Library.\n- Display and describe indexed image blobs.\n- Calculate basic arithmetic.\n- Search and cite PDF or text content in the RAG.\nChat uses Gemini when a key is saved, with Gemini 2.5 Flash preferred. Without a key, the app uses Qwen3.7 Flash. Gemini can also improve image, video, OCR, and semantic indexing while building RAG.",
        "Tôi có các công cụ dữ liệu trực tiếp:\n- Xem địa chỉ ví, số dư APT, ShelbyUSD và thông tin account on-chain.\n- Liệt kê blob/sách PDF trong kho Shelby.\n- Hiển thị và mô tả ảnh blob đã index.\n- Tính phép toán cơ bản.\n- Tìm kiếm và trích dẫn PDF/text trong RAG.\nKhi đã lưu key, chat dùng Gemini và ưu tiên Gemini 2.5 Flash. Nếu chưa có key, ứng dụng dùng Qwen3.7 Flash. Gemini cũng giúp đọc ảnh, video, OCR và lập chỉ mục ngữ nghĩa tốt hơn khi tạo RAG.",
      ),
    };
  }

  return null;
}
