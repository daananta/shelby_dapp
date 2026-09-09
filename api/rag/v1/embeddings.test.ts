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
  it.each([
    null,
    { embeddings: [] },
    { embeddings: [null] },
    { embeddings: [{ values: [1, 2, 3] }] },
    { embeddings: [{ values: Array(768).fill("1") }] },
    { embeddings: [{ values: Array(768).fill(0) }] },
    { embeddings: [{ values: Array(768).fill(null) }] },
  ])("rejects malformed provider output (case %#)", async (payload) => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.GEMINI_API_KEY = "server-only-test-key";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recorder = responseRecorder();
    await handler({ method: "POST", headers: { origin: "https://example.test" }, body: { texts: ["passage"] } }, recorder.response);
    expect(recorder.read().statusCode).toBe(502);
  });

  it("normalizes valid vectors and shares one deadline across both upstream batches", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.GEMINI_API_KEY = "server-only-test-key";
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      return Response.json({ embeddings: body.requests.map(() => ({ values: Array(768).fill(1e200) })) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const recorder = responseRecorder();
    await handler({ method: "POST", headers: { origin: "https://example.test" }, body: { texts: Array(21).fill("passage") } }, recorder.response);
    expect(recorder.read().statusCode).toBe(200);
    const payload = recorder.read().payload as { vectors: number[][]; dimensions: number };
    expect(payload.dimensions).toBe(768);
    expect(payload.vectors).toHaveLength(21);
    expect(Math.hypot(...payload.vectors[0])).toBeCloseTo(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal);
  });

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
