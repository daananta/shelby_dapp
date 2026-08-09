import type { SupportedShelbyNetwork } from "@/utils/shelbyNetwork";

export type UploadJournalStage = "registered" | "uploaded" | "committing" | "failed";

export interface UploadJournalRecord {
  version: 1;
  network: SupportedShelbyNetwork;
  owner: string;
  blobName: string;
  size: number;
  merkleRoot: string;
  uid: string;
  registrationHash: string;
  expirationMicros: number;
  stage: UploadJournalStage;
  updatedAt: number;
  commitHash?: string;
  error?: string;
}

const PREFIX = "shelby-rag-explorer.upload-journal-v1";

export function uploadJournalKey(network: SupportedShelbyNetwork, owner: string): string {
  return `${PREFIX}:${network}:${owner.toLowerCase()}`;
}

function validRecord(value: unknown): value is UploadJournalRecord {
  const record = value as Partial<UploadJournalRecord> | null;
  const validStages: UploadJournalStage[] = ["registered", "uploaded", "committing", "failed"];
  return Boolean(record && record.version === 1 && (record.network === "shelbynet" || record.network === "testnet")
    && typeof record.owner === "string" && record.owner.length > 0
    && typeof record.blobName === "string" && record.blobName.length > 0
    && typeof record.uid === "string" && /^\d+$/.test(record.uid)
    && Number.isSafeInteger(record.size) && Number(record.size) >= 0
    && typeof record.merkleRoot === "string" && /^[0-9a-f]+$/i.test(record.merkleRoot)
    && typeof record.registrationHash === "string" && record.registrationHash.length > 0
    && Number.isSafeInteger(record.expirationMicros) && Number(record.expirationMicros) > 0
    && validStages.includes(record.stage as UploadJournalStage)
    && Number.isSafeInteger(record.updatedAt) && Number(record.updatedAt) > 0
    && (record.commitHash === undefined || typeof record.commitHash === "string")
    && (record.error === undefined || typeof record.error === "string"));
}

export function loadUploadJournal(network: SupportedShelbyNetwork, owner: string): UploadJournalRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(uploadJournalKey(network, owner)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(validRecord) : [];
  } catch {
    return [];
  }
}

export function upsertUploadJournal(record: UploadJournalRecord): boolean {
  try {
    const records = loadUploadJournal(record.network, record.owner);
    const index = records.findIndex((item) => item.blobName === record.blobName);
    if (index >= 0) records[index] = record;
    else records.push(record);
    localStorage.setItem(uploadJournalKey(record.network, record.owner), JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

export function removeUploadJournal(network: SupportedShelbyNetwork, owner: string, blobName: string): boolean {
  try {
    const records = loadUploadJournal(network, owner).filter((item) => item.blobName !== blobName);
    if (records.length) localStorage.setItem(uploadJournalKey(network, owner), JSON.stringify(records));
    else localStorage.removeItem(uploadJournalKey(network, owner));
    return true;
  } catch {
    return false;
  }
}

export function findMatchingUploadJournal(params: {
  network: SupportedShelbyNetwork;
  owner: string;
  blobName: string;
  size: number;
  merkleRoot: string;
}): UploadJournalRecord | undefined {
  const record = loadUploadJournal(params.network, params.owner).find((item) => item.blobName === params.blobName);
  if (!record) return undefined;
  if (record.size !== params.size || record.merkleRoot.toLowerCase() !== params.merkleRoot.toLowerCase()) return undefined;
  return record;
}
