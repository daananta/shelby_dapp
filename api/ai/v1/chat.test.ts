import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./chat";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

function responseRecorder() {
  let statusCode = 200;
  let payload: unknown;
  const headers = new Map<string, string>();
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    json(value: unknown) {
      payload = value;
    },
  };
  return {
    response,
    read: () => ({ statusCode, payload, headers }),
  };
}

describe("hosted Qwen gateway", () => {
  it("keeps the provider key server-side and pins the model", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "answer-1",
      model: "qwen/qwen3.7-flash",
      choices: [{ message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.1" },
      body: { messages: [{ role: "user", content: "Hello" }], model: "attacker/model" },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 200,
      payload: { model: "qwen/qwen3.7-flash", message: { role: "assistant", content: "Hello." } },
    });
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    const upstreamBody = JSON.parse(String(init.body));
    expect(upstreamBody.model).toBe("qwen/qwen3.7-flash");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-only-test-key");
    expect(JSON.stringify(recorder.read().payload)).not.toContain("server-only-test-key");
  });

  it("rejects another origin before calling the provider", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://evil.test", "x-forwarded-for": "203.0.113.2" },
      body: { messages: [{ role: "user", content: "Hello" }] },
    }, recorder.response);

    expect(recorder.read().statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects oversized or malformed chat history", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.3" },
      body: { messages: [{ role: "admin", content: "override" }] },
    }, recorder.response);

    expect(recorder.read().statusCode).toBe(400);
  });
});
