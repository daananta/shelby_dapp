import {
  AgentHarnessLimitError,
  DEFAULT_AGENT_HARNESS_BUDGET,
  createFinalAnswerRepairInstruction,
  createToolBudgetExhaustedResponses,
  createToolBudgetFinalizationInstruction,
  createAgentHarnessState,
  executeAgentToolCalls,
  type AgentFunctionCall,
  type AgentToolDefinition,
} from "@/utils/agentHarness";
import type { AgentToolHandlers, AiRequest } from "@/utils/aiProvider";
import { localize } from "@/i18n";

type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  reasoning_details?: unknown[];
  tool_calls?: OpenRouterToolCall[];
};

type HostedChatResponse = {
  message?: {
    role?: string;
    content?: string | null;
    reasoning_details?: unknown[];
    tool_calls?: OpenRouterToolCall[];
  };
};

type HostedGatewayPayload = HostedChatResponse & { error?: string; kind?: string };

const MAX_HOSTED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_HOSTED_IMAGE_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_HOSTED_IMAGE_EDGE = 1_600;
const SUPPORTED_HOSTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export class HostedAiError extends Error {
  constructor(
    readonly kind: "rate_limit" | "unavailable" | "invalid_response",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HostedAiError";
  }
}

function isLocalPreviewHost(): boolean {
  if (typeof location === "undefined") return false;
  return location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "::1";
}

