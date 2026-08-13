import { afterEach, describe, expect, it, vi } from "vitest";
import handler from "./chat";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

function streamingResponseRecorder() {
  let statusCode = 200;
  let ended = false;
  const chunks: string[] = [];
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
      chunks.push(JSON.stringify(value));
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
  };
  return { response, read: () => ({ statusCode, ended, chunks, headers }) };
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
    expect(upstreamBody.reasoning).toEqual({ effort: "low", exclude: true });
    expect(upstreamBody.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        function: expect.objectContaining({ name: "get_connected_wallet" }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({ name: "analyze_indexed_image" }),
      }),
    ]));
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-only-test-key");
    expect(JSON.stringify(recorder.read().payload)).not.toContain("server-only-test-key");
  });

  it("exposes only browser capabilities that are available for the current turn", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Hello." }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.61" },
      body: {
        messages: [{ role: "user", content: "Hello" }],
        availableTools: ["search_user_knowledge", "get_connected_wallet"],
      },
    }, recorder.response);

    expect(recorder.read().statusCode).toBe(200);
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    const upstreamBody = JSON.parse(String(init.body));
    expect(upstreamBody.tools.map((tool: { function: { name: string } }) => tool.function.name))
      .toEqual(["search_user_knowledge", "get_connected_wallet"]);
  });

  it("normalizes provider tool calls with object arguments and a missing id", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: [],
          tool_calls: [{
            type: "function",
            function: { name: "get_wallet_blob_inventory", arguments: { detail: "count" } },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.66" },
      body: {
        messages: [{ role: "user", content: "How many blobs do I have?" }],
        availableTools: ["get_wallet_blob_inventory"],
      },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 200,
      payload: {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: expect.stringMatching(/^tool-call-/),
            type: "function",
            function: { name: "get_wallet_blob_inventory", arguments: "{\"detail\":\"count\"}" },
          }],
        },
      },
    });
  });

  it("relays OpenRouter tokens and the final tool-safe message as SSE", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstreamBody = [
      "data: {\"choices\":[{\"delta\":{\"content\":\"Your wallet \"}}]}",
      "",
      "data: {\"choices\":[{\"delta\":{\"content\":\"has one blob.\"}}]}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const recorder = streamingResponseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.68" },
      body: {
        stream: true,
        messages: [{ role: "user", content: "How many blobs do I have?" }],
        availableTools: ["get_wallet_blob_inventory"],
        diagnostics: {
          turnId: "turn12345678",
          modelCall: 2,
          phase: "compose",
          toolRound: 1,
          repairCount: 0,
          precedingToolCount: 1,
          precedingToolMs: 17,
          precedingRefreshMs: 0,
          turnElapsedMs: 3_200,
          userPrompt: "must-not-be-logged",
          walletAddress: "0xsecret",
        },
      },
    }, recorder.response);

    const result = recorder.read();
    expect(result.statusCode).toBe(200);
    expect(result.ended).toBe(true);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    expect(result.chunks.join(""))
      .toContain("event: token\ndata: {\"text\":\"Your wallet \"}");
    expect(result.chunks.join(""))
      .toContain("event: message\ndata: {\"message\":{\"role\":\"assistant\",\"content\":\"Your wallet has one blob.\"}}");
    expect(timingLog).toHaveBeenCalledOnce();
    const timing = JSON.parse(String(timingLog.mock.calls[0]?.[1]));
    expect(timing).toMatchObject({
      event: "agent_model_timing",
      turnId: "turn12345678",
      modelCall: 2,
      phase: "compose",
      toolRound: 1,
      precedingToolCount: 1,
      precedingToolMs: 17,
      outputKind: "answer",
      status: 200,
      inputChars: "How many blobs do I have?".length,
      requestBytes: expect.any(Number),
      messageCount: 1,
      availableToolCount: 1,
      headersMs: expect.any(Number),
      firstTokenMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    expect(JSON.stringify(timing)).not.toContain("must-not-be-logged");
    expect(JSON.stringify(timing)).not.toContain("0xsecret");
    timingLog.mockRestore();
  });

  it("assembles fragmented streamed tool calls before returning them to the browser", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstreamBody = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"inventory-\",\"function\":{\"name\":\"get_wallet_blob_inventory\",\"arguments\":\"{\\\"detail\\\":\"}}]}}]}",
      "",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"1\",\"function\":{\"arguments\":\"\\\"count\\\"}\"}}]}}]}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const recorder = streamingResponseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.69" },
      body: {
        stream: true,
        messages: [{ role: "user", content: "How many blobs do I have?" }],
        availableTools: ["get_wallet_blob_inventory"],
      },
    }, recorder.response);

    expect(recorder.read().chunks.join(""))
      .toContain("event: message\ndata: {\"message\":{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"inventory-1\",\"type\":\"function\",\"function\":{\"name\":\"get_wallet_blob_inventory\",\"arguments\":\"{\\\"detail\\\":\\\"count\\\"}\"}}]}}");
  });

  it("reports a malformed provider answer as invalid instead of provider downtime", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "tool_calls" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.67" },
      body: { messages: [{ role: "user", content: "How many blobs do I have?" }] },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 422,
      payload: { kind: "invalid_response" },
    });
  });

  it("rejects an upstream tool call that the current browser turn cannot execute", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "unknown-call",
            type: "function",
            function: { name: "analyze_indexed_image", arguments: "{}" },
          }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.62" },
      body: {
        messages: [{ role: "user", content: "What is my address?" }],
        availableTools: ["get_connected_wallet"],
      },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 422,
      payload: { error: "Hosted AI chat response was incomplete", kind: "invalid_response" },
    });
  });

  it("disables tools for a bounded final-answer repair request", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Corrected [S1]." }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.10" },
      body: {
        messages: [{ role: "user", content: "Repair the final answer." }],
        toolChoice: "none",
      },
    }, recorder.response);

    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).tool_choice).toBe("none");
  });

  it("forwards a bounded image to Qwen as multimodal content without exposing tools", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const imageData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]).toString("base64");
    const question = "Những chi tiết nào trong ảnh hỗ trợ mô tả này?";
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "Một hình vuông nhỏ.", providerDebug: imageData },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.11" },
      body: {
        mode: "vision",
        language: "vi",
        question,
        image: { data: imageData, mimeType: "image/png", fileName: "sample.png" },
      },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 200,
      payload: { message: { role: "assistant", content: "Một hình vuông nhỏ." } },
    });
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    const upstreamBody = JSON.parse(String(init.body));
    expect(upstreamBody.model).toBe("qwen/qwen3.7-flash");
    expect(upstreamBody.reasoning).toEqual({ effort: "none", exclude: true });
    expect(upstreamBody.temperature).toBe(0);
    expect(upstreamBody).not.toHaveProperty("tools");
    expect(upstreamBody).not.toHaveProperty("tool_choice");
    expect(upstreamBody.messages[0].content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("tiếng Việt"),
    });
    expect(upstreamBody.messages[0].content[0].text).toContain(question);
    expect(upstreamBody.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${imageData}` },
    });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-only-test-key");
    expect(JSON.stringify(recorder.read().payload)).not.toContain(imageData);
    expect(JSON.stringify(recorder.read().payload)).not.toContain("server-only-test-key");
  });

  it.each([
    {
      label: "an unsupported MIME type",
      ip: "203.0.113.50",
      image: {
        data: Buffer.from("<svg></svg>").toString("base64"),
        mimeType: "image/svg+xml",
        fileName: "sample.svg",
      },
    },
    {
      label: "malformed base64",
      ip: "203.0.113.51",
      image: { data: "not%base64", mimeType: "image/png", fileName: "sample.png" },
    },
    {
      label: "bytes that do not match the declared MIME type",
      ip: "203.0.113.52",
      image: {
        data: Buffer.from("GIF89a").toString("base64"),
        mimeType: "image/png",
        fileName: "sample.png",
      },
    },
  ])("rejects $label before calling the provider", async ({ image, ip }) => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": ip },
      body: { mode: "vision", language: "en", question: "What is visible in this image?", image },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 400,
      payload: { kind: "invalid_image" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects decoded images larger than two MiB before calling the provider", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();
    const bytes = Buffer.alloc((2 * 1024 * 1024) + 1);
    Buffer.from([0xff, 0xd8, 0xff]).copy(bytes);

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.12" },
      body: {
        mode: "vision",
        language: "en",
        question: "Describe the visible content.",
        image: { data: bytes.toString("base64"), mimeType: "image/jpeg", fileName: "large.jpg" },
      },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 413,
      payload: { kind: "image_too_large" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a vision request without the user's visual question", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const recorder = responseRecorder();
    const imageData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]).toString("base64");

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.13" },
      body: {
        mode: "vision",
        language: "en",
        image: { data: imageData, mimeType: "image/png", fileName: "sample.png" },
      },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 400,
      payload: { kind: "invalid_image" },
    });
    expect(upstream).not.toHaveBeenCalled();
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

  it("reports an upstream timeout distinctly from a provider failure", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    const recorder = responseRecorder();

    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.65" },
      body: { messages: [{ role: "user", content: "Hello" }] },
    }, recorder.response);

    expect(recorder.read()).toMatchObject({
      statusCode: 504,
      payload: { kind: "timeout" },
    });
  });

  it("does not charge internal agent steps against the user-turn rate bucket", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    const upstream = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", upstream);
    const ip = "203.0.113.63";

    for (let index = 0; index < 15; index += 1) {
      const recorder = responseRecorder();
      await handler({
        method: "POST",
        headers: { origin: "https://example.test", "x-forwarded-for": ip },
        body: { messages: [{ role: "user", content: `Question ${index}` }] },
      }, recorder.response);
      expect(recorder.read().statusCode).toBe(200);
    }

    const limited = responseRecorder();
    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": ip },
      body: { messages: [{ role: "user", content: "One turn too many" }] },
    }, limited.response);
    expect(limited.read().statusCode).toBe(429);

    const continuation = responseRecorder();
    await handler({
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": ip },
      body: {
        availableTools: ["get_connected_wallet"],
        messages: [
          { role: "user", content: "What is my address?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "wallet-call",
              type: "function",
              function: { name: "get_connected_wallet", arguments: "{\"detail\":\"address\"}" },
            }],
          },
          { role: "tool", tool_call_id: "wallet-call", content: "{\"ok\":true,\"address\":\"0x1234\"}" },
        ],
      },
    }, continuation.response);
    expect(continuation.read().statusCode).toBe(200);
  });

  it("still caps aggregate hosted chat calls even when a request claims to be an agent continuation", async () => {
    process.env.APP_ORIGIN = "https://example.test";
    process.env.OPENROUTER_API_KEY = "server-only-test-key";
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const request = {
      method: "POST",
      headers: { origin: "https://example.test", "x-forwarded-for": "203.0.113.64" },
      body: {
        availableTools: ["get_connected_wallet"],
        messages: [
          { role: "user", content: "What is my address?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "wallet-call",
              type: "function",
              function: { name: "get_connected_wallet", arguments: "{\"detail\":\"address\"}" },
            }],
          },
          { role: "tool", tool_call_id: "wallet-call", content: "{\"ok\":true,\"address\":\"0x1234\"}" },
        ],
      },
    } as const;

    for (let index = 0; index < 60; index += 1) {
      const recorder = responseRecorder();
      await handler(request, recorder.response);
      expect(recorder.read().statusCode).toBe(200);
    }
    const limited = responseRecorder();
    await handler(request, limited.response);
    expect(limited.read().statusCode).toBe(429);
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
