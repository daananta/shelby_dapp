import { describe, expect, it } from "vitest";
import { normalizeConversationRoute } from "@/utils/conversationRoute";

describe("Cloud conversation route validation", () => {
  it("accepts only source identifiers that were offered to the model", () => {
    expect(normalizeConversationRoute({ scope: "image", referencedSources: ["anime2.jpeg", "invented.pdf"], imageAction: "describe", confidence: 0.94 }, ["anime2.jpeg"]))
      .toEqual({ scope: "image", referencedSources: ["anime2.jpeg"], imageAction: "describe", confidence: 0.94 });
  });

  it("fails safely to general scope for malformed model output", () => {
    expect(normalizeConversationRoute({ scope: "execute_code", referencedSources: "all" }, ["doc.pdf"]))
      .toEqual({ scope: "general", referencedSources: [], imageAction: null, confidence: 0 });
  });
});
