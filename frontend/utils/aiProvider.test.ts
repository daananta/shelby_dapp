import { describe, expect, it } from "vitest";
import { getCloudErrorKind, normalizeCloudError } from "@/utils/aiProvider";

describe("Gemini error messages", () => {
  it("explains rate limits without hiding the HTTP status", () => {
    expect(normalizeCloudError({ status: 429 }).message).toContain("429");
    expect(normalizeCloudError(new Error("RESOURCE_EXHAUSTED: quota exceeded")).message).toContain("share quota");
    expect(getCloudErrorKind(new Error("RESOURCE_EXHAUSTED"))).toBe("rate_limit");
  });

  it("distinguishes invalid keys and network failures", () => {
    expect(normalizeCloudError({ status: 401 }).message).toContain("API key is invalid");
    expect(normalizeCloudError(new Error("Failed to fetch")).message).toContain("Check your network");
  });
});
