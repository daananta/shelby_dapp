import { FunctionCallingMode, GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { Tool } from "@google/generative-ai";
import { clearStoredCloudApiKey, getStoredCloudApiKey, storeCloudApiKey } from "@/utils/cloudKeyStorage";
import { normalizeConversationRoute, type ConversationRoute } from "@/utils/conversationRoute";
import { currentLanguage, localize } from "@/i18n";
import {
  AgentHarnessLimitError,
  DEFAULT_AGENT_HARNESS_BUDGET,
  createAgentHarnessState,
  executeAgentToolCalls,
  type AgentFunctionCall,
  type AgentToolDefinition,
} from "@/utils/agentHarness";

export { clearStoredCloudApiKey, getStoredCloudApiKey, storeCloudApiKey };

export interface AiRequest {
  prompt?: string;
  contents?: any[];
  cloudApiKey?: string;
  systemInstruction?: string;
}

export interface KnowledgeSearchRequest {
  query: string;
}

export interface KnowledgeSearchResponse {
  found: boolean;
  evidence: Array<{
    citation: string;
    page?: number;
    excerpt: string;
  }>;
  message?: string;
}

export interface BlobInventoryAgentRequest {
  detail: "count" | "sample" | "all";
}

export interface AgentToolHandlers {
  searchKnowledge: (request: KnowledgeSearchRequest, signal?: AbortSignal) => Promise<KnowledgeSearchResponse>;
  getWalletBlobInventory: (request: BlobInventoryAgentRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  refreshWalletBlobInventory?: (signal?: AbortSignal) => Promise<Record<string, unknown>>;
}

const CLOUD_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-lite-latest"];
const ROUTER_MODELS = ["gemini-flash-lite-latest", "gemini-2.0-flash", "gemini-2.5-flash"];
const conversationRouteCache = new Map<string, ConversationRoute>();

export type CloudErrorKind = "rate_limit" | "invalid_key" | "network" | "other";

function cloudErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; response?: { status?: unknown } };
  const status = value.status ?? value.response?.status;
  return typeof status === "number" ? status : undefined;
}

export function getCloudErrorKind(error: unknown): CloudErrorKind {
  const status = cloudErrorStatus(error);
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.toLowerCase();
  if (status === 429 || /\b429\b|resource_exhausted|quota|rate.?limit/.test(message)) return "rate_limit";
  if (status === 401 || status === 403 || /api[_ -]?key.*invalid|permission_denied|unauthorized/.test(message)) return "invalid_key";
  if (/failed to fetch|network|load failed|fetch failed/.test(message)) return "network";
  return "other";
}

export function normalizeCloudError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  const kind = getCloudErrorKind(error);
  if (kind === "rate_limit") return new Error(localize(
    "Gemini returned 429: this API key's project is rate-limited or out of quota. Keys in the same Google Cloud project share quota.",
    "Gemini trả về 429: project của API key đang chạm giới hạn hoặc đã hết quota. Các key trong cùng một Google Cloud project dùng chung quota.",
  ));
  if (kind === "invalid_key") return new Error(localize(
    "The Gemini API key is invalid or cannot access this model.",
    "Gemini API key không hợp lệ hoặc không có quyền dùng model này.",
  ));
  if (kind === "network") return new Error(localize(
    "Unable to reach Gemini. Check your network and try again.",
    "Không thể kết nối Gemini. Hãy kiểm tra mạng rồi thử lại.",
  ));
  return error instanceof Error && error.message ? error : new Error(localize("Cloud AI did not respond.", "Cloud AI không phản hồi."));
}

function shouldStopModelFallback(error: unknown): boolean {
  const kind = getCloudErrorKind(error);
  return kind === "rate_limit" || kind === "invalid_key";
}