async function requestHostedGateway(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ response: Response; payload: HostedGatewayPayload }> {
  let response: Response;
  try {
    response = await fetch("/api/ai/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new HostedAiError(
      "unavailable",
      localize(
        "The AI service could not be reached. Check your connection and try again.",
        "Không thể kết nối tới dịch vụ AI. Hãy kiểm tra mạng và thử lại.",
      ),
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new HostedAiError(
      "unavailable",
      isLocalPreviewHost()
        ? localize(
          "This local preview does not run the AI service. Start the full app with npm run dev:fullstack, or use production.",
          "Bản xem trước local chưa chạy dịch vụ AI. Hãy dùng npm run dev:fullstack hoặc bản production.",
        )
        : localize(
          "The AI service returned an unexpected response. Please try again.",
          "Dịch vụ AI trả về phản hồi không đúng định dạng. Hãy thử lại.",
        ),
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HostedAiError(
      "invalid_response",
      localize("The AI service returned invalid JSON.", "Dịch vụ AI trả về dữ liệu JSON không hợp lệ."),
      response.status,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HostedAiError(
      "invalid_response",
      localize("The AI service returned an invalid response.", "Dịch vụ AI trả về phản hồi không hợp lệ."),
      response.status,
    );
  }
  return { response, payload: payload as HostedGatewayPayload };
}

function hostedGatewayFailure(
  response: Response,
  payload: HostedGatewayPayload,
  mode: "chat" | "vision",
): HostedAiError {
  if (response.status === 429 || payload.kind === "rate_limit") {
    return new HostedAiError(
      "rate_limit",
      mode === "vision"
        ? localize("Qwen vision is receiving too many requests. Please wait a moment and try again.", "Qwen Vision đang nhận quá nhiều yêu cầu. Hãy chờ một chút rồi thử lại.")
        : localize("Qwen is receiving too many requests. Please wait a moment and try again.", "Qwen đang nhận quá nhiều yêu cầu. Hãy chờ một chút rồi thử lại."),
      response.status,
    );
  }
  if (response.status === 503 || payload.kind === "provider_auth") {
    return new HostedAiError(
      "unavailable",
      localize(
        "The app's AI service needs server configuration. Try Gemini or contact the app owner.",
        "Dịch vụ AI của ứng dụng chưa được cấu hình đầy đủ. Hãy dùng Gemini hoặc liên hệ chủ ứng dụng.",
      ),
      response.status,
    );
  }
  return new HostedAiError(
    "unavailable",
    mode === "vision"
      ? localize("Qwen could not inspect this image right now.", "Qwen chưa thể phân tích ảnh này lúc này.")
      : localize("Qwen is temporarily unavailable. Please try again shortly.", "Qwen đang tạm thời chưa sẵn sàng. Vui lòng thử lại sau ít phút."),
    response.status,
  );
}

function hostedImageError(message: string, vietnamese: string, status: number) {
  return new HostedAiError("unavailable", localize(message, vietnamese), status);
}

function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function detectHostedImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return undefined;
}

async function readHostedImageBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const declaredBytes = parseContentLength(response.headers.get("content-length"));
  if (declaredBytes !== undefined && declaredBytes > MAX_HOSTED_IMAGE_SOURCE_BYTES) {
    throw hostedImageError(
      "This image is too large to prepare safely for live analysis.",
      "Ảnh này quá lớn để chuẩn bị an toàn cho phân tích trực tiếp.",
      413,
    );
  }
  const declaredType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (declaredType && declaredType !== "application/octet-stream" && !SUPPORTED_HOSTED_IMAGE_TYPES.has(declaredType)) {
    throw hostedImageError(
      "This image format is not supported for live analysis.",
      "Định dạng ảnh này chưa được hỗ trợ để phân tích trực tiếp.",
      415,
    );
  }
  if (!response.body) {
    throw hostedImageError(
      "The image source could not be read safely.",
      "Không thể đọc nguồn ảnh một cách an toàn.",
      502,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const abortReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    let complete = false;
    while (!complete) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        continue;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_HOSTED_IMAGE_SOURCE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw hostedImageError(
          "This image is too large to prepare safely for live analysis.",
          "Ảnh này quá lớn để chuẩn bị an toàn cho phân tích trực tiếp.",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
  }
  signal?.throwIfAborted();

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type CanvasLike = {
  width: number;
  height: number;
  getContext: (contextId: "2d") => Pick<CanvasRenderingContext2D, "drawImage"> | null;
  convertToBlob?: (options?: ImageEncodeOptions) => Promise<Blob>;
  toBlob?: (callback: BlobCallback, type?: string, quality?: number) => void;
};

async function canvasAsBlob(
  canvas: CanvasLike,
  type: "image/webp" | "image/jpeg",
  quality: number,
): Promise<Blob | null> {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type, quality });
  }
  const toBlob = canvas.toBlob;
  if (typeof toBlob === "function") {
    return new Promise((resolve) => toBlob.call(canvas, resolve, type, quality));
  }
  return null;
}

function createHostedCanvas(width: number, height: number): CanvasLike | null {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height) as unknown as CanvasLike;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function compressHostedImage(
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  signal?.throwIfAborted();
  if (typeof createImageBitmap !== "function") {
    throw hostedImageError(
      "This image is larger than 2 MB and this browser cannot reduce it safely.",
      "Ảnh lớn hơn 2 MB và trình duyệt này không thể giảm kích thước ảnh một cách an toàn.",
      413,
    );
  }

  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }));
  try {
    signal?.throwIfAborted();
    if (!bitmap.width || !bitmap.height) {
      throw hostedImageError(
        "The image dimensions are invalid.",
        "Kích thước ảnh không hợp lệ.",
        415,
      );
    }
    const initialScale = Math.min(1, MAX_HOSTED_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const attempts = [
      { scale: initialScale, quality: 0.82 },
      { scale: initialScale * 0.85, quality: 0.68 },
      { scale: initialScale * 0.7, quality: 0.54 },
      { scale: initialScale * 0.55, quality: 0.42 },
    ];
    for (const attempt of attempts) {
      signal?.throwIfAborted();
      const width = Math.max(1, Math.round(bitmap.width * attempt.scale));
      const height = Math.max(1, Math.round(bitmap.height * attempt.scale));
      const canvas = createHostedCanvas(width, height);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) break;
      context.drawImage(bitmap, 0, 0, width, height);
      const output = await canvasAsBlob(canvas, "image/webp", attempt.quality)
        ?? await canvasAsBlob(canvas, "image/jpeg", attempt.quality);
      signal?.throwIfAborted();
      if (!output || output.size > MAX_HOSTED_IMAGE_BYTES) continue;
      const outputBytes = new Uint8Array(await output.arrayBuffer());
      signal?.throwIfAborted();
      const outputMimeType = detectHostedImageMimeType(outputBytes);
      if (outputMimeType && outputMimeType !== "image/gif") {
        return { bytes: outputBytes, mimeType: outputMimeType };
      }
    }
  } finally {
    bitmap.close();
  }
  throw hostedImageError(
    "This image could not be reduced below the safe 2 MB limit.",
    "Không thể giảm ảnh xuống dưới giới hạn an toàn 2 MB.",
    413,
  );
}

