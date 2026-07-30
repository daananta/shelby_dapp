import { describe, expect, it } from "vitest";
import {
  classifyShelbyServiceError,
  getShelbyErrorDiagnostic,
  getShelbyRefreshErrorCopy,
  ShelbyClientConfigurationError,
} from "@/utils/shelbyErrors";

describe("Shelby service errors", () => {
  it("turns a verbose Indexer 401 into safe user-facing copy", () => {
    const raw = Object.assign(
      new Error("Unauthorized: query getBlobs owner=0x123 Authorization: Bearer secret-value"),
      { response: { status: 401 } },
    );
    const kind = classifyShelbyServiceError(raw);
    const output = JSON.stringify({
      copy: getShelbyRefreshErrorCopy(kind, "en"),
      diagnostic: getShelbyErrorDiagnostic(raw),
    });

    expect(kind).toBe("authentication");
    expect(output).not.toMatch(/getBlobs|0x123|Bearer|secret-value/i);
    expect(output).toContain("not a wallet problem");
  });

  it("distinguishes deployment configuration, rate limits and network failures", () => {
    expect(classifyShelbyServiceError(new ShelbyClientConfigurationError("missing"))).toBe("configuration");
    expect(classifyShelbyServiceError({ status: 429 })).toBe("rate_limit");
    expect(classifyShelbyServiceError(new Error("Failed to fetch"))).toBe("network");
  });

  it("never repeats an unknown upstream message", () => {
    const raw = new Error("internal GraphQL body and variables");
    expect(getShelbyRefreshErrorCopy(classifyShelbyServiceError(raw), "vi").description)
      .not.toContain(raw.message);
  });
});
