import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function seedLegacyState(owner: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("shelby-rag-explorer", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = db.transaction("state", "readwrite");
  transaction.objectStore("state").put({
    activeRagOwner: owner,
    sources: [{ source: "old-guide.pdf", displayName: "Old guide", type: "text", pageCount: 4, indexedAt: 10 }],
    blobInventory: { owner, names: ["old-guide.pdf"], fetchedAt: 20 },
  }, "orama-v2");
  await transactionDone(transaction);
  db.close();
}

describe("pre-v4 RAG migration", () => {
  it("copies a raw wallet workspace only into its legacy Testnet identity", async () => {
    const owner = "0xlegacy-state";
    await seedLegacyState(owner);
    const rag = await import("@/utils/ragOrama");

    await rag.setActiveRagOwner(`testnet:${owner}`);
    expect(rag.getRagSources()).toMatchObject([{
      source: "old-guide.pdf",
      status: "upgrade_required",
    }]);
    expect(rag.getShelbyBlobInventory()).toMatchObject({ names: ["old-guide.pdf"], fetchedAt: 20 });
    expect(await rag.hasPersistedRagWorkspace(`shelbynet:${owner}`)).toBe(false);
  });
});
