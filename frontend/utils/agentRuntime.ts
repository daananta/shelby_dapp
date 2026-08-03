import type { AgentToolDefinition } from "@/utils/agentHarness";
import { asksForLiveInventoryRefresh, classifyQueryIntent } from "@/utils/queryRouter";
import { AGENT_TOOL_NAMES, type AgentToolName, type ConnectedWalletDetail } from "../../shared/agentTools";

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
  nameQuery?: string;
}

export interface ConnectedWalletRequest {
  detail: ConnectedWalletDetail;
}

export interface ApplicationInspectionRequest {
  query: string;
}

export interface IndexedImageAnalysisRequest {
  /** Exact indexed source when known. Omit to use the most recent image context. */
  source?: string;
  /** Self-contained visual task chosen by the model from the user's request. */
  question: string;
}

export interface AgentToolHandlers {
  searchKnowledge: (request: KnowledgeSearchRequest, signal?: AbortSignal) => Promise<KnowledgeSearchResponse>;
  getWalletBlobInventory: (request: BlobInventoryAgentRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  refreshWalletBlobInventory?: (signal?: AbortSignal) => Promise<Record<string, unknown>>;
  getConnectedWallet?: (request: ConnectedWalletRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  inspectApplication?: (request: ApplicationInspectionRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  analyzeIndexedImage?: (request: IndexedImageAnalysisRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>;
}

function textArg(args: Record<string, unknown>, key: string, fallback: string, maxLength: number) {
  const value = args[key];
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

/** One executor registry shared by Gemini and Qwen. */
export function createAgentToolRegistry(
  handlers: AgentToolHandlers,
  latestText: string,
): Map<string, AgentToolDefinition> {
  const definitions: AgentToolDefinition[] = [
    {
      name: "search_user_knowledge",
      maxExecutions: 1,
      unavailableCode: "knowledge_search_unavailable",
      execute: async (args, requestSignal) => ({
        ...await handlers.searchKnowledge({
          query: textArg(args, "query", latestText, 1_000),
        }, requestSignal),
      }),
    },
    {
      name: "get_wallet_blob_inventory",
      maxExecutions: 2,
      allowRepeatedSignature: true,
      unavailableCode: "blob_inventory_unavailable",
      execute: async (args, requestSignal) => handlers.getWalletBlobInventory({
        detail: args.detail === "all" || args.detail === "sample" ? args.detail : "count",
        nameQuery: typeof args.nameQuery === "string" && args.nameQuery.trim()
          ? args.nameQuery.trim().slice(0, 200)
          : undefined,
      }, requestSignal),
    },
  ];

  if (handlers.refreshWalletBlobInventory) {
    definitions.push({
      name: "refresh_wallet_blob_inventory",
      maxExecutions: 1,
      unavailableCode: "blob_inventory_refresh_unavailable",
      execute: async (_args, requestSignal) => handlers.refreshWalletBlobInventory!(requestSignal),
    });
  }

  if (handlers.getConnectedWallet) {
    definitions.push({
      name: "get_connected_wallet",
      maxExecutions: 1,
      unavailableCode: "connected_wallet_unavailable",
      execute: async (args, requestSignal) => handlers.getConnectedWallet!({
        detail: args.detail === "apt_balance"
          || args.detail === "shelbyusd_balance"
          || args.detail === "account_info"
          ? args.detail
          : "address",
      }, requestSignal),
    });
  }

  if (handlers.inspectApplication) {
    definitions.push({
      name: "inspect_application",
      maxExecutions: 1,
      unavailableCode: "application_inspection_unavailable",
      execute: async (args, requestSignal) => handlers.inspectApplication!({
        query: textArg(args, "query", latestText, 1_000),
      }, requestSignal),
    });
  }

  if (handlers.analyzeIndexedImage) {
    definitions.push({
      name: "analyze_indexed_image",
      maxExecutions: 1,
      unavailableCode: "image_analysis_unavailable",
      execute: async (args, requestSignal) => handlers.analyzeIndexedImage!({
        source: typeof args.source === "string" && args.source.trim()
          ? args.source.trim().slice(0, 200)
          : undefined,
        question: textArg(args, "question", latestText, 1_000),
      }, requestSignal),
    });
  }

  return new Map(definitions.map((definition) => [definition.name, definition]));
}

export function availableAgentToolNames(registry: Map<string, AgentToolDefinition>): AgentToolName[] {
  const knownNames = new Set<string>(AGENT_TOOL_NAMES);
  return [...registry.keys()].filter((name): name is AgentToolName => knownNames.has(name));
}

/**
 * Model-first routing guard. It never extracts arguments or writes an answer;
 * it only detects when accepting a tool-free answer would violate an app-data
 * trust boundary.
 */
export function requiredObservationPlan(
  question: string,
  availableTools: readonly AgentToolName[],
): AgentToolName[][] {
  const intent = classifyQueryIntent(question).intent;
  const needsPixelInspection = /(?:what (?:is|can be) visible|what (?:do|can) you see|visible details?|visual details?|describe|depict|read (?:the )?text|chi tiết (?:nhìn thấy|thị giác|trong ảnh)|nhìn thấy gì|mô tả|đọc (?:chữ|văn bản))/i.test(question);
  const candidates: AgentToolName[] = intent === "wallet"
    ? ["get_connected_wallet"]
    : intent === "inventory"
      ? ["get_wallet_blob_inventory"]
      : intent === "image"
        ? needsPixelInspection
          ? ["analyze_indexed_image", "inspect_application"]
          : ["inspect_application", "analyze_indexed_image"]
        : intent === "general"
          ? []
          : intent === "metadata"
            ? ["search_user_knowledge", "inspect_application"]
            : ["search_user_knowledge"];
  const available = new Set(availableTools);
  if (intent === "image") {
    // Require the strongest available observation for the request. Returning
    // both would let a metadata-only preview satisfy a pixel-analysis turn.
    const selected = candidates.find((name) => available.has(name));
    return selected ? [[selected]] : [];
  }
  const alternatives = candidates.filter((name) => available.has(name));
  if (!alternatives.length) return [];
  if (
    intent === "inventory"
    && asksForLiveInventoryRefresh(question)
    && available.has("refresh_wallet_blob_inventory")
  ) {
    return [["refresh_wallet_blob_inventory"], alternatives];
  }
  return [alternatives];
}

export function createMissingObservationInstruction(requiredTools: readonly AgentToolName[]): string {
  return [
    "Your draft answered a request for user-specific application data without observing the application.",
    `Call the single most relevant available tool now (${requiredTools.join(" or ")}).`,
    "Choose its arguments from the user's request and conversation; do not guess or ask the user to look elsewhere.",
    "After receiving the observation, answer naturally in the user's language without mentioning this correction.",
  ].join(" ");
}
