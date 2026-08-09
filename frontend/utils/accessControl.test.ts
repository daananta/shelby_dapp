import { beforeEach, describe, expect, it, vi } from "vitest";

const accessControlMocks = vi.hoisted(() => ({
  view: vi.fn(),
  getFullObjectMetadata: vi.fn(),
}));

vi.mock("@/utils/aptosClient", () => ({
  aptosClient: () => ({ view: accessControlMocks.view }),
}));

vi.mock("@/utils/shelbyConfig", () => ({
  getShelbyRuntime: () => ({ blobClient: { getFullObjectMetadata: accessControlMocks.getFullObjectMetadata } }),
}));

import {
  accessPolicyQueryKey,
  createAccessControlBlobName,
  getAccessControlModuleAddress,
  parseAccessPolicyQuery,
  queryAccessPolicies,
} from "@/utils/accessControl";

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
    accessControlMocks.getFullObjectMetadata.mockReset();
  });

  it("isolates and normalizes access-policy query keys by network and wallet", () => {
    const shelbyNet = accessPolicyQueryKey("shelbynet", "0xABC", ["b.txt", "a.txt", "a.txt"]);
    const testnet = accessPolicyQueryKey("testnet", "0xABC", ["a.txt", "b.txt"]);

    expect(shelbyNet).toEqual(["shelby", "access-policies", "shelbynet", "0xabc", ["a.txt", "b.txt"]]);
    expect(testnet).not.toEqual(shelbyNet);
  });

  it("parses a timelock and its contract access decision", () => {
    // Option<Metadata>=Some; owner; scheme; empty greenbox; TimeLock;
    // canAccess=Some(true); receiptCollectionInitialized=false.
    const response = `01${"00".repeat(32)}000001${u64le(1_800_000_000_000_000n)}010100`;
    expect(parseAccessPolicyQuery(response)).toEqual({ type: "timelock", lockedUntilMicros: 1_800_000_000_000_000, canAccess: true });
  });

  it("preserves GreenBox metadata required for protected blob decryption", () => {
    // Option<Metadata>=Some; owner; scheme=2; greenbox=aabbcc; TimeLock;
    // canAccess=Some(true); receiptCollectionInitialized=true.
    const response = `01${"00".repeat(32)}0203aabbcc01${u64le(1_800_000_000_000_000n)}010101`;
    expect(parseAccessPolicyQuery(response)).toEqual({
      type: "timelock",
      lockedUntilMicros: 1_800_000_000_000_000,
      canAccess: true,
      greenBoxScheme: 2,
      greenBoxBytes: new Uint8Array([0xaa, 0xbb, 0xcc]),
    });
  });

  it("accepts the current Query3Result layout for a public blob", () => {
    // metadata=None; canAccess=None; receiptCollectionInitialized=false.
    expect(parseAccessPolicyQuery("000000")).toEqual({ type: "none", canAccess: null });
  });

  it("fails closed for truncated or non-canonical BCS values", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const overlongEmptyVector = `01${"00".repeat(32)}008000000000`;
      for (const response of ["", "00", "0001", "02", "01", "0002", "0000", "00000000", overlongEmptyVector]) {
        expect(parseAccessPolicyQuery(response)).toEqual({ type: "unknown", canAccess: null });
      }
    } finally {
      warning.mockRestore();
    }
  });

  it("uses the exact full blob-name encoding required by the contract", () => {
    expect(createAccessControlBlobName("0xabc", "books/a.pdf")).toBe(`@${"abc".padStart(64, "0")}/books/a.pdf`);
  });

  it("marks a policy batch unverified when any policy query is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    accessControlMocks.view.mockImplementation(async ({ payload }: any) => {
      const fullName = String(payload.functionArguments[1]);
      if (fullName.endsWith("/offline.pdf")) throw new Error("temporary RPC failure");
      return ["000000"];
    });
    try {
      const snapshot = await queryAccessPolicies("0xabc", ["public.pdf", "offline.pdf"], undefined, "testnet");

      expect(snapshot.verified).toBe(false);
      expect(snapshot.unresolvedNames).toEqual(["offline.pdf"]);
      expect(snapshot.policies.get("public.pdf")).toEqual({ type: "none", canAccess: null });
      expect(snapshot.policies.get("offline.pdf")).toEqual({ type: "unknown", canAccess: null });
    } finally {
      warning.mockRestore();
    }
  });

  it("uses ShelbyNet object encryption without reusing the Testnet access contract", async () => {
    expect(getAccessControlModuleAddress("shelbynet")).toBeNull();
    accessControlMocks.getFullObjectMetadata.mockImplementation(async ({ name }: { name: string }) => ({
      encryption: name === "public.pdf" ? "Unencrypted" : "AES_GCM_V1",
    }));
    const snapshot = await queryAccessPolicies("0xabc", ["public.pdf", "private.pdf"], undefined, "shelbynet");
    expect(snapshot).toMatchObject({ verified: false, unresolvedNames: ["private.pdf"] });
    expect(snapshot.policies.get("public.pdf")).toEqual({ type: "none", canAccess: true });
    expect(snapshot.policies.get("private.pdf")).toEqual({ type: "unknown", canAccess: null });
    expect(accessControlMocks.view).not.toHaveBeenCalled();
  });
});
