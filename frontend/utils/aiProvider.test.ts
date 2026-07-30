import { afterEach, describe, expect, it, vi } from "vitest";
import { generateCloudAnswer, getCloudErrorKind, isCloudProviderError, normalizeCloudError, resolveCloudImageMimeType, verifyCloudApiKey } from "@/utils/aiProvider";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini error messages", () => {
  it("treats a 429 as a temporary limit rather than a rejected key", () => {
    const providerError = normalizeCloudError({ status: 429 });
    expect(providerError.message).toContain("429");
    expect(isCloudProviderError(providerError)).toBe(true);
    expect(isCloudProviderError({ status: 429 })).toBe(false);
    expect(normalizeCloudError(new Error("RESOURCE_EXHAUSTED: quota exceeded")).message).toContain("was not rejected");
    expect(getCloudErrorKind(new Error("RESOURCE_EXHAUSTED"))).toBe("rate_limit");
  });

  it("distinguishes invalid keys and network failures", () => {
    expect(normalizeCloudError({ status: 401 }).message).toContain("API key is invalid");
    expect(getCloudErrorKind(new Error("UNAUTHENTICATED: API key not valid"))).toBe("invalid_key");
    expect(getCloudErrorKind(new Error("ACCESS_TOKEN_TYPE_UNSUPPORTED"))).toBe("invalid_key");
    expect(getCloudErrorKind(Object.assign(new Error("PERMISSION_DENIED: service account lacks model access"), { status: 403 }))).toBe("other");
    expect(normalizeCloudError(new Error("Failed to fetch")).message).toContain("Check your network");
  });

  it("passes a new AQ authorization key unchanged to Gemini", async () => {
    const authorizationKey = "AQ.mock-authorization-key";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe(authorizationKey);
      return new Response(JSON.stringify({
        models: [{
          name: "models/gemini-3.6-flash",
          supportedGenerationMethods: ["generateContent"],
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyCloudApiKey(`  ${authorizationKey}  `)).resolves.toBe("gemini-3.6-flash");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("does not misreport a generation quota as an invalid credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "RESOURCE_EXHAUSTED: project quota exceeded" },
    }), {
      status: 429,
      headers: { "content-type": "application/json" },
    })));

    await expect(verifyCloudApiKey("AQ.rate-limited-key")).rejects.toMatchObject({
      kind: "rate_limit",
    });
  });

  it("rejects a key only when Gemini rejects its authentication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "API key not valid" },
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })));

    await expect(verifyCloudApiKey("AQ.invalid-key")).rejects.toMatchObject({
      kind: "invalid_key",
    });
  });

  it("tries another supported model after a model-specific 429", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("gemini-3.6-flash")) {
        return new Response(JSON.stringify({
          error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota unavailable for this model" },
        }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "fallback answer" }] } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateCloudAnswer({
      prompt: "Hello",
      cloudApiKey: "AQ.model-fallback-key",
    })).resolves.toBe("fallback answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the detected MIME for an extensionless Shelby image", () => {
    expect(resolveCloudImageMimeType("application/octet-stream", "opaque-blob", "image/webp")).toBe("image/webp");
    expect(resolveCloudImageMimeType("application/octet-stream", "opaque-blob", "image/png")).toBe("image/png");
  });
});
