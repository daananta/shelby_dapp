import { beforeEach, describe, expect, it, vi } from "vitest";

const agentSdk = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendFirstMessageStream: vi.fn(),
  sendMessageStream: vi.fn(),
  modelConfig: undefined as any,
  startChatConfig: undefined as any,
}));

vi.mock("@google/generative-ai", () => ({
  FunctionCallingMode: { AUTO: "AUTO" },
  SchemaType: {
    ARRAY: "ARRAY",
    BOOLEAN: "BOOLEAN",
    INTEGER: "INTEGER",
    NUMBER: "NUMBER",
    OBJECT: "OBJECT",
    STRING: "STRING",
  },
  GoogleGenerativeAI: class {
    getGenerativeModel(config: unknown) {
      agentSdk.modelConfig = config;
      return {
        startChat: (config: unknown) => {
          agentSdk.startChatConfig = config;
          let firstRequest = true;
          return {
            sendMessage: agentSdk.sendMessage,
            sendMessageStream: (...args: unknown[]) => {
              if (firstRequest) {
                firstRequest = false;
                return agentSdk.sendFirstMessageStream(...args);
              }
              return agentSdk.sendMessageStream(...args);
            },
          };
        },
      };
    }
  },
}));

import { streamCloudAgentAnswer } from "@/utils/aiProvider";
import { buildAdaptiveGeminiHistory } from "@/utils/conversationMemory";

function chunks(...values: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield { text: () => value };
    },
  };
}

function firstResponse(calls: Array<{ name: string; args: object }> = [], text = "") {
  return {
    response: {
      functionCalls: () => calls,
      text: () => text,
    },
  };
}

function streamedResponse(...text: string[]) {
  return {
    stream: chunks(...text),
    response: Promise.resolve({
      functionCalls: () => [],
      text: () => text.join(""),
    }),
  };
}