function bytesAsBase64(bytes: Uint8Array, signal?: AbortSignal): string {
  signal?.throwIfAborted();
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    signal?.throwIfAborted();
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function isAllowedHostedImageUrl(url: URL): boolean {
  if (url.protocol === "https:" || url.protocol === "blob:") return true;
  if (url.protocol !== "http:" || typeof window === "undefined") return false;
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return isLoopback && url.origin === window.location.origin;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")
    .join("");
}

function toOpenRouterMessages(contents: NonNullable<AiRequest["contents"]>, systemInstruction?: string): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [];
  if (systemInstruction?.trim()) messages.push({ role: "system", content: systemInstruction.trim() });
  for (const item of contents.slice(-12)) {
    const role = item?.role === "model" ? "assistant" : "user";
    const content = contentText(item?.parts).trim();
    if (content) messages.push({ role, content });
  }
  return messages;
}

function parseToolCalls(value: unknown): Array<AgentFunctionCall & { id: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const call = item as Partial<OpenRouterToolCall>;
    const id = typeof call.id === "string" ? call.id : "";
    const name = typeof call.function?.name === "string" ? call.function.name : "";
    const rawArgs = typeof call.function?.arguments === "string" ? call.function.arguments : "{}";
    if (!id || !name) return [];
    try {
      const args = JSON.parse(rawArgs) as unknown;
      return [{ id, name, args }];
    } catch {
      return [{ id, name, args: {} }];
    }
  });
}

async function requestHostedChat(
  messages: OpenRouterMessage[],
  signal?: AbortSignal,
  toolChoice: "auto" | "none" = "auto",
): Promise<HostedChatResponse["message"]> {
  signal?.throwIfAborted();
  const { response, payload } = await requestHostedGateway({ messages, toolChoice }, signal);
  if (!response.ok) throw hostedGatewayFailure(response, payload, "chat");
  if (!payload.message) {
    throw new HostedAiError(
      "invalid_response",
      localize("Qwen returned an incomplete response.", "Qwen trả về phản hồi chưa hoàn chỉnh."),
    );
  }
  return payload.message;
}

/**
 * Sends one already-authorized indexed image through the same-origin gateway.
 * The provider credential stays server-side and image bytes are never returned
 * to the agent tool transcript or persisted in chat history.
 */
export async function describeImageWithHostedAi(
  imageUrl: string,
  fileName: string,
  language: "en" | "vi",
  signal?: AbortSignal,
  _detectedMimeType?: string,
  question = language === "vi" ? "Mô tả chính xác nội dung ảnh." : "Describe the image accurately.",
): Promise<string | null> {
  signal?.throwIfAborted();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    throw hostedImageError("The image source is invalid.", "Nguồn ảnh không hợp lệ.", 400);
  }
  if (!isAllowedHostedImageUrl(parsedUrl)) {
    throw hostedImageError("The image source is not allowed.", "Nguồn ảnh không được phép.", 400);
  }
  const imageResponse = await fetch(imageUrl, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!imageResponse.ok) {
    throw new HostedAiError(
      "unavailable",
      localize(`Unable to download the image (${imageResponse.status}).`, `Không thể tải ảnh (${imageResponse.status}).`),
      imageResponse.status,
    );
  }
  let imageBytes = await readHostedImageBytes(imageResponse, signal);
  let mimeType = detectHostedImageMimeType(imageBytes);
  if (!mimeType) {
    throw hostedImageError(
      "The downloaded bytes are not a supported image.",
      "Dữ liệu đã tải không phải định dạng ảnh được hỗ trợ.",
      415,
    );
  }
  if (imageBytes.byteLength > MAX_HOSTED_IMAGE_BYTES) {
    const compressed = await compressHostedImage(imageBytes, mimeType, signal);
    imageBytes = compressed.bytes;
    mimeType = compressed.mimeType;
  }
  const data = bytesAsBase64(imageBytes, signal);
  signal?.throwIfAborted();
  const { response, payload } = await requestHostedGateway({
    mode: "vision",
    image: { data, mimeType, fileName: fileName.slice(0, 200) },
    language,
    question: question.trim().slice(0, 1_000),
  }, signal);
  if (!response.ok) throw hostedGatewayFailure(response, payload, "vision");
  const description = typeof payload.message?.content === "string" ? payload.message.content.trim() : "";
  if (!description) {
    throw new HostedAiError(
      "invalid_response",
      localize("Qwen returned an incomplete image analysis.", "Qwen trả về phân tích ảnh chưa hoàn chỉnh."),
    );
  }
  return description;
}

