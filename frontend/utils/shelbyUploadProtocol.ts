import { createBlobKey, type StorageProviderAck } from "@shelby-protocol/sdk/browser";

export interface RegisteredBlobUid {
  objectName: string;
  uid: bigint;
}

/** Maps a registration receipt back to requested names without relying on event order. */
export function resolveRegisteredBlobUids(account: string, blobNames: string[], registered: RegisteredBlobUid[]) {
  const byObjectName = new Map(registered.map((entry) => [entry.objectName, entry.uid]));
  const resolved = new Map<string, bigint>();
  const missing: string[] = [];
  for (const blobName of blobNames) {
    const objectName = createBlobKey({ account, blobName });
    const uid = byObjectName.get(objectName);
    if (uid === undefined) missing.push(blobName);
    else resolved.set(blobName, uid);
  }
  return { resolved, missing };
}

/** Acknowledgements count by SP slot; duplicate signatures never satisfy quorum. */
export function uniqueStorageProviderAckCount(acks: StorageProviderAck[]): number {
  return new Set(acks.map((ack) => ack.slot)).size;
}

export function objectCommitFailure(rejection: string | null | undefined, isWritten: boolean | undefined) {
  if (rejection) return "commit_rejected" as const;
  if (!isWritten) return "not_written" as const;
  return null;
}