describe("Gemini agent tool orchestration", () => {
  beforeEach(() => {
    agentSdk.sendMessage.mockReset();
    agentSdk.sendFirstMessageStream.mockReset();
    agentSdk.sendMessageStream.mockReset();
    agentSdk.sendFirstMessageStream.mockImplementation(async (...args: unknown[]) => {
      const first = await agentSdk.sendMessage(...args);
      return {
        stream: chunks(first.response.text()),
        response: Promise.resolve(first.response),
      };
    });
    agentSdk.modelConfig = undefined;
    agentSdk.startChatConfig = undefined;
  });

  it("lets an inventory follow-up call the wallet tool without searching RAG", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "get_wallet_blob_inventory", args: { detail: "count" } },
    ]));
    agentSdk.sendMessageStream.mockResolvedValue(streamedResponse("Theo snapshot gần nhất, ", "ví có 35 blob."));
    const onChunk = vi.fn();
    const searchKnowledge = vi.fn();
    const getWalletBlobInventory = vi.fn().mockResolvedValue({
      ok: true,
      count: 35,
      verified: true,
      fetchedAt: 123,
    });
    const history = buildAdaptiveGeminiHistory([
      { role: "user", text: "Ví này có bao nhiêu blob?" },
      {
        role: "ai",
        text: "Snapshot có 35 blob, gồm private-plan.pdf.",
        tool: "blob_inventory",
        toolObservation: {
          version: 1,
          kind: "blob_inventory",
          status: "verified",
          observedAt: 124,
          fetchedAt: 123,
        },
      },
    ]);

    const answer = await streamCloudAgentAnswer(
      {
        contents: [...history, { role: "user", parts: [{ text: "chắc chưa?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      onChunk,
      { searchKnowledge, getWalletBlobInventory },
    );

    expect(answer).toBe("Theo snapshot gần nhất, ví có 35 blob.");
    expect(getWalletBlobInventory).toHaveBeenCalledOnce();
    expect(searchKnowledge).not.toHaveBeenCalled();
    expect(JSON.stringify(agentSdk.startChatConfig.history)).toContain("get_wallet_blob_inventory");
    expect(JSON.stringify(agentSdk.startChatConfig.history)).not.toContain("private-plan.pdf");
    expect(JSON.stringify(agentSdk.startChatConfig.history)).not.toContain("35 blob");
    expect(agentSdk.sendMessageStream.mock.calls[0][0]).toEqual([{
      functionResponse: {
        name: "get_wallet_blob_inventory",
        response: expect.objectContaining({ ok: true, count: 35 }),
      },
    }]);
    expect(agentSdk.modelConfig.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name))
      .toEqual(["search_user_knowledge", "get_wallet_blob_inventory", "inspect_application"]);
  });

  it("lets Gemini phrase a deterministic application observation", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "inspect_application", args: { query: "What is my wallet address?" } },
    ]));
    agentSdk.sendMessageStream.mockResolvedValue(streamedResponse("Your connected wallet is 0x1234."));
    const inspectApplication = vi.fn().mockResolvedValue({
      ok: true,
      kind: "wallet_address",
      facts: "0x1234",
    });

    const answer = await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "What is my wallet address?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "Answer naturally.",
      },
      vi.fn(),
      {
        searchKnowledge: vi.fn(),
        getWalletBlobInventory: vi.fn(),
        inspectApplication,
      },
    );

    expect(answer).toBe("Your connected wallet is 0x1234.");
    expect(inspectApplication).toHaveBeenCalledWith(
      { query: "What is my wallet address?" },
      undefined,
    );
    expect(agentSdk.sendMessageStream.mock.calls[0][0]).toEqual([{
      functionResponse: {
        name: "inspect_application",
        response: expect.objectContaining({ ok: true, kind: "wallet_address", facts: "0x1234" }),
      },
    }]);
  });

  it("keeps document retrieval on the knowledge tool", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "search_user_knowledge", args: { query: "quy trình đọc blob trong tài liệu" } },
    ]));
    agentSdk.sendMessageStream.mockResolvedValue(streamedResponse("RPC trả dữ liệu đã xác thực [S1]."));
    const searchKnowledge = vi.fn().mockResolvedValue({
      found: true,
      evidence: [{ citation: "S1", excerpt: "RPC validates and reconstructs the requested bytes." }],
    });
    const getWalletBlobInventory = vi.fn();

    await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Tài liệu nói quy trình đọc blob thế nào?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      vi.fn(),
      { searchKnowledge, getWalletBlobInventory },
    );

    expect(searchKnowledge).toHaveBeenCalledWith({ query: "quy trình đọc blob trong tài liệu" }, undefined);
    expect(getWalletBlobInventory).not.toHaveBeenCalled();
  });

  it("lets the shared harness repair a Gemini document answer with missing citations", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "search_user_knowledge", args: { query: "package.json libraries" } },
    ]));
    agentSdk.sendMessageStream
      .mockResolvedValueOnce(streamedResponse("The project uses Shelby and Aptos libraries."))
      .mockResolvedValueOnce(streamedResponse("The project uses Shelby storage and Aptos integration libraries [S1]."));
    const onChunk = vi.fn();

    const answer = await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Which libraries does package.json use?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "Use citations.",
      },
      onChunk,
      {
        searchKnowledge: vi.fn().mockResolvedValue({
          found: true,
          evidence: [{ citation: "S1", excerpt: "Dependencies include Shelby and Aptos SDK packages." }],
        }),
        getWalletBlobInventory: vi.fn(),
      },
    );

    expect(answer).toContain("[S1]");
    expect(agentSdk.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(agentSdk.sendMessageStream.mock.calls[1][0]).toEqual([{
      text: expect.stringContaining("allowed set: [S1]"),
    }]);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("The project uses Shelby storage and Aptos integration libraries [S1].");
  });

  it("executes at most one knowledge search per user turn", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "search_user_knowledge", args: { query: "first query" } },
      { name: "search_user_knowledge", args: { query: "second query" } },
    ]));
    agentSdk.sendMessageStream.mockResolvedValue(streamedResponse("Câu trả lời [S1]."));
    const searchKnowledge = vi.fn().mockResolvedValue({
      found: true,
      evidence: [{ citation: "S1", excerpt: "First evidence." }],
    });

    await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Hãy kiểm tra tài liệu." }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      vi.fn(),
      { searchKnowledge, getWalletBlobInventory: vi.fn() },
    );

    expect(searchKnowledge).toHaveBeenCalledOnce();
    expect(agentSdk.sendMessageStream.mock.calls[0][0][1]).toEqual({
      functionResponse: {
        name: "search_user_knowledge",
        response: expect.objectContaining({ ok: false, code: "tool_execution_limit" }),
      },
    });
  });

  it("chains inventory refresh and reread across three bounded tool rounds", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "get_wallet_blob_inventory", args: { detail: "count" } },
    ]));
    agentSdk.sendMessageStream
      .mockResolvedValueOnce({
        stream: chunks(),
        response: Promise.resolve(firstResponse([
          { name: "refresh_wallet_blob_inventory", args: {} },
        ]).response),
      })
      .mockResolvedValueOnce({
        stream: chunks(),
        response: Promise.resolve(firstResponse([
          { name: "get_wallet_blob_inventory", args: { detail: "count" } },
        ]).response),
      })
      .mockResolvedValueOnce(streamedResponse("Theo lần làm mới mới nhất, ví có 36 blob."));
    const getWalletBlobInventory = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "stale_snapshot", count: 35 })
      .mockResolvedValueOnce({ ok: true, count: 36, fetchedAt: 456 });
    const refreshWalletBlobInventory = vi.fn().mockResolvedValue({ ok: true, refreshedAt: 456 });
    const onChunk = vi.fn();

    const answer = await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Hãy kiểm tra số blob hiện tại." }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      onChunk,
      {
        searchKnowledge: vi.fn(),
        getWalletBlobInventory,
        refreshWalletBlobInventory,
      },
    );

    expect(answer).toBe("Theo lần làm mới mới nhất, ví có 36 blob.");
    expect(getWalletBlobInventory).toHaveBeenCalledTimes(2);
    expect(refreshWalletBlobInventory).toHaveBeenCalledOnce();
    expect(agentSdk.sendMessageStream).toHaveBeenCalledTimes(3);
    expect(onChunk).toHaveBeenCalledWith("Theo lần làm mới mới nhất, ví có 36 blob.");
    expect(agentSdk.modelConfig.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name))
      .toContain("refresh_wallet_blob_inventory");
  });

  it("discards draft text and continues when the same model response asks for another tool", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "get_wallet_blob_inventory", args: { detail: "count" } },
    ]));
    agentSdk.sendMessageStream
      .mockResolvedValueOnce({
        stream: chunks("Bản nháp chưa kiểm chứng."),
        response: Promise.resolve(firstResponse([
          { name: "refresh_wallet_blob_inventory", args: {} },
        ]).response),
      })
      .mockResolvedValueOnce(streamedResponse("Ví có 36 blob."));
    const onChunk = vi.fn();

    const answer = await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Kiểm tra số blob mới nhất." }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      onChunk,
      {
        searchKnowledge: vi.fn(),
        getWalletBlobInventory: vi.fn().mockResolvedValue({ ok: false, code: "stale_snapshot" }),
        refreshWalletBlobInventory: vi.fn().mockResolvedValue({ ok: true }),
      },
    );
    expect(answer).toBe("Ví có 36 blob.");
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("Ví có 36 blob.");
    expect(onChunk).not.toHaveBeenCalledWith("Bản nháp chưa kiểm chứng.");
  });

  it("rejects an unbounded function-call batch before executing app tools", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse(Array.from({ length: 4 }, (_, index) => ({
      name: "unknown_tool",
      args: { index },
    }))));
    const handlers = {
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: vi.fn(),
    };

    await expect(streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Do too much." }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      vi.fn(),
      handlers,
    )).rejects.toThrow("too many app actions");
    expect(handlers.searchKnowledge).not.toHaveBeenCalled();
    expect(handlers.getWalletBlobInventory).not.toHaveBeenCalled();
    expect(agentSdk.sendMessageStream).not.toHaveBeenCalled();
  });

  it("answers ordinary conversation without executing a data tool", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([], "Đúng, tôi sẽ giải thích rõ hơn."));
    const handlers = {
      searchKnowledge: vi.fn(),
      getWalletBlobInventory: vi.fn(),
    };
    const onChunk = vi.fn();

    const answer = await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Bạn chắc chứ?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      onChunk,
      handlers,
    );

    expect(answer).toBe("Đúng, tôi sẽ giải thích rõ hơn.");
    expect(onChunk).toHaveBeenCalledWith("Đúng, tôi sẽ giải thích rõ hơn.");
    expect(handlers.searchKnowledge).not.toHaveBeenCalled();
    expect(handlers.getWalletBlobInventory).not.toHaveBeenCalled();
    expect(agentSdk.sendMessageStream).not.toHaveBeenCalled();
    expect(agentSdk.modelConfig.generationConfig).toEqual({
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(agentSdk.sendFirstMessageStream.mock.calls[0][1]).toMatchObject({
      timeout: 30_000,
    });
  });

  it("emits direct-answer chunks before the aggregated first response resolves", async () => {
    let resolveResponse!: (value: ReturnType<typeof firstResponse>["response"]) => void;
    const response = new Promise<ReturnType<typeof firstResponse>["response"]>((resolve) => {
      resolveResponse = resolve;
    });
    agentSdk.sendFirstMessageStream.mockResolvedValue({
      stream: chunks("Xin", " chào"),
      response,
    });
    const onChunk = vi.fn();

    const pending = streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      onChunk,
      { searchKnowledge: vi.fn(), getWalletBlobInventory: vi.fn() },
    );

    await vi.waitFor(() => expect(onChunk).toHaveBeenCalledTimes(2));
    resolveResponse(firstResponse([], "Xin chào").response);
    await expect(pending).resolves.toBe("Xin chào");
    expect(onChunk.mock.calls).toEqual([["Xin"], [" chào"]]);
  });

  it("emits a safe fallback when the final tool round has no answer text", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "get_wallet_blob_inventory", args: { detail: "count" } },
    ]));
    agentSdk.sendMessageStream.mockResolvedValue(streamedResponse());
    const onChunk = vi.fn();

    const answer = await streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Ví có bao nhiêu blob?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      onChunk,
      {
        searchKnowledge: vi.fn(),
        getWalletBlobInventory: vi.fn().mockResolvedValue({ ok: false, code: "inventory_unavailable" }),
      },
    );

    expect(answer).toMatch(/not enough information|không tìm thấy đủ thông tin/i);
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledWith(answer);
  });

  it("does not replay tools on another model after a post-tool 429", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "get_wallet_blob_inventory", args: { detail: "count" } },
    ]));
    agentSdk.sendMessageStream.mockRejectedValue(Object.assign(new Error("429 quota exceeded"), { status: 429 }));
    const getWalletBlobInventory = vi.fn().mockResolvedValue({ ok: true, count: 2 });

    await expect(streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Ví có bao nhiêu blob?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory },
    )).rejects.toThrow(/429|quota/i);

    expect(agentSdk.sendMessage).toHaveBeenCalledOnce();
    expect(agentSdk.sendMessageStream).toHaveBeenCalledOnce();
    expect(getWalletBlobInventory).toHaveBeenCalledOnce();
  });

  it("aborts a pending tool without starting the next model round", async () => {
    agentSdk.sendMessage.mockResolvedValue(firstResponse([
      { name: "get_wallet_blob_inventory", args: { detail: "count" } },
    ]));
    const getWalletBlobInventory = vi.fn().mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = streamCloudAgentAnswer(
      {
        contents: [{ role: "user", parts: [{ text: "Ví có bao nhiêu blob?" }] }],
        cloudApiKey: "test-key",
        systemInstruction: "test",
      },
      vi.fn(),
      { searchKnowledge: vi.fn(), getWalletBlobInventory },
      controller.signal,
    );
    await vi.waitFor(() => expect(getWalletBlobInventory).toHaveBeenCalledOnce());

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(agentSdk.sendMessageStream).not.toHaveBeenCalled();
  });
});