/**
 * Runs Qwen through the server-side OpenRouter gateway while app tools remain
 * local, read-only, abortable, and bounded by the same harness as Gemini.
 */
export async function streamHostedAgentAnswer(
  { contents, systemInstruction }: AiRequest,
  onChunk: (text: string) => void,
  handlers: AgentToolHandlers,
  signal?: AbortSignal,
): Promise<string> {
  if (!contents?.length) throw new Error(localize("There is no question to send to Qwen.", "Không có câu hỏi để gửi đến Qwen."));
  const messages = toOpenRouterMessages(contents, systemInstruction);
  if (!messages.length || messages.at(-1)?.role !== "user") {
    throw new Error(localize("The question is invalid.", "Câu hỏi không hợp lệ."));
  }

  const latestText = messages.at(-1)?.content?.slice(0, 1_000) ?? "";
  const toolRegistry = new Map<string, AgentToolDefinition>([
    ["search_user_knowledge", {
      name: "search_user_knowledge",
      maxExecutions: 1,
      unavailableCode: "knowledge_search_unavailable",
      execute: async (args, requestSignal) => {
        const query = typeof args.query === "string" && args.query.trim()
          ? args.query.trim().slice(0, 1_000)
          : latestText;
        return { ...await handlers.searchKnowledge({ query }, requestSignal) };
      },
    }],
    ["get_wallet_blob_inventory", {
      name: "get_wallet_blob_inventory",
      maxExecutions: 2,
      allowRepeatedSignature: true,
      unavailableCode: "blob_inventory_unavailable",
      execute: async (args, requestSignal) => {
        const nameQuery = typeof args.nameQuery === "string" && args.nameQuery.trim()
          ? args.nameQuery.trim().slice(0, 200)
          : undefined;
        return handlers.getWalletBlobInventory({
          detail: args.detail === "all" || args.detail === "sample" ? args.detail : "count",
          nameQuery,
        }, requestSignal);
      },
    }],
    ["refresh_wallet_blob_inventory", {
      name: "refresh_wallet_blob_inventory",
      maxExecutions: 1,
      unavailableCode: "blob_inventory_refresh_unavailable",
      execute: async (_args, requestSignal) => handlers.refreshWalletBlobInventory
        ? handlers.refreshWalletBlobInventory(requestSignal)
        : { ok: false, code: "blob_inventory_refresh_unavailable" },
    }],
    ["inspect_application", {
      name: "inspect_application",
      maxExecutions: 1,
      unavailableCode: "application_inspection_unavailable",
      execute: async (args, requestSignal) => {
        const query = typeof args.query === "string" && args.query.trim()
          ? args.query.trim().slice(0, 1_000)
          : latestText;
        return handlers.inspectApplication
          ? handlers.inspectApplication({ query }, requestSignal)
          : { ok: false, code: "application_inspection_unavailable" };
      },
    }],
    ["analyze_indexed_image", {
      name: "analyze_indexed_image",
      maxExecutions: 1,
      unavailableCode: "image_analysis_unavailable",
      execute: async (args, requestSignal) => {
        const source = typeof args.source === "string" && args.source.trim()
          ? args.source.trim().slice(0, 200)
          : undefined;
        const question = typeof args.question === "string" && args.question.trim()
          ? args.question.trim().slice(0, 1_000)
          : latestText;
        return handlers.analyzeIndexedImage
          ? handlers.analyzeIndexedImage({ source, question }, requestSignal)
          : { ok: false, code: "image_analysis_unavailable" };
      },
    }],
  ]);

  const harnessState = createAgentHarnessState();
  let toolRound = 0;
  let repairOnly = false;
  while (toolRound <= DEFAULT_AGENT_HARNESS_BUDGET.maxRounds) {
    signal?.throwIfAborted();
    const response = await requestHostedChat(
      messages,
      signal,
      repairOnly || toolRound >= DEFAULT_AGENT_HARNESS_BUDGET.maxRounds ? "none" : "auto",
    );
    const calls = parseToolCalls(response?.tool_calls);
    if (!calls.length) {
      const answer = typeof response?.content === "string" ? response.content.trim() : "";
      const finalAnswer = answer || localize(
        "There is not enough information for a confident answer.",
        "Không tìm thấy đủ thông tin để trả lời chắc chắn.",
      );
      const repairInstruction = createFinalAnswerRepairInstruction(harnessState, finalAnswer);
      if (repairInstruction) {
        messages.push({
          role: "assistant",
          content: finalAnswer,
          ...(Array.isArray(response?.reasoning_details) ? { reasoning_details: response.reasoning_details } : {}),
        });
        messages.push({ role: "user", content: repairInstruction });
        repairOnly = true;
        continue;
      }
      signal?.throwIfAborted();
      onChunk(finalAnswer);
      return finalAnswer;
    }
    if (toolRound >= DEFAULT_AGENT_HARNESS_BUDGET.maxRounds) {
      messages.push({
        role: "assistant",
        content: typeof response?.content === "string" ? response.content : null,
        ...(Array.isArray(response?.reasoning_details) ? { reasoning_details: response.reasoning_details } : {}),
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      });
      const exhausted = createToolBudgetExhaustedResponses(calls);
      exhausted.forEach((part, index) => {
        messages.push({
          role: "tool",
          tool_call_id: calls[index]?.id ?? "",
          content: JSON.stringify(part.functionResponse.response),
        });
      });
      messages.push({ role: "user", content: createToolBudgetFinalizationInstruction() });
      const finalResponse = await requestHostedChat(messages, signal, "none");
      const finalAnswer = typeof finalResponse?.content === "string" ? finalResponse.content.trim() : "";
      if (!finalAnswer || parseToolCalls(finalResponse?.tool_calls).length) {
        throw new HostedAiError(
          "invalid_response",
          localize(
            "The AI could not finish this request from the available app data. Please try a more specific request.",
            "AI chưa thể hoàn tất yêu cầu từ dữ liệu ứng dụng hiện có. Hãy thử nêu yêu cầu cụ thể hơn.",
          ),
        );
      }
      signal?.throwIfAborted();
      onChunk(finalAnswer);
      return finalAnswer;
    }
    toolRound += 1;

    messages.push({
      role: "assistant",
      content: typeof response?.content === "string" ? response.content : null,
      ...(Array.isArray(response?.reasoning_details) ? { reasoning_details: response.reasoning_details } : {}),
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    });
    let batch;
    try {
      batch = await executeAgentToolCalls({
        calls,
        registry: toolRegistry,
        state: harnessState,
        round: toolRound,
        signal,
      });
    } catch (error) {
      if (!(error instanceof AgentHarnessLimitError)) throw error;
      throw new HostedAiError(
        "invalid_response",
        localize(
          "The AI requested more app data than this turn allows. Please try a more specific request.",
          "AI yêu cầu nhiều dữ liệu ứng dụng hơn giới hạn của lượt này. Hãy thử nêu yêu cầu cụ thể hơn.",
        ),
      );
    }
    batch.responses.forEach((part, index) => {
      messages.push({
        role: "tool",
        tool_call_id: calls[index]?.id ?? "",
        content: JSON.stringify(part.functionResponse.response),
      });
    });
  }
  throw new HostedAiError(
    "invalid_response",
    localize(
      "The AI could not finish this request from the available app data. Please try again.",
      "AI chưa thể hoàn tất yêu cầu từ dữ liệu ứng dụng hiện có. Hãy thử lại.",
    ),
  );
}
