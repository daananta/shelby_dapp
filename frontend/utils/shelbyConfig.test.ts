import { describe, expect, it } from "vitest";
import { getShelbyBlobUrl } from "@/utils/shelbyConfig";

describe("Shelby network endpoints", () => {
  it("never reuses the dormant Testnet blob endpoint for ShelbyNet", () => {
    const shelbyNetUrl = getShelbyBlobUrl("0xabc", "folder/file.txt", "shelbynet");

    expect(shelbyNetUrl).toBe("https://shelby.shelbynet.shelby.xyz/shelby/v1/blobs/0xabc/folder/file.txt");
    expect(shelbyNetUrl).not.toContain("api.testnet.shelby.xyz");
    expect(() => getShelbyBlobUrl("0xabc", "folder/file.txt", "testnet")).toThrow(/temporarily unavailable/i);
  });
});
