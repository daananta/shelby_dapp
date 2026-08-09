import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function seedLegacyV4(owner: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("shelby-rag-explorer-v4", 1);
    request.onupgradeneeded = () => {
      const value = request.result;
      const manifests = value.createObjectStore("manifests", { keyPath: "id" });
      manifests.createIndex("owner", "owner");
      value.createObjectStore("pages", { keyPath: "id" }).createIndex("owner", "owner");
      value.createObjectStore("chunks", { keyPath: "id" }).createIndex("owner", "owner");
      value.createObjectStore("workspace", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = db.transaction(["manifests", "pages", "chunks", "workspace"], "readwrite");
  transaction.objectStore("manifests").put({
    id: `${owner}:legacy.txt`, owner, source: "legacy.txt", displayName: "legacy.txt", revision: "legacy",
    mimeType: "text/plain", type: "text", aliases: [], authors: [], pageCount: 1, chunkCount: 0,
    ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: 1,
  });
  transaction.objectStore("workspace").put({ id: owner, owner, inventory: null, stories: [] });
  await transactionDone(transaction);
  db.close();
}

describe("v4 to v5 Testnet migration", () => {
  it("copies legacy data to Testnet idempotently and never into ShelbyNet", async () => {
    const owner = "0xlegacy-migration";
    await seedLegacyV4(owner);
    const rag = await import("@/utils/ragOrama");

    expect(await rag.hasPersistedRagWorkspace(`testnet:${owner}`)).toBe(true);
    expect(await rag.hasPersistedRagWorkspace(`shelbynet:${owner}`)).toBe(false);
    expect(await rag.hasPersistedRagWorkspace(`testnet:${owner}`)).toBe(true);

    await rag.setActiveRagOwner(`testnet:${owner}`);
    expect(rag.getRagSources()).toMatchObject([{ source: "legacy.txt" }]);
  });
});
