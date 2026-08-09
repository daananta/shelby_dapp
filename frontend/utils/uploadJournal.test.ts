import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMatchingUploadJournal, loadUploadJournal, uploadJournalKey, upsertUploadJournal } from "@/utils/uploadJournal";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

describe("network-scoped upload journal", () => {
  beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));

  it("does not reuse a resumable UID across Shelby networks", () => {
    upsertUploadJournal({
      version: 1,
      network: "testnet",
      owner: "0xABC",
      blobName: "report.pdf",
      size: 42,
      merkleRoot: "abcd",
      uid: "7",
      registrationHash: "0xregister",
      expirationMicros: 1_900_000_000_000_000,
      stage: "registered",
      updatedAt: 1,
    });

    expect(findMatchingUploadJournal({ network: "testnet", owner: "0xabc", blobName: "report.pdf", size: 42, merkleRoot: "ABCD" })?.uid).toBe("7");
    expect(findMatchingUploadJournal({ network: "testnet", owner: "0xabc", blobName: "report.pdf", size: 43, merkleRoot: "abcd" })).toBeUndefined();
    expect(findMatchingUploadJournal({ network: "testnet", owner: "0xabc", blobName: "report.pdf", size: 42, merkleRoot: "ffff" })).toBeUndefined();
    expect(findMatchingUploadJournal({ network: "shelbynet", owner: "0xabc", blobName: "report.pdf", size: 42, merkleRoot: "abcd" })).toBeUndefined();
  });

  it("rejects malformed or unsafe persisted records", () => {
    localStorage.setItem(uploadJournalKey("testnet", "0xabc"), JSON.stringify([
      { version: 1, network: "testnet", owner: "0xabc", blobName: "x", size: -1, merkleRoot: "not-hex", uid: "NaN", registrationHash: "", expirationMicros: 0, stage: "success", updatedAt: 0 },
    ]));
    expect(loadUploadJournal("testnet", "0xabc")).toEqual([]);
  });

  it("does not abort an upload flow when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
      removeItem: () => { throw new DOMException("Blocked", "SecurityError"); },
    });

    expect(upsertUploadJournal({
      version: 1,
      network: "shelbynet",
      owner: "0xabc",
      blobName: "resume.bin",
      size: 4,
      merkleRoot: "abcd",
      uid: "9",
      registrationHash: "0xregister",
      expirationMicros: 1_900_000_000_000_000,
      stage: "uploaded",
      updatedAt: 1,
    })).toBe(false);
  });
});
