import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedAiError, streamHostedAgentAnswer } from "@/utils/openRouterProvider";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("hosted Qwen agent", () => {
  it("answers general questions without exposing a provider key to the browser request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      message: { role: "assistant", content: "Shelby is hot storage.", tool_calls: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onChunk = vi.fn();
    const handlers = {
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: vi.fn(),
    };

    await expect(streamHostedAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "What is Shelby?" }] }],
        systemInstruction: "Answer naturally.",
      },
      onChunk,
      handlers,
    )).resolves.toBe("Shelby is hot storage.");

    expect(onChunk).toHaveBeenCalledWith("Shelby is hot storage.");
    expect(handlers.searchKnowledge).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/v1/chat");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(String(init.body)).not.toContain("sk-or-");
  });

  it("executes a local RAG tool and returns its result to Qwen in a bounded second request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          reasoning_details: [{ type: "reasoning.summary", summary: "Need the user's document." }],
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "search_user_knowledge", arguments: "{\"query\":\"Shelby read flow\"}" },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "Shelby reconstructs the requested bytes [S1]." },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const searchKnowledge = vi.fn().mockResolvedValue({
      found: true,
      evidence: [{ citation: "S1", excerpt: "The RPC reconstructs requested bytes." }],
    });

    const answer = await streamHostedAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "How does the document describe reads?" }] }],
        systemInstruction: "Use citations.",
      },
      vi.fn(),
      { searchKnowledge, getWalletBlobInventory: vi.fn() },
    );

    expect(answer).toContain("[S1]");
    expect(searchKnowledge).toHaveBeenCalledWith({ query: "Shelby read flow" }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: expect.any(Array),
        reasoning_details: [{ type: "reasoning.summary", summary: "Need the user's document." }],
      }),
      expect.objectContaining({ role: "tool", tool_call_id: "call-1" }),
    ]));
  });

  it("surfaces hosted rate limits without treating them as a rejected user key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ kind: "rate_limit" }, 429)));

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory: vi.fn() },
    )).rejects.toMatchObject({ name: "HostedAiError", kind: "rate_limit", status: 429 } satisfies Partial<HostedAiError>);
  });
});
