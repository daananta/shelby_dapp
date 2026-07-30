import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "../../api/rag/v1/embeddings";

const originalEnv = { ...process.env };

function responseMock() {
  const result: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const response = {
    status(code: number) { result.statusCode = code; return response; },
    setHeader(name: string, value: string) { result.headers[name] = value; },
    json(value: unknown) { result.body = value; },
  };
  return { response, result };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("embedding gateway boundary", () => {
  it("rejects unsupported methods before touching provider configuration", async () => {
    const { response, result } = responseMock();
    await handler({ method: "GET", headers: {} }, response);
    expect(result.statusCode).toBe(405);
  });

  it("rejects a cross-origin browser before consuming provider quota", async () => {
    process.env.APP_ORIGIN = "https://app.example";
    const { response, result } = responseMock();
    await handler({ method: "POST", body: { texts: ["hello"] }, headers: { origin: "https://evil.example" } }, response);
    expect(result.statusCode).toBe(403);
  });

  it("reports an intentionally unconfigured gateway without crashing", async () => {
    process.env.APP_ORIGIN = "https://app.example";
    delete process.env.GEMINI_API_KEY;
    const { response, result } = responseMock();
    await handler({
      method: "POST",
      body: { texts: [] },
      headers: { origin: "https://app.example", "x-forwarded-for": "203.0.113.8" },
    }, response);
    expect(result.statusCode).toBe(503);
  });

  it("rejects mixed-type batches instead of silently filtering them", async () => {
    process.env.APP_ORIGIN = "https://app.example";
    process.env.GEMINI_API_KEY = "server-secret";
    const { response, result } = responseMock();
    await handler({ method: "POST", body: { texts: ["valid", 42] }, headers: { origin: "https://app.example", "x-forwarded-for": "203.0.113.7" } }, response);
    expect(result.statusCode).toBe(400);
  });

  it("preserves provider rate-limit semantics for the client circuit breaker", async () => {
    process.env.APP_ORIGIN = "https://app.example";
    process.env.GEMINI_API_KEY = "server-secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "Quota exceeded" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "17" } },
    ));

    const { response, result } = responseMock();
    await handler({
      method: "POST",
      body: { texts: ["hello"] },
      headers: { origin: "https://app.example", "x-forwarded-for": "203.0.113.29" },
    }, response);

    expect(result.statusCode).toBe(429);
    expect(result.headers["Retry-After"]).toBe("17");
    expect(result.body).toMatchObject({ kind: "rate_limit" });
  });
});
