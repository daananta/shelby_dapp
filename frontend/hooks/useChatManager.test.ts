import { describe, expect, it } from "vitest";
import {
  createChatMessage,
  normalizeStoredChatMessages,
  prepareMessagesForPersistence,
} from "@/hooks/useChatManager";

describe("chat message identity and persistence", () => {
  it("assigns a stable, unique id unless one is already present", () => {
    const first = createChatMessage({ role: "user", text: "Xin chào" });
    const second = createChatMessage({ role: "ai", text: "Chào bạn" });
    const existing = createChatMessage({ id: "answer-42", role: "ai", text: "Đã có id" });

    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
    expect(existing.id).toBe("answer-42");
  });

  it("persists an in-flight answer as interrupted instead of a live typing message", () => {
    const messages = [
      createChatMessage({ role: "user", text: "Câu hỏi" }),
      createChatMessage({ role: "ai", text: "", typing: true }),
    ];

    const persisted = prepareMessagesForPersistence(messages);

    expect(persisted).toHaveLength(2);
    expect(persisted[1]).toMatchObject({
      role: "ai",
      text: "The response was interrupted when the page closed.",
      interrupted: true,
    });
    expect(persisted[1]).not.toHaveProperty("typing");
  });

  it("keeps only the latest twenty messages", () => {
    const messages = Array.from({ length: 24 }, (_, index) => createChatMessage({
      id: `message-${index}`,
      role: index % 2 ? "ai" : "user",
      text: String(index),
    }));

    const persisted = prepareMessagesForPersistence(messages);

    expect(persisted).toHaveLength(20);
    expect(persisted[0].id).toBe("message-4");
    expect(persisted.at(-1)?.id).toBe("message-23");
  });

  it("migrates legacy stored messages and settles abandoned streams", () => {
    const restored = normalizeStoredChatMessages([
      null,
      { role: "system", text: "Không hợp lệ" },
      { role: "user", text: "Tin cũ không có id" },
      { id: "stream-1", role: "ai", text: "Một phần câu trả lời", typing: true },
    ]);

    expect(restored).toHaveLength(2);
    expect(restored[0].id).toBeTruthy();
    expect(restored[1]).toMatchObject({
      id: "stream-1",
      text: "Một phần câu trả lời",
      interrupted: true,
    });
    expect(restored[1].typing).toBeUndefined();
  });
});
