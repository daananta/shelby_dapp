import {
  AgentHarnessLimitError,
  DEFAULT_AGENT_HARNESS_BUDGET,
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

async function requestHostedChat(messages: OpenRouterMessage[], signal?: AbortSignal): Promise<HostedChatResponse["message"]> {
  signal?.throwIfAborted();
  const response = await fetch("/api/ai/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as HostedChatResponse & { error?: string; kind?: string };
  if (!response.ok) {
    if (response.status === 429 || payload.kind === "rate_limit") {
      throw new HostedAiError(
        "rate_limit",
        localize("Qwen is receiving too many requests. Please wait a moment and try again.", "Qwen đang nhận quá nhiều yêu cầu. Hãy chờ một chút rồi thử lại."),
        response.status,
      );
    }
    throw new HostedAiError(
      "unavailable",
      localize("Qwen is temporarily unavailable. Please try again shortly.", "Qwen đang tạm thời chưa sẵn sàng. Vui lòng thử lại sau ít phút."),
      response.status,
    );
  }
  if (!payload.message) {
    throw new HostedAiError(
      "invalid_response",
      localize("Qwen returned an incomplete response.", "Qwen trả về phản hồi chưa hoàn chỉnh."),
    );
  }
  return payload.message;
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
      execute: async (args, requestSignal) => handlers.getWalletBlobInventory({
        detail: args.detail === "all" || args.detail === "sample" ? args.detail : "count",
      }, requestSignal),
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

  const harnessState = createAgentHarnessState();
  let toolRound = 0;
  while (toolRound <= DEFAULT_AGENT_HARNESS_BUDGET.maxRounds) {
    signal?.throwIfAborted();
    const response = await requestHostedChat(messages, signal);
    const calls = parseToolCalls(response?.tool_calls);
    if (!calls.length) {
      const answer = typeof response?.content === "string" ? response.content.trim() : "";
      const finalAnswer = answer || localize(
        "There is not enough information for a confident answer.",
        "Không tìm thấy đủ thông tin để trả lời chắc chắn.",
      );
      signal?.throwIfAborted();
      onChunk(finalAnswer);
      return finalAnswer;
    }
    if (toolRound >= DEFAULT_AGENT_HARNESS_BUDGET.maxRounds) {
      throw new AgentHarnessLimitError("agent_round_limit");
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
    const batch = await executeAgentToolCalls({
      calls,
      registry: toolRegistry,
      state: harnessState,
      round: toolRound,
      signal,
    });
    batch.responses.forEach((part, index) => {
      messages.push({
        role: "tool",
        tool_call_id: calls[index]?.id ?? "",
        content: JSON.stringify(part.functionResponse.response),
      });
    });
  }
  throw new AgentHarnessLimitError("agent_round_limit");
}
