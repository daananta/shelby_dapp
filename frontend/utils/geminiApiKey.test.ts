import { describe, expect, it } from "vitest";
import { normalizeGeminiApiKey } from "@/utils/geminiApiKey";

describe("Gemini API key normalization", () => {
  it.each([
    "AQ.mock-authorization-key",
    "AIza.mock-legacy-key",
    "future-format.without-a-known-prefix",
  ])("keeps opaque key format %s unchanged", (apiKey) => {
    expect(normalizeGeminiApiKey(`  ${apiKey}  `)).toBe(apiKey);
  });

  it("returns an empty value for missing input", () => {
    expect(normalizeGeminiApiKey(undefined)).toBe("");
    expect(normalizeGeminiApiKey("   ")).toBe("");
  });
});
