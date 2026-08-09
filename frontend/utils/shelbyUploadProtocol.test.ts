import { describe, expect, it } from "vitest";
import { createBlobKey } from "@shelby-protocol/sdk/browser";
import { objectCommitFailure, resolveRegisteredBlobUids, uniqueStorageProviderAckCount } from "@/utils/shelbyUploadProtocol";

describe("Shelby SDK 0.5 upload gates", () => {
  it("maps UIDs by object name and reports a partial registration receipt", () => {
    const account = "0x1";
    const result = resolveRegisteredBlobUids(account, ["a.txt", "b.txt"], [
      { objectName: createBlobKey({ account, blobName: "a.txt" }), uid: 7n },
    ]);
    expect(result.resolved.get("a.txt")).toBe(7n);
    expect(result.missing).toEqual(["b.txt"]);
  });

  it("does not let duplicate SP slots satisfy acknowledgement quorum", () => {
    const signature = new Uint8Array([1]);
    expect(uniqueStorageProviderAckCount([
      { slot: 2, signature },
      { slot: 2, signature },
      { slot: 5, signature },
    ])).toBe(2);
  });

  it("fails closed for a rejection or missing committed state", () => {
    expect(objectCommitFailure("bad_ack", true)).toBe("commit_rejected");
    expect(objectCommitFailure(null, false)).toBe("not_written");
    expect(objectCommitFailure(null, true)).toBeNull();
  });
});
