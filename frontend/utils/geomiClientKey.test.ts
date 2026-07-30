import { describe, expect, it } from "vitest";
import { parseGeomiClientKey } from "@/utils/geomiClientKey";

describe("Geomi browser client key", () => {
  it("accepts only a frontend-safe AG client key", () => {
    expect(parseGeomiClientKey(' "AG-MOCK_CLIENT_123" ')).toEqual({
      key: "AG-MOCK_CLIENT_123",
      issue: null,
    });
    expect(parseGeomiClientKey("AG-client.token-v2")).toEqual({
      key: "AG-client.token-v2",
      issue: null,
    });
  });

  it("rejects a server key instead of exposing it in the browser bundle", () => {
    expect(parseGeomiClientKey("aptoslabs_private-server-key")).toEqual({
      key: "",
      issue: "unsafe_key_type",
    });
  });

  it("reports a missing deployment key", () => {
    expect(parseGeomiClientKey(undefined)).toEqual({ key: "", issue: "missing" });
  });

  it("rejects malformed values with whitespace after the public prefix", () => {
    expect(parseGeomiClientKey("AG-not a key")).toEqual({
      key: "",
      issue: "unsafe_key_type",
    });
  });
});