/** Verifies the key with a minimal generation request before it is marked ready. */
export async function verifyCloudApiKey(apiKey: string): Promise<string> {
  if (!apiKey.trim()) throw new Error(localize("The API key is empty.", "API key trống."));
  const client = new GoogleGenerativeAI(apiKey.trim());
  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    try {
      await client.getGenerativeModel({ model: modelName }).generateContent("Reply with: OK");
      return modelName;
    } catch (error) {
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  throw normalizeCloudError(lastError ?? new Error(localize("Unable to verify the API key.", "Không thể xác thực API key.")));
}

export async function generateCloudAnswer({ prompt, contents, cloudApiKey, systemInstruction }: AiRequest): Promise<string> {
  if (!cloudApiKey?.trim()) throw new Error(localize("Enter your Gemini API key to use Cloud AI.", "Nhập Gemini API key của bạn để dùng Cloud AI."));
  const client = new GoogleGenerativeAI(cloudApiKey.trim());
  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    try {
      const model = client.getGenerativeModel({ model: modelName, systemInstruction } as any);
      const result = contents
        ? await model.generateContent({ contents })
        : await model.generateContent(prompt!);
      return result.response.text() || localize("No response.", "Không có phản hồi.");
    } catch (error) {
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  throw normalizeCloudError(lastError);
}

export async function resolveConversationRouteWithCloud(params: {
  question: string;
  recentTurns: Array<{ role: "user" | "ai"; text: string; sources: string[] }>;
  availableSources: string[];
  cloudApiKey: string;
  signal?: AbortSignal;
}): Promise<ConversationRoute> {
  params.signal?.throwIfAborted();
  if (!params.cloudApiKey.trim()) return normalizeConversationRoute(null, params.availableSources);
  const cacheKey = JSON.stringify([params.question.trim().toLocaleLowerCase("vi-VN"), params.availableSources, params.recentTurns.slice(-4)]);
  const cached = conversationRouteCache.get(cacheKey);
  if (cached) return cached;
  const client = new GoogleGenerativeAI(params.cloudApiKey.trim());
  const prompt = `Classify only; do not answer the user. Resolve the latest message using conversational meaning, not keyword rules.
Return JSON with exactly: {"scope":"general|document|image|tool","referencedSources":[],"imageAction":"show|describe|null","confidence":0.0}.
- general: world knowledge or ordinary conversation that does not require user-owned data.
- document: needs text/PDF evidence owned by the user.
- image: refers to a user image; imageAction is show or describe.
- tool: wallet, balance, blob inventory, or deterministic app data.
Only copy source ids from AVAILABLE SOURCES. If the latest message changes topic, use general and no sources. If uncertain, use general with low confidence.

AVAILABLE SOURCES:
${JSON.stringify(params.availableSources)}

RECENT TURNS:
${JSON.stringify(params.recentTurns.slice(-6))}

LATEST MESSAGE:
${params.question}`;
  let lastError: unknown;
  for (const modelName of ROUTER_MODELS) {
    try {
      params.signal?.throwIfAborted();
      const result = await client
        .getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: "application/json", temperature: 0 } } as any)
        .generateContent(prompt, { signal: params.signal });
      params.signal?.throwIfAborted();
      const parsed = JSON.parse(result.response.text());
      const route = normalizeConversationRoute(parsed, params.availableSources);
      conversationRouteCache.set(cacheKey, route);
      if (conversationRouteCache.size > 20) conversationRouteCache.delete(conversationRouteCache.keys().next().value!);
      return route;
    } catch (error) {
      if (params.signal?.aborted) throw error;
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  console.warn("Cloud intent resolver unavailable; using deterministic local routing.", lastError);
  return normalizeConversationRoute(null, params.availableSources);
}

export async function streamCloudAnswer(
  { prompt, contents, cloudApiKey, systemInstruction }: AiRequest,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!cloudApiKey?.trim()) throw new Error(localize("Enter your Gemini API key to use Cloud AI.", "Nhập Gemini API key của bạn để dùng Cloud AI."));
  const client = new GoogleGenerativeAI(cloudApiKey.trim());
  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    let emitted = false;
    try {
      signal?.throwIfAborted();
      const model = client.getGenerativeModel({ model: modelName, systemInstruction } as any);
      const result = contents
        ? await model.generateContentStream({ contents })
        : await model.generateContentStream(prompt!);
      let answer = "";
      for await (const chunk of result.stream) {
        signal?.throwIfAborted();
        const text = chunk.text();
        if (!text) continue;
        emitted = true;
        answer += text;
        onChunk(text);
      }
      return answer || localize("No response.", "Không có phản hồi.");
    } catch (error) {
      if (signal?.aborted) throw error;
      if (emitted) throw error;
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  throw normalizeCloudError(lastError);
}

/**
 * Gives Gemini narrowly scoped read-only tools through a bounded multi-round
 * harness. General questions finish directly; data-backed questions may chain
 * up to three tool rounds without exposing internal execution logs to the UI.
 */
export async function streamCloudAgentAnswer(
  { contents, cloudApiKey, systemInstruction }: AiRequest,
  onChunk: (text: string) => void,
  handlers: AgentToolHandlers,
  signal?: AbortSignal,
): Promise<string> {
  if (!cloudApiKey?.trim()) throw new Error(localize("Enter your Gemini API key to use Cloud AI.", "Nhập Gemini API key của bạn để dùng Cloud AI."));
  if (!contents?.length) throw new Error(localize("There is no question to send to Gemini.", "Không có câu hỏi để gửi đến Gemini."));

  const latest = contents.at(-1);
  const history = contents.slice(0, -1);
  const latestParts = latest?.parts;
  if (!Array.isArray(latestParts) || !latestParts.length) throw new Error(localize("The question is invalid.", "Câu hỏi không hợp lệ."));

  const agentTools: Tool = {
    functionDeclarations: [
      {
        name: "search_user_knowledge",
        description: "Search the user's private/imported Shelby documents. Call this only when the latest request depends on document content or clearly follows up on cited document evidence. Never use it for wallet state, blob counts/lists, general knowledge, or ordinary conversation.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: {
              type: SchemaType.STRING,
              description: "A self-contained semantic search query that resolves conversational references without inventing a filename.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_wallet_blob_inventory",
        description: "Read the connected wallet's latest app-cached Shelby blob inventory snapshot. This does not refresh the Shelby network. Call it for blob counts/lists and follow-ups that ask to confirm a previous blob-inventory answer. Report the supplied snapshot time honestly and never use document search for these requests.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            detail: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["count", "sample", "all"],
              description: "Use count for totals or confirmation, sample only when examples are requested, and all only when every name is explicitly requested.",
            },
          },
          required: ["detail"],
        },
      },
      ...(handlers.refreshWalletBlobInventory ? [{
        name: "refresh_wallet_blob_inventory",
        description: "Refresh the connected wallet's Shelby blob inventory from the network. Use this only when the user explicitly asks for current/live data or when the inventory tool reports a stale snapshot. This is read-only and must be followed by get_wallet_blob_inventory before answering.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {},
        },
      }] : []),
    ],
  };

  const latestText = String(latestParts.find((part: { text?: string }) => part.text)?.text ?? "").slice(0, 1_000);
  const toolRegistry = new Map<string, AgentToolDefinition>([
    ["search_user_knowledge", {
      name: "search_user_knowledge",
      maxExecutions: 1,
      unavailableCode: "knowledge_search_unavailable",
      execute: async (args, requestSignal) => {
        const rawQuery = args.query;
        const query = typeof rawQuery === "string" && rawQuery.trim()
          ? rawQuery.trim().slice(0, 1_000)
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
        const detail = args.detail === "all" || args.detail === "sample"
          ? args.detail
          : "count";
        return handlers.getWalletBlobInventory({ detail }, requestSignal);
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
  ]);

  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    let emitted = false;
    let harnessStarted = false;
    try {
      signal?.throwIfAborted();
      const model = clientFor(cloudApiKey).getGenerativeModel({
        model: modelName,
        systemInstruction,
        tools: [agentTools],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
      });
      const chat = model.startChat({ history });
      const first = await chat.sendMessage(latestParts, { signal });
      signal?.throwIfAborted();
      let calls = (first.response.functionCalls() ?? []) as AgentFunctionCall[];

      if (!calls.length) {
        const direct = first.response.text().trim();
        if (direct) {
          emitted = true;
          onChunk(direct);
          return direct;
        }
        throw new Error(localize("Gemini did not produce an answer.", "Gemini không tạo được câu trả lời."));
      }
      harnessStarted = true;
      const harnessState = createAgentHarnessState();
      for (let round = 1; round <= DEFAULT_AGENT_HARNESS_BUDGET.maxRounds; round += 1) {
        const batch = await executeAgentToolCalls({
          calls,
          registry: toolRegistry,
          state: harnessState,
          round,
          signal,
        });
        signal?.throwIfAborted();
        const result = await chat.sendMessageStream(batch.responses, { signal });
        const bufferedChunks: string[] = [];
        for await (const chunk of result.stream) {
          signal?.throwIfAborted();
          const chunkCalls = typeof chunk.functionCalls === "function" ? chunk.functionCalls() ?? [] : [];
          if (chunkCalls.length) continue;
          const text = chunk.text();
          if (text) bufferedChunks.push(text);
        }
        const finalResponse = await result.response;
        signal?.throwIfAborted();
        const nextCalls = (finalResponse.functionCalls() ?? []) as AgentFunctionCall[];
        const bufferedAnswer = bufferedChunks.join("");
        if (nextCalls.length) {
          if (round >= DEFAULT_AGENT_HARNESS_BUDGET.maxRounds) {
            throw new AgentHarnessLimitError("agent_round_limit");
          }
          // Planning text can precede a function call. Keep it private and
          // commit only the first model response that no longer requests work.
          calls = nextCalls;
          continue;
        }
        const answer = bufferedAnswer || finalResponse.text().trim();
        if (answer) {
          emitted = true;
          if (bufferedChunks.length) {
            for (const chunk of bufferedChunks) {
              signal?.throwIfAborted();
              onChunk(chunk);
            }
          } else {
            signal?.throwIfAborted();
            onChunk(answer);
          }
          return answer;
        }
        const fallback = localize(
          "There is not enough information for a confident answer.",
          "Không tìm thấy đủ thông tin để trả lời chắc chắn.",
        );
        signal?.throwIfAborted();
        emitted = true;
        onChunk(fallback);
        return fallback;
      }
      throw new AgentHarnessLimitError("agent_round_limit");
    } catch (error) {
      if (signal?.aborted) throw error;
      if (emitted) throw error;
      const boundedError = error instanceof AgentHarnessLimitError
        ? new Error(localize(
          "The AI requested too many app actions in one response.",
          "AI yêu cầu quá nhiều thao tác ứng dụng trong một phản hồi.",
        ))
        : error;
      if (harnessStarted) throw normalizeCloudError(boundedError);
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = boundedError;
    }
  }
  throw normalizeCloudError(lastError);
}

function clientFor(apiKey: string): GoogleGenerativeAI {
  return new GoogleGenerativeAI(apiKey.trim());
}

export async function describeImageWithCloud(imageUrl: string, fileName: string, cloudApiKey = getStoredCloudApiKey(), signal?: AbortSignal): Promise<string | null> {
  if (!cloudApiKey) return null;
  signal?.throwIfAborted();
  const response = await fetch(imageUrl, { signal });
  if (!response.ok) throw new Error(localize(`Unable to download the image (${response.status}).`, `Không thể tải ảnh (${response.status}).`));
  const blob = await response.blob();
  const data = await blobAsBase64(blob, signal);
  const mimeType = blob.type && blob.type !== "application/octet-stream"
    ? blob.type
    : fileName.match(/\.png$/i) ? "image/png"
      : fileName.match(/\.webp$/i) ? "image/webp"
        : fileName.match(/\.gif$/i) ? "image/gif" : "image/jpeg";
  const client = new GoogleGenerativeAI(cloudApiKey);
  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    try {
      signal?.throwIfAborted();
      const responseLanguage = currentLanguage() === "vi" ? "Vietnamese" : "English";
      const result = await client.getGenerativeModel({ model: modelName }).generateContent([
        { text: `Describe this image accurately for RAG search in ${responseLanguage}. Include visible subjects, text, context, actions, and important details. Preserve visible text in its original language and do not speculate. File name: ${fileName}.` },
        { inlineData: { data, mimeType } },
      ], { signal });
      signal?.throwIfAborted();
      return result.response.text().trim() || null;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  throw normalizeCloudError(lastError ?? new Error(localize("Unable to describe the image.", "Không thể mô tả ảnh.")));
}

const MAX_INLINE_VIDEO_BYTES = 18 * 1024 * 1024;

async function blobAsBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    reader.onerror = () => {
      cleanup();
      reject(reader.error ?? new Error(localize("Unable to read the media data.", "Không đọc được dữ liệu media.")));
    };
    reader.onabort = () => {
      cleanup();
      reject(new DOMException(localize("Media reading stopped.", "Đã dừng đọc dữ liệu."), "AbortError"));
    };
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result).split(",")[1] ?? "");
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Converts a short MP4 into searchable evidence in the active UI language. Raw container
 * bytes are never decoded as UTF-8; Gemini receives the declared video MIME
 * type and returns timeline/transcript text that can safely be chunked.
 */
