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

  it("lets Qwen select a filename filter for the inventory tool", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "inventory-1",
            type: "function",
            function: {
              name: "get_wallet_blob_inventory",
              arguments: "{\"detail\":\"sample\",\"nameQuery\":\"anime\"}",
            },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: "I found two anime blobs: anime2.jpeg and anime-avatar.jpg.",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const getWalletBlobInventory = vi.fn().mockResolvedValue({
      ok: true,
      count: 36,
      nameQuery: "anime",
      matchedCount: 2,
      matches: ["anime2.jpeg", "anime-avatar.jpg"],
      freshness: "stale_cache",
    });

    const answer = await streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Which anime blobs do I have?" }] }] },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory },
    );

    expect(answer).toContain("anime2.jpeg");
    expect(getWalletBlobInventory).toHaveBeenCalledWith({
      detail: "sample",
      nameQuery: "anime",
    }, undefined);
  });

  it("lets Qwen phrase a deterministic application observation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "app-1",
            type: "function",
            function: {
              name: "inspect_application",
              arguments: "{\"query\":\"Show my indexed anime images\"}",
            },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: "I found two indexed anime images and attached their previews.",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const inspectApplication = vi.fn().mockResolvedValue({
      ok: true,
      kind: "show_images",
      previewCount: 2,
    });

    const answer = await streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Show my indexed anime images" }] }] },
      vi.fn(),
      {
        searchKnowledge: vi.fn(),
        getWalletBlobInventory: vi.fn(),
        inspectApplication,
      },
    );

    expect(answer).toContain("two indexed anime images");
    expect(inspectApplication).toHaveBeenCalledWith(
      { query: "Show my indexed anime images" },
      undefined,
    );
  });

  it("forces a final answer after three image-related tool rounds instead of exposing agent_round_limit", async () => {
    const toolCall = (id: string, name: string, args: object) => jsonResponse({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(toolCall("inventory-1", "get_wallet_blob_inventory", { detail: "sample", nameQuery: "anime2.jpeg" }))
      .mockResolvedValueOnce(toolCall("image-1", "inspect_application", { query: "Show me anime2.jpeg from my indexed Shelby blobs." }))
      .mockResolvedValueOnce(toolCall("search-1", "search_user_knowledge", { query: "anime2.jpeg" }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "Here is anime2.jpeg; its indexed preview is attached." },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const inspectApplication = vi.fn().mockResolvedValue({
      ok: true,
      kind: "show_images",
      previewCount: 1,
      referencedSources: ["anime2.jpeg"],
    });

    const answer = await streamHostedAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Show me anime2.jpeg from my indexed Shelby blobs." }] }],
        systemInstruction: "Use app observations and answer naturally.",
      },
      vi.fn(),
      {
        getWalletBlobInventory: vi.fn().mockResolvedValue({
          ok: true,
          matchedCount: 1,
          matches: ["anime2.jpeg"],
        }),
        inspectApplication,
        searchKnowledge: vi.fn().mockResolvedValue({ found: false, evidence: [] }),
      },
    );

    expect(answer).toBe("Here is anime2.jpeg; its indexed preview is attached.");
    expect(inspectApplication).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const finalBody = JSON.parse(String((fetchMock.mock.calls[3][1] as RequestInit).body));
    expect(finalBody.toolChoice).toBe("none");
    expect(answer).not.toContain("agent_round_limit");
  });

  it("lets the harness repair a document answer that omitted its tool citation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "search_user_knowledge", arguments: "{\"query\":\"package.json libraries\"}" },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "The project uses Shelby and Aptos libraries." },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "The project uses Shelby storage and Aptos integration libraries [S1]." },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const searchKnowledge = vi.fn().mockResolvedValue({
      found: true,
      evidence: [{ citation: "S1", excerpt: "Dependencies include Shelby and Aptos SDK packages." }],
    });

    const answer = await streamHostedAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Which libraries does package.json use?" }] }],
        systemInstruction: "Use citations.",
      },
      vi.fn(),
      { searchKnowledge, getWalletBlobInventory: vi.fn() },
    );

    expect(answer).toContain("[S1]");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const repairBody = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect(repairBody.toolChoice).toBe("none");
    expect(repairBody.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "The project uses Shelby and Aptos libraries.",
    });
    expect(repairBody.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("allowed set: [S1]"),
    });
  });

  it("does not loop when Qwen ignores the single citation repair", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "search_user_knowledge", arguments: "{\"query\":\"document\"}" },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "First uncited draft." },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "Still uncited." },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Read my document." }] }] },
      vi.fn(),
      {
        searchKnowledge: vi.fn().mockResolvedValue({
          found: true,
          evidence: [{ citation: "S1", excerpt: "Evidence" }],
        }),
        getWalletBlobInventory: vi.fn(),
      },
    )).resolves.toBe("Still uncited.");

    expect(fetchMock).toHaveBeenCalledTimes(3);
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
