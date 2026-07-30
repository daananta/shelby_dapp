import { describe, expect, it } from "vitest";
import { createAccessControlBlobName, parseAccessPolicyQuery } from "@/utils/accessControl";

function u64le(value: bigint): string {
  let result = "";
  for (let index = 0; index < 8; index += 1) {
    result += Number(value & 0xffn).toString(16).padStart(2, "0");
    value >>= 8n;
  }
  return result;
}

describe("access_control query3 BCS", () => {
  it("parses a timelock and its contract access decision", () => {
    // Option<Metadata>=Some; owner; scheme; empty greenbox; TimeLock; canAccess=Some(true)
    const response = `01${"00".repeat(32)}000001${u64le(1_800_000_000_000_000n)}0101`;
    expect(parseAccessPolicyQuery(response)).toEqual({ type: "timelock", lockedUntilMicros: 1_800_000_000_000_000, canAccess: true });
  });

  it("uses the exact full blob-name encoding required by the contract", () => {
    expect(createAccessControlBlobName("0xabc", "books/a.pdf")).toBe(`@${"abc".padStart(64, "0")}/books/a.pdf`);
  });
});
