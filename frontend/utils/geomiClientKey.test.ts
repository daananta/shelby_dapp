import { describe, expect, it } from "vitest";
import { isBlockingGeomiClientKeyIssue, parseGeomiClientKey } from "@/utils/geomiClientKey";

describe("Shelby client key policy", () => {
  it("allows ShelbyNet anonymous reads when no client key is configured", () => {
    const result = parseGeomiClientKey(undefined);
    expect(result).toEqual({ key: "", issue: "missing" });
    expect(isBlockingGeomiClientKeyIssue(result.issue)).toBe(false);
  });

  it("accepts a public Geomi browser key", () => {
    const result = parseGeomiClientKey("AG-public-client-key");
    expect(result).toEqual({ key: "AG-public-client-key", issue: null });
    expect(isBlockingGeomiClientKeyIssue(result.issue)).toBe(false);
  });

  it("blocks server or unknown key types from entering the browser bundle", () => {
    const result = parseGeomiClientKey("server-secret-key");
    expect(result).toEqual({ key: "", issue: "unsafe_key_type" });
    expect(isBlockingGeomiClientKeyIssue(result.issue)).toBe(true);
  });
});
