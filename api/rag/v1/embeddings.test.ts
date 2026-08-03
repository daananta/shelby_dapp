import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./embeddings";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
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
  return { response, read: () => ({ statusCode, payload, headers }) };
}

describe("hosted embedding gateway", () => {
  it("reports an upstream timeout separately from a provider failure", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.GEMINI_API_KEY = "server-only-test-key";
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.150" },
      body: { texts: ["bounded passage"], kind: "passage" },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 504,
      payload: { error: "Embedding provider timed out", kind: "timeout" },
    });
  });
});
