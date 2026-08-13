import { afterEach, describe, expect, it, vi } from "vitest";
import { describeImageWithHostedAi, HostedAiError, streamHostedAgentAnswer } from "@/utils/openRouterProvider";
import { buildAdaptiveGeminiHistory } from "@/utils/conversationMemory";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("hosted Qwen agent", () => {
  it("sends one fetched indexed image to the same-origin vision gateway without a browser provider key", async () => {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "A blue-haired anime character is sitting outdoors." },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(describeImageWithHostedAi(
      "https://example.test/anime2.jpeg",
      "anime2.jpeg",
      "en",
      undefined,
      undefined,
      "Which visible details support the description?",
    )).resolves.toContain("blue-haired");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [gatewayUrl, gatewayInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(gatewayInit.body));
    expect(gatewayUrl).toBe("/api/ai/v1/chat");
    expect(body).toMatchObject({
      mode: "vision",
      language: "en",
      question: "Which visible details support the description?",
      image: {
        mimeType: "image/jpeg",
        fileName: "anime2.jpeg",
        data: expect.any(String),
      },
    });
    expect(new Headers(gatewayInit.headers).has("authorization")).toBe(false);
    expect(String(gatewayInit.body)).not.toContain("sk-or-");
  });

  it("reduces a large indexed image before sending it to the vision gateway", async () => {
    const largeImage = new Uint8Array((2 * 1024 * 1024) + 1);
    largeImage.set([0xff, 0xd8, 0xff]);
    const reducedImage = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 3_000, height: 2_000, close }));
    vi.stubGlobal("OffscreenCanvas", class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      async convertToBlob() {
        return new Blob([reducedImage], { type: "image/jpeg" });
      }
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(largeImage, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "Reduced image inspected." },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(describeImageWithHostedAi(
      "https://example.test/large.jpeg",
      "large.jpeg",
      "en",
      undefined,
      undefined,
      "Describe the main subject.",
    )).resolves.toBe("Reduced image inspected.");

    const gatewayBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(gatewayBody.image.mimeType).toBe("image/jpeg");
    expect(atob(gatewayBody.image.data)).toHaveLength(reducedImage.byteLength);
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops before buffering an image source above the safe preparation limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String((12 * 1024 * 1024) + 1),
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(describeImageWithHostedAi(
      "https://example.test/oversized.jpeg",
      "oversized.jpeg",
      "en",
    )).rejects.toMatchObject({ status: 413 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

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

  it("lets Qwen resolve an ambiguous inventory follow-up from the visible answer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "inventory-follow-up",
            type: "function",
            function: {
              name: "get_wallet_blob_inventory",
              arguments: "{\"detail\":\"sample\"}",
            },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: "Blob duy nhất là only-note.txt (1 blob).",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const getWalletBlobInventory = vi.fn().mockResolvedValue({
      ok: true,
      network: "shelbynet",
      count: 1,
      examples: ["only-note.txt"],
      answerContract: {
        scope: "wallet_blob_inventory",
        requiredExactStrings: ["only-note.txt"],
        count: {
          allowedValues: [1],
          requiredValues: [1],
          units: ["blob", "blobs", "tệp", "file", "files"],
        },
      },
    });
    const history = buildAdaptiveGeminiHistory([
      { role: "user", text: "chào, tôi đang có bao nhiêu blob" },
      {
        role: "ai",
        text: "Hiện tại, ví của bạn đang có 1 blob.",
        tool: "blob_inventory",
        toolObservation: {
          version: 1,
          kind: "blob_inventory",
          status: "verified",
          observedAt: 20,
          fetchedAt: 10,
          network: "shelbynet",
        },
      },
    ]);

    const answer = await streamHostedAgentAnswer(
      {
        contents: [...history, { role: "user", parts: [{ text: "nó là gì" }] }],
        systemInstruction: "Resolve follow-ups naturally and use tools for missing user-specific details.",
        activeNetwork: "shelbynet",
      },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory },
    );

    expect(answer).toBe("Blob duy nhất là only-note.txt (1 blob).");
    expect(getWalletBlobInventory).toHaveBeenCalledWith({ detail: "sample", nameQuery: undefined }, undefined);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(JSON.stringify(firstBody.messages)).toContain("Hiện tại, ví của bạn đang có 1 blob.");
    expect(JSON.stringify(firstBody.messages)).not.toContain("observedAt");
    expect(JSON.stringify(firstBody.messages)).not.toContain("fetchedAt");
  });

  it("lets Qwen continue from a singleton identity into document evidence", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "inventory-1",
            type: "function",
            function: { name: "get_wallet_blob_inventory", arguments: "{\"detail\":\"sample\"}" },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "search-1",
            type: "function",
            function: { name: "search_user_knowledge", arguments: "{\"query\":\"only-note.txt\"}" },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: "only-note.txt là ghi chú giới thiệu Shelby hot storage [S1].",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const getWalletBlobInventory = vi.fn().mockResolvedValue({
      ok: true,
      count: 1,
      examples: ["only-note.txt"],
      answerContract: {
        scope: "wallet_blob_inventory",
        requiredExactStrings: ["only-note.txt"],
      },
    });
    const searchKnowledge = vi.fn().mockResolvedValue({
      found: true,
      evidence: [{ citation: "S1", excerpt: "Shelby is designed as hot storage." }],
    });
    const history = buildAdaptiveGeminiHistory([
      { role: "user", text: "ví tôi có bao nhiêu blob" },
      { role: "ai", text: "Ví của bạn hiện có 1 blob.", tool: "blob_inventory" },
    ]);

    const answer = await streamHostedAgentAnswer(
      {
        contents: [...history, { role: "user", parts: [{ text: "nói về nó" }] }],
        systemInstruction: "Resolve the reference, then use document evidence when content is requested.",
        activeNetwork: "shelbynet",
      },
      vi.fn(),
      { searchKnowledge, getWalletBlobInventory },
    );

    expect(answer).toBe("only-note.txt là ghi chú giới thiệu Shelby hot storage [S1].");
    expect(getWalletBlobInventory).toHaveBeenCalledWith({ detail: "sample", nameQuery: undefined }, undefined);
    expect(searchKnowledge).toHaveBeenCalledWith({ query: "only-note.txt" }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("lets Qwen choose the dedicated connected-wallet tool and preserves the public Aptos address", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "wallet-1",
            type: "function",
            function: { name: "get_connected_wallet", arguments: "{\"detail\":\"address\"}" },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "Địa chỉ ví Aptos đang kết nối là 0x1234." },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const getConnectedWallet = vi.fn().mockResolvedValue({
      ok: true,
      kind: "wallet_address",
      wallet: { connected: true, address: "0x1234" },
      answerContract: { requiredExactStrings: ["0x1234"] },
    });

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "địa chỉ ví của tôi là gì" }] }] },
      vi.fn(),
      {
        searchKnowledge: vi.fn(),
        getWalletBlobInventory: vi.fn(),
        getConnectedWallet,
      },
    )).resolves.toContain("0x1234");

    expect(getConnectedWallet).toHaveBeenCalledWith({ detail: "address" }, undefined);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(firstBody.availableTools).toEqual([
      "search_user_knowledge",
      "get_wallet_blob_inventory",
      "get_connected_wallet",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("executes Qwen's selected tool without a keyword routing override", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "search-1",
            type: "function",
            function: { name: "search_user_knowledge", arguments: "{\"query\":\"wallet address\"}" },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "I could not find that in your documents." },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const searchKnowledge = vi.fn().mockResolvedValue({ found: false, evidence: [] });
    const getConnectedWallet = vi.fn();

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "What is my wallet address?" }] }] },
      vi.fn(),
      {
        searchKnowledge,
        getWalletBlobInventory: vi.fn(),
        getConnectedWallet,
      },
    )).resolves.toContain("could not find");

    expect(searchKnowledge).toHaveBeenCalledOnce();
    expect(getConnectedWallet).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("lets Qwen decide to inspect image pixels through the dedicated vision tool", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "vision-1",
            type: "function",
            function: {
              name: "analyze_indexed_image",
              arguments: "{\"source\":\"anime2.jpeg\",\"question\":\"Describe what is visible in this image.\"}",
            },
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant",
          content: "The image shows a blue-haired anime character beneath a cloudy sky.",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const analyzeIndexedImage = vi.fn().mockResolvedValue({
      ok: true,
      kind: "image_analysis",
      facts: "A blue-haired anime character beneath a cloudy sky.",
      referencedSources: ["anime2.jpeg"],
      previewCount: 1,
    });

    const answer = await streamHostedAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Describe what is visible in this image." }] }],
        systemInstruction: "Use vision only when visual evidence is required.",
      },
      vi.fn(),
      {
        searchKnowledge: vi.fn(),
        getWalletBlobInventory: vi.fn(),
        analyzeIndexedImage,
      },
    );

    expect(answer).toContain("blue-haired anime character");
    expect(analyzeIndexedImage).toHaveBeenCalledWith({
      source: "anime2.jpeg",
      question: "Describe what is visible in this image.",
    }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(toolCall("image-1", "inspect_application", { query: "Show me anime2.jpeg from my indexed Shelby blobs." }))
      .mockResolvedValueOnce(toolCall("inventory-1", "get_wallet_blob_inventory", { detail: "sample", nameQuery: "anime2.jpeg" }))
      .mockResolvedValueOnce(toolCall("search-1", "search_user_knowledge", { query: "anime2.jpeg" }))
      .mockResolvedValueOnce(toolCall("image-2", "inspect_application", { query: "Show me anime2.jpeg" }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "The indexed preview is attached." },
      }))
      .mockResolvedValueOnce(jsonResponse({
        message: { role: "assistant", content: "Here is anime2.jpeg; its indexed preview is attached." },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const inspectApplication = vi.fn().mockResolvedValue({
      ok: true,
      kind: "show_images",
      previewCount: 1,
      referencedSources: ["anime2.jpeg"],
      answerContract: { requiredExactStrings: ["anime2.jpeg"] },
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
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const finalBody = JSON.parse(String((fetchMock.mock.calls[4][1] as RequestInit).body));
    expect(finalBody.toolChoice).toBe("none");
    const repairBody = JSON.parse(String((fetchMock.mock.calls[5][1] as RequestInit).body));
    expect(repairBody.toolChoice).toBe("none");
    expect(repairBody.messages.at(-1).content).toContain("anime2.jpeg");
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

  it("stops after one bounded repair when Qwen still omits the citation", async () => {
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
    )).rejects.toMatchObject({ name: "HostedAiError", kind: "invalid_response" });

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

  it("surfaces a hosted timeout separately from rate limits and rejected credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ kind: "timeout" }, 504)));

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory: vi.fn() },
    )).rejects.toMatchObject({
      name: "HostedAiError",
      kind: "timeout",
      status: 504,
      message: expect.stringContaining("took too long"),
    });
  });

  it("explains when a Vite-only local preview does not provide the AI route", async () => {
    vi.stubGlobal("location", { hostname: "127.0.0.1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory: vi.fn() },
    )).rejects.toMatchObject({
      name: "HostedAiError",
      kind: "unavailable",
      message: expect.stringContaining("dev:fullstack"),
    });
  });

  it("distinguishes missing server provider configuration from provider overload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ kind: "provider_auth" }, 503)));

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory: vi.fn() },
    )).rejects.toMatchObject({
      name: "HostedAiError",
      kind: "unavailable",
      status: 503,
      message: expect.stringContaining("server configuration"),
    });
  });

  it("normalizes gateway network failures without swallowing aborts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(streamHostedAgentAnswer(
      { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory: vi.fn() },
    )).rejects.toMatchObject({
      name: "HostedAiError",
      kind: "unavailable",
      message: expect.stringContaining("could not be reached"),
    });
  });
});
