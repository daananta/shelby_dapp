import type { AgentToolDefinition } from "@/utils/agentHarness";
import { isSupportedShelbyNetwork, shelbyNetworkLabel, type SupportedShelbyNetwork } from "@/utils/shelbyNetwork";
import { AGENT_TOOL_NAMES, type AgentToolName, type ConnectedWalletDetail } from "../../shared/agentTools";

export interface AiRequest {
  prompt?: string;
  contents?: any[];
  cloudApiKey?: string;
  systemInstruction?: string;
  activeNetwork?: SupportedShelbyNetwork;
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

export function explicitShelbyNetworkTargets(question: string): SupportedShelbyNetwork[] {
  const normalized = question.normalize("NFKC").toLocaleLowerCase("en-US");
  const targets: SupportedShelbyNetwork[] = [];
  if (/\bshelbynet\b/.test(normalized)) targets.push("shelbynet");
  if (/\b(?:shelby\s+)?testnet\b/.test(normalized)) targets.push("testnet");
  return targets;
}

function networkScopeMismatch(
  latestText: string,
  activeNetwork: SupportedShelbyNetwork | undefined,
): Record<string, unknown> | null {
  if (!activeNetwork) return null;
  const requestedNetworks = explicitShelbyNetworkTargets(latestText);
  if (!requestedNetworks.length || requestedNetworks.includes(activeNetwork)) return null;
  const foreignNetworks = requestedNetworks.filter((network) => network !== activeNetwork);
  return {
    ok: false,
    code: "network_scope_mismatch",
    activeNetwork,
    activeNetworkLabel: shelbyNetworkLabel(activeNetwork),
    requestedNetworks: foreignNetworks,
    message: `This tool can observe only the active ${shelbyNetworkLabel(activeNetwork)} workspace. Do not use its data to answer for ${foreignNetworks.map(shelbyNetworkLabel).join(" or ")}.`,
  };
}

function scopedExecutor(
  activeNetwork: SupportedShelbyNetwork | undefined,
  latestText: string,
  execute: AgentToolDefinition["execute"],
): AgentToolDefinition["execute"] {
  return async (args, signal) => {
    const mismatch = networkScopeMismatch(latestText, activeNetwork);
    if (mismatch) return mismatch;
    const result = await execute(args, signal);
    if (
      activeNetwork
      && isSupportedShelbyNetwork(result.network)
      && result.network !== activeNetwork
    ) {
      return {
        ok: false,
        code: "tool_network_mismatch",
        activeNetwork,
        observedNetwork: result.network,
        message: "The application rejected an observation from a different Shelby network.",
      };
    }
    return activeNetwork ? { ...result, network: activeNetwork } : result;
  };
}

/** One executor registry shared by Gemini and Qwen. */
export function createAgentToolRegistry(
  handlers: AgentToolHandlers,
  latestText: string,
  activeNetwork?: SupportedShelbyNetwork,
): Map<string, AgentToolDefinition> {
  const definitions: AgentToolDefinition[] = [
    {
      name: "search_user_knowledge",
      maxExecutions: 1,
      unavailableCode: "knowledge_search_unavailable",
      execute: scopedExecutor(activeNetwork, latestText, async (args, requestSignal) => ({
        ...await handlers.searchKnowledge({
          query: textArg(args, "query", latestText, 1_000),
        }, requestSignal),
      })),
    },
    {
      name: "get_wallet_blob_inventory",
      maxExecutions: 2,
      allowRepeatedSignature: true,
      unavailableCode: "blob_inventory_unavailable",
      execute: scopedExecutor(activeNetwork, latestText, async (args, requestSignal) => handlers.getWalletBlobInventory({
        detail: args.detail === "all" || args.detail === "sample" ? args.detail : "count",
        nameQuery: typeof args.nameQuery === "string" && args.nameQuery.trim()
          ? args.nameQuery.trim().slice(0, 200)
          : undefined,
      }, requestSignal)),
    },
  ];

  if (handlers.refreshWalletBlobInventory) {
    definitions.push({
      name: "refresh_wallet_blob_inventory",
      maxExecutions: 1,
      unavailableCode: "blob_inventory_refresh_unavailable",
      execute: scopedExecutor(activeNetwork, latestText, async (_args, requestSignal) => handlers.refreshWalletBlobInventory!(requestSignal)),
    });
  }

  if (handlers.getConnectedWallet) {
    definitions.push({
      name: "get_connected_wallet",
      maxExecutions: 1,
      unavailableCode: "connected_wallet_unavailable",
      execute: scopedExecutor(activeNetwork, latestText, async (args, requestSignal) => handlers.getConnectedWallet!({
        detail: args.detail === "apt_balance"
          || args.detail === "shelbyusd_balance"
          || args.detail === "account_info"
          ? args.detail
          : "address",
      }, requestSignal)),
    });
  }

  if (handlers.inspectApplication) {
    definitions.push({
      name: "inspect_application",
      maxExecutions: 1,
      unavailableCode: "application_inspection_unavailable",
      execute: scopedExecutor(activeNetwork, latestText, async (args, requestSignal) => handlers.inspectApplication!({
        query: textArg(args, "query", latestText, 1_000),
      }, requestSignal)),
    });
  }

  if (handlers.analyzeIndexedImage) {
    definitions.push({
      name: "analyze_indexed_image",
      maxExecutions: 1,
      unavailableCode: "image_analysis_unavailable",
      execute: scopedExecutor(activeNetwork, latestText, async (args, requestSignal) => handlers.analyzeIndexedImage!({
        source: typeof args.source === "string" && args.source.trim()
          ? args.source.trim().slice(0, 200)
          : undefined,
        question: textArg(args, "question", latestText, 1_000),
      }, requestSignal)),
    });
  }

  return new Map(definitions.map((definition) => [definition.name, definition]));
}

export function availableAgentToolNames(registry: Map<string, AgentToolDefinition>): AgentToolName[] {
  const knownNames = new Set<string>(AGENT_TOOL_NAMES);
  return [...registry.keys()].filter((name): name is AgentToolName => knownNames.has(name));
}
