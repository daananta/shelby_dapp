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
});
