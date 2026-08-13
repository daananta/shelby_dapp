import { describe, expect, it } from "vitest";
import { buildAdaptiveGeminiHistory, buildScopedGeminiHistory } from "@/utils/conversationMemory";

const messages = [
  { role: "user" as const, text: "AGENTS.md nói gì?" },
  { role: "ai" as const, text: "Tài liệu nói về Shelby SDK.", sources: [{ source: "AGENTS.md" }] },
  { role: "user" as const, text: "Mặt trời cách Trái Đất bao xa?" },
  { role: "ai" as const, text: "Khoảng 149,6 triệu km." },
];

describe("scoped conversation memory", () => {
  it("does not leak previous RAG evidence into general Cloud AI history", () => {
    const history = buildScopedGeminiHistory(messages, "general");
    expect(JSON.stringify(history)).not.toContain("AGENTS.md");
    expect(JSON.stringify(history)).toContain("149,6 triệu km");
  });

  it("keeps grounded turns for document follow-ups", () => {
    const history = buildScopedGeminiHistory(messages, "document");
    expect(JSON.stringify(history)).toContain("AGENTS.md");
    expect(JSON.stringify(history)).not.toContain("Mặt trời");
  });

  it("keeps user-visible grounded answers without replaying raw source records", () => {
    const history = buildAdaptiveGeminiHistory(messages);
    expect(JSON.stringify(history)).toContain("Mặt trời");
    expect(JSON.stringify(history)).toContain("AGENTS.md nói gì?");
    expect(JSON.stringify(history)).toContain("Tài liệu nói về Shelby SDK");
    expect(JSON.stringify(history)).not.toContain('"sources"');
    expect(JSON.stringify(history)).not.toContain('"source"');
    expect(JSON.stringify(history)).not.toContain("If the user follows up");
  });

  it("keeps the user-visible inventory answer without exposing harness metadata", () => {
    const history = buildAdaptiveGeminiHistory([
      { role: "user", text: "Ví này có bao nhiêu blob?" },
      {
        role: "ai",
        text: "Ví này có 35 blob, gồm private-plan.pdf và secret-name.txt.",
        tool: "blob_inventory",
        toolObservation: {
          version: 1,
          kind: "blob_inventory",
          status: "verified",
          observedAt: 10,
          fetchedAt: 9,
          network: "shelbynet",
        },
      },
    ]);
    const serialized = JSON.stringify(history);
    expect(serialized).toContain("35 blob");
    expect(serialized).toContain("private-plan.pdf");
    expect(serialized).toContain("secret-name.txt");
    expect(serialized).not.toContain("If the user");
    expect(serialized).not.toContain("call get_wallet_blob_inventory");
    expect(serialized).not.toContain("Previous Shelby inventory observation");
    expect(serialized).not.toContain("status=verified");
    expect(serialized).not.toContain("observedAt");
    expect(serialized).not.toContain("fetchedAt");
    expect(serialized).not.toContain("network=shelbynet");
  });

  it("keeps the prior user-visible image answer and exact source for natural follow-ups", () => {
    const history = buildAdaptiveGeminiHistory([
      { role: "user", text: "Describe what is visible in this image." },
      {
        role: "ai",
        text: "The character has silver-white hair, holds a blue mug, and sits beneath a cloudy sky.",
        tool: "show_images",
        imageUrls: ["blob:https://example.test/image"],
        referencedSources: ["anime2.jpeg"],
      },
    ]);
    const serialized = JSON.stringify(history);
    expect(serialized).toContain("previously answered using the indexed image");
    expect(serialized).toContain("anime2.jpeg");
    expect(serialized).toContain("silver-white hair");
    expect(serialized).not.toContain("Indexed image context");
    expect(serialized).not.toContain("app-provided data");
    expect(serialized).not.toContain("use the tool to search again");
  });
});
