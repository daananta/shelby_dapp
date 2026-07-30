import { beforeEach, describe, expect, it, vi } from "vitest";

const accessControlMocks = vi.hoisted(() => ({
  view: vi.fn(),
}));

vi.mock("@/utils/aptosClient", () => ({
  aptosClient: () => ({ view: accessControlMocks.view }),
}));

import { createAccessControlBlobName, parseAccessPolicyQuery, queryAccessPolicies } from "@/utils/accessControl";

function u64le(value: bigint): string {
  let result = "";
  for (let index = 0; index < 8; index += 1) {
    result += Number(value & 0xffn).toString(16).padStart(2, "0");
    value >>= 8n;
  }
  return result;
}

describe("access_control query3 BCS", () => {
  beforeEach(() => {
    accessControlMocks.view.mockReset();
  });

  it("parses a timelock and its contract access decision", () => {
    // Option<Metadata>=Some; owner; scheme; empty greenbox; TimeLock; canAccess=Some(true)
    const response = `01${"00".repeat(32)}000001${u64le(1_800_000_000_000_000n)}0101`;
    expect(parseAccessPolicyQuery(response)).toEqual({ type: "timelock", lockedUntilMicros: 1_800_000_000_000_000, canAccess: true });
  });

  it("preserves GreenBox metadata required for protected blob decryption", () => {
    // Option<Metadata>=Some; owner; scheme=2; greenbox=aabbcc; TimeLock; canAccess=Some(true)
    const response = `01${"00".repeat(32)}0203aabbcc01${u64le(1_800_000_000_000_000n)}0101`;
    expect(parseAccessPolicyQuery(response)).toEqual({
      type: "timelock",
      lockedUntilMicros: 1_800_000_000_000_000,
      canAccess: true,
      greenBoxScheme: 2,
      greenBoxBytes: new Uint8Array([0xaa, 0xbb, 0xcc]),
    });
  });

  it("uses the exact full blob-name encoding required by the contract", () => {
    expect(createAccessControlBlobName("0xabc", "books/a.pdf")).toBe(`@${"abc".padStart(64, "0")}/books/a.pdf`);
  });

  it("marks a policy batch unverified when any policy query is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    accessControlMocks.view.mockImplementation(async ({ payload }: any) => {
      const fullName = String(payload.functionArguments[1]);
      if (fullName.endsWith("/offline.pdf")) throw new Error("temporary RPC failure");
      return ["0000"];
    });
    try {
      const snapshot = await queryAccessPolicies("0xabc", ["public.pdf", "offline.pdf"]);

      expect(snapshot.verified).toBe(false);
      expect(snapshot.unresolvedNames).toEqual(["offline.pdf"]);
      expect(snapshot.policies.get("public.pdf")).toEqual({ type: "none", canAccess: null });
      expect(snapshot.policies.get("offline.pdf")).toEqual({ type: "unknown", canAccess: null });
    } finally {
      warning.mockRestore();
    }
  });
});