export async function describeVideoWithCloud(video: Blob, fileName: string, cloudApiKey = getStoredCloudApiKey(), signal?: AbortSignal): Promise<string> {
  if (!cloudApiKey) throw new Error(localize(
    "An active Gemini API key is required to understand MP4 speech, text, and visuals.",
    "Video MP4 cần Gemini API key để nhận dạng lời nói, chữ và hình ảnh. Hãy nhập key rồi thử lại.",
  ));
  if (video.size > MAX_INLINE_VIDEO_BYTES) {
    throw new Error(localize(
      "This video is larger than 18 MB. The browser can analyze short videos directly; larger videos need a server-side media upload flow.",
      "Video lớn hơn 18 MB. Bản trình duyệt chỉ phân tích trực tiếp video ngắn; video lớn cần luồng upload media phía máy chủ.",
    ));
  }
  const data = await blobAsBase64(video, signal);
  const client = new GoogleGenerativeAI(cloudApiKey.trim());
  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    try {
      signal?.throwIfAborted();
      const responseLanguage = currentLanguage() === "vi" ? "Vietnamese" : "English";
      const result = await client.getGenerativeModel({ model: modelName }).generateContent([
        { inlineData: { data, mimeType: "video/mp4" } },
        { text: `Analyze video “${fileName}” into searchable RAG evidence written in ${responseLanguage}.
Return natural text, not JSON, containing:
- An accurate summary of the content and purpose.
- A timeline with [MM:SS] markers for important scenes or events.
- Important speech or sounds; state when there is no speech.
- Visible on-screen text in its original language, people or objects, places, and actions.
Do not speculate about identities or events that cannot be observed.` },
      ], { signal });
      signal?.throwIfAborted();
      const text = result.response.text().trim();
      if (!text) throw new Error(localize("Gemini did not extract any content from the video.", "Gemini không trích xuất được nội dung video."));
      return text;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  throw normalizeCloudError(lastError ?? new Error(localize("Unable to analyze the video.", "Không thể phân tích video.")));
}

export interface CloudDocumentMetadata {
  title?: string;
  aliases?: string[];
  authors?: string[];
}

/** This is called only after the user explicitly enables Cloud document analysis. */
export async function analyzeDocumentCoverWithCloud(cover: Blob, fileName: string, cloudApiKey = getStoredCloudApiKey(), signal?: AbortSignal): Promise<CloudDocumentMetadata | null> {
  if (!cloudApiKey) return null;
  const data = await blobAsBase64(cover, signal);
  const client = new GoogleGenerativeAI(cloudApiKey);
  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    try {
      signal?.throwIfAborted();
      const result = await client.getGenerativeModel({ model: modelName }).generateContent([
        { text: `Read the cover of ${fileName}. Return valid JSON only, without Markdown: {"title":"exact title or empty string","aliases":[],"authors":[]}. Preserve names in their original language. Do not use a chapter name, preface, publisher, or URL as the book title.` },
        { inlineData: { data, mimeType: cover.type || "image/jpeg" } },
      ], { signal });
      signal?.throwIfAborted();
      const raw = result.response.text().replace(/^```(?:json)?|```$/g, "").trim();
      const parsed = JSON.parse(raw) as CloudDocumentMetadata;
      return parsed.title?.trim() ? parsed : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(localize("Unable to read the cover with Cloud AI.", "Không thể nhận dạng bìa bằng Cloud."));
}

export async function ocrPageWithCloud(imageBlob: Blob, cloudApiKey = getStoredCloudApiKey(), signal?: AbortSignal): Promise<string | null> {
  if (!cloudApiKey) return null;
  const data = await blobAsBase64(imageBlob, signal);
  const client = new GoogleGenerativeAI(cloudApiKey);
  let lastError: unknown;
  for (const modelName of CLOUD_MODELS) {
    try {
      signal?.throwIfAborted();
      const result = await client.getGenerativeModel({ model: modelName }).generateContent([
        { text: "Extract all visible text accurately with OCR. Preserve the original language and row/column structure when present. Do not translate, paraphrase, or describe the image." },
        { inlineData: { data, mimeType: imageBlob.type || "image/jpeg" } },
      ], { signal });
      signal?.throwIfAborted();
      return result.response.text().trim() || null;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (shouldStopModelFallback(error)) throw normalizeCloudError(error);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(localize("Unable to extract text from the image.", "Không thể trích xuất văn bản từ ảnh."));
}
