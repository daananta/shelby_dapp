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

  it("keeps conversational intent without replaying grounded answer text", () => {
    const history = buildAdaptiveGeminiHistory(messages);
    expect(JSON.stringify(history)).toContain("Mặt trời");
    expect(JSON.stringify(history)).toContain("AGENTS.md nói gì?");
    expect(JSON.stringify(history)).not.toContain("Tài liệu nói về Shelby SDK");
    expect(JSON.stringify(history)).not.toContain('"sources"');
    expect(JSON.stringify(history)).not.toContain('"source"');
  });

  it("keeps only a safe capability marker for blob-inventory follow-ups", () => {
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
        },
      },
    ]);
    const serialized = JSON.stringify(history);
    expect(serialized).toContain("get_wallet_blob_inventory");
    expect(serialized).toContain("refresh_wallet_blob_inventory");
    expect(serialized).toContain("never use document search");
    expect(serialized).not.toContain("35 blob");
    expect(serialized).not.toContain("private-plan.pdf");
    expect(serialized).not.toContain("secret-name.txt");
  });
});
