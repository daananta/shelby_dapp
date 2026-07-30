import { describe, expect, it } from "vitest";
import { downloadBlobForRag, getBlobAccessDecision, isRagSourceEligible, parseTimestampMicros, readBlobAccessInfo } from "@/utils/blobAccess";

describe("blob access policy", () => {
  it("normalizes extension tags and allowlists", () => {
    const info = readBlobAccessInfo({ metadata: { access: { tag: "allow-list", addresses: ["0xAbC"] } } });
    expect(info).toMatchObject({ tag: "allowlist", allowlist: ["0xabc"] });
  });

  it("never admits a time lock before its unlock timestamp", () => {
    const now = 1_800_000_000_000_000;
    const locked = getBlobAccessDecision({ tag: "time lock", unlockAt: 1_800_000_001 }, "0x1", now);
    const unlocked = getBlobAccessDecision({ tag: "time lock", unlockAt: 1_799_999_999 }, "0x1", now);
    expect(locked.eligible).toBe(false);
    expect(unlocked.eligible).toBe(true);
  });

  it("uses access_control canAccess rather than guessing from a tag", () => {
    const denied = getBlobAccessDecision({ accessPolicy: { type: "allowlist", canAccess: false } }, "0x1");
    const granted = getBlobAccessDecision({ accessPolicy: { type: "allowlist", canAccess: true } }, "0x1");
    expect(denied.eligible).toBe(false);
    expect(granted).toMatchObject({ eligible: true, needsBroker: false });
  });

  it("admits a public blob that has no access_control metadata", () => {
    expect(getBlobAccessDecision({ accessPolicy: { type: "none", canAccess: null } }, "0x1")).toMatchObject({ eligible: true, needsBroker: false });
  });

  it("fails closed when an on-chain policy cannot be decoded", () => {
    expect(getBlobAccessDecision({ accessPolicy: { type: "unknown", canAccess: null } }, "0x1")).toMatchObject({ eligible: false, info: { unresolved: true } });
  });

  it("admits an elapsed on-chain timelock even when canAccess is omitted", () => {
    const decision = getBlobAccessDecision({ accessPolicy: { type: "timelock", lockedUntilMicros: 1_700_000_000_000_000, canAccess: null } }, "0x1", 1_800_000_000_000_000);
    expect(decision).toMatchObject({ eligible: true, needsBroker: false });
  });

  it("keeps registered-but-unwritten blobs out of the RAG queue", () => {
    expect(isRagSourceEligible({ isWritten: false, accessPolicy: { type: "none", canAccess: null } }, "0x1")).toBe(false);
  });

  it("keeps deleted and expired blobs out of the RAG queue", () => {
    const now = 1_800_000_000_000_000;
    expect(isRagSourceEligible({ isDeleted: true, accessPolicy: { type: "none", canAccess: null } }, "0x1", now)).toBe(false);
    expect(isRagSourceEligible({ expirationMicros: now - 1, accessPolicy: { type: "none", canAccess: null } }, "0x1", now)).toBe(false);
  });

  it("also rejects stale blob state at the download boundary", async () => {
    const shared = { owner: "0x1", blobName: "stale.pdf", walletAddress: "0x1", signMessage: async () => ({}) };
    await expect(downloadBlobForRag({ ...shared, blob: { isDeleted: true, accessPolicy: { type: "none" } } })).rejects.toThrow(/deleted/);
    await expect(downloadBlobForRag({ ...shared, blob: { isWritten: false, accessPolicy: { type: "none" } } })).rejects.toThrow(/not finished uploading/);
  });

  it("recognizes seconds, milliseconds, microseconds and ISO timestamps", () => {
    expect(parseTimestampMicros(1_700_000_000)).toBe(1_700_000_000_000_000);
    expect(parseTimestampMicros(1_700_000_000_000)).toBe(1_700_000_000_000_000);
    expect(parseTimestampMicros("2023-11-14T22:13:20.000Z")).toBe(1_700_000_000_000_000);
  });

  it("selects only public plus elapsed timelocks from a 37-blob inventory", () => {
    const now = 1_800_000_000_000_000;
    const publicBlobs = Array.from({ length: 10 }, (_, index) => ({ blobNameSuffix: `public-${index}.pdf`, accessPolicy: { type: "none", canAccess: null } }));
    const unlockedTimelocks = Array.from({ length: 5 }, (_, index) => ({ blobNameSuffix: `unlocked-${index}.pdf`, accessPolicy: { type: "timelock", lockedUntilMicros: now - 1, canAccess: null } }));
    const lockedTimelocks = Array.from({ length: 5 }, (_, index) => ({ blobNameSuffix: `locked-${index}.pdf`, accessPolicy: { type: "timelock", lockedUntilMicros: now + 1, canAccess: null } }));
    const allowlist = Array.from({ length: 8 }, (_, index) => ({ blobNameSuffix: `allow-${index}.pdf`, accessPolicy: { type: "allowlist", canAccess: true } }));
    const purchasable = Array.from({ length: 8 }, (_, index) => ({ blobNameSuffix: `paid-${index}.pdf`, accessPolicy: { type: "purchasable", canAccess: true } }));
    const unresolved = [{ blobNameSuffix: "unknown.pdf", accessPolicy: { type: "unknown", canAccess: null } }];
    const inventory = [...publicBlobs, ...unlockedTimelocks, ...lockedTimelocks, ...allowlist, ...purchasable, ...unresolved];

    expect(inventory).toHaveLength(37);
    expect(inventory.filter((blob) => isRagSourceEligible(blob, "0x1", now))).toHaveLength(15);
  });
});
