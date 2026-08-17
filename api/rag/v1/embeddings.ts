type HeaderValue = string | string[] | undefined;
type RequestLike = { method?: string; body?: unknown; headers?: Record<string, HeaderValue>; socket?: { remoteAddress?: string } };
type ResponseLike = {
  status: (code: number) => ResponseLike;
  setHeader: (name: string, value: string) => void;
  json: (value: unknown) => void;
};

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents";
const MAX_TEXTS = 32;
const MAX_TEXT_LENGTH = 4_000;
const MAX_TOTAL_CHARACTERS = 64_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const rateBuckets = new Map<string, { count: number; resetsAt: number }>();

class EmbeddingProviderError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(`Embedding provider returned ${status}`);
  }
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.message.toLowerCase().includes("timed out"));
}

function firstHeader(value: HeaderValue) {
  return Array.isArray(value) ? value[0] : value;
}

function allowedOrigin() {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
}

function isOriginAllowed(request: RequestLike) {
  const origin = firstHeader(request.headers?.origin)?.replace(/\/$/, "");
  if (
    process.env.NODE_ENV !== "production"
    && origin
    && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))
  ) {
    return true;
  }
  const expected = allowedOrigin();
  if (!expected) return process.env.NODE_ENV !== "production";
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

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

/** Same-origin Vercel gateway. Set GEMINI_API_KEY only in the deployment environment. */
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
    response.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    response.status(503).json({ error: "RAG gateway is not configured" });
    return;
  }

  const body = request.body as { texts?: unknown; kind?: unknown } | undefined;
  const texts = Array.isArray(body?.texts) && body.texts.every((value): value is string => typeof value === "string") ? body.texts : [];
  const kind = body?.kind === "query" ? "query" : "passage";
  if (!texts.length || texts.length > MAX_TEXTS || texts.some((text) => !text.trim() || text.length > MAX_TEXT_LENGTH) || texts.reduce((sum, text) => sum + text.length, 0) > MAX_TOTAL_CHARACTERS) {
    response.status(400).json({ error: "Invalid embedding batch" });
    return;
  }

  try {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 20) {
      const batch = texts.slice(offset, offset + 20);
      const upstream = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: "models/gemini-embedding-001",
            content: { parts: [{ text }] },
            taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: 768,
          })),
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!upstream.ok) throw new EmbeddingProviderError(upstream.status, upstream.headers.get("retry-after") ?? undefined);
      const payload = await upstream.json() as { embeddings?: Array<{ values?: number[] }> };
      const batchVectors = payload.embeddings?.map((item) => item.values ?? []) ?? [];
      if (batchVectors.length !== batch.length || batchVectors.some((vector) => !vector.length)) throw new Error("Gemini embedding response was incomplete");
      vectors.push(...batchVectors.map(normalize));
    }
    response.status(200).json({ vectors, model: "gemini-embedding-001", dimensions: 768 });
  } catch (error) {
    console.error("RAG gateway embedding failure", error);
    if (isTimeoutError(error)) {
      response.status(504).json({ error: "Embedding provider timed out", kind: "timeout" });
      return;
    }
    if (error instanceof EmbeddingProviderError) {
      if (error.retryAfter) response.setHeader("Retry-After", error.retryAfter);
      if (error.status === 429) {
        response.status(429).json({ error: "Embedding quota is temporarily exhausted", kind: "rate_limit" });
        return;
      }
      if (error.status === 401 || error.status === 403) {
        response.status(503).json({ error: "Embedding gateway credentials are unavailable", kind: "provider_auth" });
        return;
      }
    }
    response.status(502).json({ error: "Embedding provider unavailable" });
  }
}
