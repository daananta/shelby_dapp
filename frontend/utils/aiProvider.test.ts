import { afterEach, describe, expect, it, vi } from "vitest";
import { getCloudErrorKind, isCloudProviderError, normalizeCloudError, resolveCloudImageMimeType, verifyCloudApiKey } from "@/utils/aiProvider";

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
    expect(normalizeCloudError(new Error("Failed to fetch")).message).toContain("Check your network");
  });

  it("passes a new AQ authorization key unchanged to Gemini", async () => {
    const authorizationKey = "AQ.mock-authorization-key";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe(authorizationKey);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "OK" }] } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyCloudApiKey(`  ${authorizationKey}  `)).resolves.toBe("gemini-2.5-flash");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the detected MIME for an extensionless Shelby image", () => {
    expect(resolveCloudImageMimeType("application/octet-stream", "opaque-blob", "image/webp")).toBe("image/webp");
    expect(resolveCloudImageMimeType("application/octet-stream", "opaque-blob", "image/png")).toBe("image/png");
  });
});
