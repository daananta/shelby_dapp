type HeaderValue = string | string[] | undefined;
type RequestLike = {
  method?: string;
  body?: unknown;
  headers?: Record<string, HeaderValue>;
  socket?: { remoteAddress?: string };
};
type ResponseLike = {
  status: (code: number) => ResponseLike;
  setHeader: (name: string, value: string) => void;
  json: (value: unknown) => void;
};

type ChatRole = "system" | "user" | "assistant" | "tool";
type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_call_id?: string;
  reasoning_details?: unknown[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "qwen/qwen3.7-flash";
const MAX_BODY_BYTES = 160 * 1024;
const MAX_MESSAGES = 32;
const MAX_TOTAL_CONTENT = 120_000;
const MAX_OUTPUT_TOKENS = 1_200;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 15;
const ALLOWED_TOOL_NAMES = new Set([
  "search_user_knowledge",
  "get_wallet_blob_inventory",
  "refresh_wallet_blob_inventory",
]);
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_user_knowledge",
      description: "Search the user's private/imported Shelby documents. Call only when the request depends on document content or follows up on document evidence. Never use for wallet state, blob counts/lists, or general knowledge.",
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
      description: "Read the connected wallet's latest app-cached Shelby blob inventory. Use for blob counts/lists and follow-ups that ask to confirm an inventory answer.",
      parameters: {
        type: "object",
        properties: {
          detail: { type: "string", enum: ["count", "sample", "all"] },
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
      description: "Refresh the connected wallet's Shelby inventory. Use only when the user explicitly requests current/live data or the inventory tool reports a stale snapshot. Then call get_wallet_blob_inventory before answering.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
] as const;

function firstHeader(value: HeaderValue) {
  return Array.isArray(value) ? value[0] : value;
}

function allowedOrigin() {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
}

function isOriginAllowed(request: RequestLike) {
  const expected = allowedOrigin();
  if (!expected) return process.env.NODE_ENV !== "production";
  const origin = firstHeader(request.headers?.origin)?.replace(/\/$/, "");
  if (!origin) return process.env.RAG_GATEWAY_ALLOW_SERVER_CALLS === "true";
  return origin === expected;
}

function consumeRateLimit(request: RequestLike) {
  const forwarded = firstHeader(request.headers?.["x-forwarded-for"])?.split(",")[0]?.trim();
  const identity = forwarded || request.socket?.remoteAddress || "unknown";
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [key, value] of rateBuckets) if (value.resetsAt <= now) rateBuckets.delete(key);
  }
  const bucket = rateBuckets.get(identity);
  if (!bucket || bucket.resetsAt <= now) {
    rateBuckets.set(identity, { count: 1, resetsAt: now + RATE_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeToolCalls(value: unknown): ChatMessage["tool_calls"] {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const calls: NonNullable<ChatMessage["tool_calls"]> = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) return undefined;
    const id = typeof item.id === "string" ? item.id.slice(0, 200) : "";
    const name = typeof item.function.name === "string" ? item.function.name : "";
    const args = typeof item.function.arguments === "string" ? item.function.arguments : "";
    if (!id || !ALLOWED_TOOL_NAMES.has(name) || args.length > 4_000) return undefined;
    calls.push({ id, type: "function", function: { name, arguments: args } });
  }
  return calls.length ? calls : undefined;
}

function sanitizeMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_MESSAGES) return null;
  let totalContent = 0;
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const role = item.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return null;
    const content = item.content === null ? null : typeof item.content === "string" ? item.content : null;
    if (role !== "assistant" && !content) return null;
    totalContent += content?.length ?? 0;
    if (totalContent > MAX_TOTAL_CONTENT) return null;
    if (role === "tool") {
      const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id.slice(0, 200) : "";
      if (!toolCallId) return null;
      messages.push({ role, content, tool_call_id: toolCallId });
      continue;
    }
    if (role === "assistant") {
      const toolCalls = sanitizeToolCalls(item.tool_calls);
      const reasoningDetails = Array.isArray(item.reasoning_details)
        && JSON.stringify(item.reasoning_details).length <= 16_000
        ? item.reasoning_details
        : undefined;
      if (!content && !toolCalls) return null;
      messages.push({
        role,
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
        ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
      });
      continue;
    }
    messages.push({ role, content });
  }
  return messages;
}

class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(`OpenRouter returned ${status}`);
  }
}

/** Same-origin Vercel gateway. The OpenRouter credential remains server-only. */
export default async function handler(request: RequestLike, response: ResponseLike) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Vary", "Origin");
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!isOriginAllowed(request)) {
    response.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (!consumeRateLimit(request)) {
    response.setHeader("Retry-After", "60");
    response.status(429).json({ error: "AI request limit exceeded", kind: "rate_limit" });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    response.status(503).json({ error: "Hosted AI is not configured" });
    return;
  }

  let bodyBytes = 0;
  try {
    bodyBytes = Buffer.byteLength(JSON.stringify(request.body ?? null));
  } catch {
    response.status(400).json({ error: "Invalid request" });
    return;
  }
  const body = isRecord(request.body) ? request.body : {};
  const messages = bodyBytes <= MAX_BODY_BYTES ? sanitizeMessages(body.messages) : null;
  if (!messages) {
    response.status(400).json({ error: "Invalid chat request" });
    return;
  }

  try {
    const upstream = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": allowedOrigin() ?? "https://shelby-rag-explorer.vercel.app",
        "X-Title": "Shelby RAG Explorer",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!upstream.ok) throw new UpstreamError(upstream.status, upstream.headers.get("retry-after") ?? undefined);
    const payload = await upstream.json() as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: unknown; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = payload.choices?.[0]?.message;
    if (!isRecord(message)) throw new Error("OpenRouter response was incomplete");
    response.status(200).json({
      id: payload.id,
      model: payload.model ?? MODEL,
      message,
      finishReason: payload.choices?.[0]?.finish_reason,
      usage: payload.usage,
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      if (error.retryAfter) response.setHeader("Retry-After", error.retryAfter);
      if (error.status === 429) {
        response.status(429).json({ error: "Hosted AI is temporarily busy", kind: "rate_limit" });
        return;
      }
      if (error.status === 401 || error.status === 403) {
        response.status(503).json({ error: "Hosted AI credentials are unavailable", kind: "provider_auth" });
        return;
      }
    }
    console.error("Hosted AI gateway failure", error instanceof Error ? error.message : "unknown error");
    response.status(502).json({ error: "Hosted AI is unavailable" });
  }
}
