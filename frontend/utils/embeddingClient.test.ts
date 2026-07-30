import { afterEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "@/utils/embeddingClient";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini embedding credentials", () => {
  it("passes a new AQ authorization key unchanged", async () => {
    const authorizationKey = "AQ.mock-embedding-key";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe(authorizationKey);
      return new Response(JSON.stringify({
        embeddings: [{ values: [3, 4] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedTexts(["hello"], "passage", undefined, "gemini", ` ${authorizationKey} `))
      .resolves.toEqual([[0.6, 0.8]]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
