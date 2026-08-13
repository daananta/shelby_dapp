export const AGENT_TOOL_NAMES = [
  "search_user_knowledge",
  "get_wallet_blob_inventory",
  "refresh_wallet_blob_inventory",
  "get_connected_wallet",
  "inspect_application",
  "analyze_indexed_image",
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];

export const CONNECTED_WALLET_DETAILS = [
  "address",
  "apt_balance",
  "shelbyusd_balance",
  "account_info",
] as const;

export type ConnectedWalletDetail = typeof CONNECTED_WALLET_DETAILS[number];

export interface AgentToolSpec {
  type: "function";
  function: {
    name: AgentToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, Record<string, unknown>>;
      required?: readonly string[];
      additionalProperties: false;
    };
  };
}

/**
 * Provider-neutral runtime tool contract. Tool execution remains in the
 * browser; the hosted gateway receives only these schemas and tool messages.
 */
export const AGENT_TOOL_SPECS: readonly AgentToolSpec[] = [
  {
    type: "function",
    function: {
      name: "search_user_knowledge",
      description: "Search the user's private/imported documents in the active Shelby network workspace. Call only when the request depends on document content or follows up on document evidence. Never use for another network, wallet state, blob counts/lists, or general knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A self-contained semantic query that resolves conversational references without inventing a filename.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wallet_blob_inventory",
      description: "Read the connected wallet's latest app-cached blob inventory for the active Shelby network only. Use when the conversation needs blob counts, names, filters, or a missing detail about that inventory. A one-item inventory may include `singleton` even for a count request so you can resolve later references naturally. This does not refresh the network and must not answer for another network.",
      parameters: {
        type: "object",
        properties: {
          detail: {
            type: "string",
            enum: ["count", "sample", "all"],
            description: "Use count for totals, sample for a few examples, and all only when the user explicitly asks for every name.",
          },
          nameQuery: {
            type: "string",
            description: "Optional filename substring selected from the user's request, for example anime, pdf, or invoice.",
          },
        },
        required: ["detail"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_wallet_blob_inventory",
      description: "Refresh the connected wallet's inventory from the active Shelby network. Use only when the user explicitly requests current/live data or a previous inventory result is stale. Then call get_wallet_blob_inventory before answering. Never fall back to another network.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_connected_wallet",
      description: "Read the Aptos wallet currently connected to the active Shelby network workspace. Call whenever the user asks for their connected wallet address, APT or ShelbyUSD balance, sequence number, authentication key, or connected-wallet identity. A public wallet address may be shown to its user; never request or expose a private key or recovery phrase.",
      parameters: {
        type: "object",
        properties: {
          detail: {
            type: "string",
            enum: CONNECTED_WALLET_DETAILS,
            description: "Select the exact public wallet fact requested by the user.",
          },
        },
        required: ["detail"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_application",
      description: "Use read-only local app capabilities scoped to the active Shelby network for indexed image names/previews, indexed document metadata, assistant identity, or deterministic calculations. Use this to list indexed images or show/open a named image; it does not inspect image pixels. Do not use for another network, wallet/account facts, document content, or generic Shelby blob counts/lists.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A self-contained version of the user's read-only app request.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_indexed_image",
      description: "Inspect the original pixels of an image indexed in the active Shelby network workspace. Call when the answer requires visual contents, readable text, objects, actions, or supporting visual details. Do not use an image from another network or call merely to list image names or attach an existing preview.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "The exact indexed filename when known. Omit only when the preceding conversation unambiguously identifies one image.",
          },
          question: {
            type: "string",
            description: "The self-contained visual question to answer from the original pixels, preserving the user's requested detail and language.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
];

export function selectAgentToolSpecs(names: ReadonlySet<string>): AgentToolSpec[] {
  return AGENT_TOOL_SPECS.filter((tool) => names.has(tool.function.name));
}
