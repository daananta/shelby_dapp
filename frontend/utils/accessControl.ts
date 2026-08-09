import { BlobNameSchema } from "@shelby-protocol/sdk/browser";
import { aptosClient } from "@/utils/aptosClient";
import { getShelbyRuntime } from "@/utils/shelbyConfig";
import { getStoredShelbyNetwork, type SupportedShelbyNetwork } from "@/utils/shelbyNetwork";

const DEFAULT_TESTNET_ACCESS_CONTROL_MODULE_ADDRESS = "0x5211945b33c28c975544f65d361c3739a0244eb6779920128d72e7f70c088069";

/** A module address is network-local; never query Testnet's deployment on ShelbyNet. */
export function getAccessControlModuleAddress(network: SupportedShelbyNetwork): string | null {
  const configured = network === "shelbynet"
    ? import.meta.env.VITE_SHELBYNET_ACCESS_CONTROL_MODULE_ADDRESS
    : import.meta.env.VITE_TESTNET_ACCESS_CONTROL_MODULE_ADDRESS || import.meta.env.VITE_ACCESS_CONTROL_MODULE_ADDRESS;
  const value = configured?.trim() || (network === "testnet" ? DEFAULT_TESTNET_ACCESS_CONTROL_MODULE_ADDRESS : "");
  return value || null;
}

/** @deprecated Testnet compatibility export; use getAccessControlModuleAddress(network). */
export const ACCESS_CONTROL_MODULE_ADDRESS = getAccessControlModuleAddress("testnet")!;

export interface AccessPolicyInfo {
  type: "allowlist" | "timelock" | "purchasable" | "custom" | "none" | "unknown";
  allowlistCount?: number;
  lockedUntilMicros?: number;
  price?: number;
  canAccess?: boolean | null;
  /** GreenBox metadata needed by an official decryptor after access is granted. */
  greenBoxScheme?: number;
  greenBoxBytes?: Uint8Array;
}

export interface AccessPoliciesSnapshot {
  policies: Map<string, AccessPolicyInfo>;
  /** False means at least one policy could not be verified or decoded. */
  verified: boolean;
  unresolvedNames: string[];
}

/** Cache access checks per network, wallet and normalized blob inventory. */
export function accessPolicyQueryKey(
  network: SupportedShelbyNetwork,
  ownerAddress: string,
  blobNames: string[],
) {
  return [
    "shelby",
    "access-policies",
    network,
    ownerAddress.toLowerCase(),
    [...new Set(blobNames.filter(Boolean))].sort(),
  ] as const;
}

class BcsReader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  readU8(): number {
    if (this.offset >= this.data.length) throw new Error("BCS bị cắt ngắn.");
    return this.data[this.offset++];
  }
  readBool(): boolean {
    const value = this.readU8();
    if (value !== 0 && value !== 1) throw new Error("BCS bool không hợp lệ.");
    return value === 1;
  }
  readU64(): bigint {
    const bytes = this.readBytes(8);
    let value = 0n;
    for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
    return value;
  }
  readUleb128(): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.readU8();
      if (index === 4 && (byte & 0xf0) !== 0) throw new Error("ULEB128 quá lớn.");
      value += (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error("ULEB128 quá lớn.");
      if ((byte & 0x80) === 0) {
        if (index > 0 && (byte & 0x7f) === 0) throw new Error("ULEB128 không đúng chuẩn.");
        return value;
      }
      multiplier *= 128;
    }
    throw new Error("ULEB128 quá lớn.");
  }
  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.data.length - this.offset) {
      throw new Error("BCS bị cắt ngắn.");
    }
    const result = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  skipBytes(length: number) { this.readBytes(length); }
  readVectorU8(): Uint8Array { return this.readBytes(this.readUleb128()); }
  readString(): string { return new TextDecoder().decode(this.readVectorU8()); }
  assertDone() {
    if (this.offset !== this.data.length) throw new Error("BCS chứa dữ liệu thừa.");
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2) throw new Error("BCS hex không hợp lệ.");
  return Uint8Array.from({ length: clean.length / 2 }, (_, index) => Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16));
}

/** Matches the BCS Query3Result layout implemented by access_control::query3_bcs. */
export function parseAccessPolicyQuery(hex: string): AccessPolicyInfo {
  try {
    const reader = new BcsReader(hexToBytes(hex));
    if (!reader.readBool()) {
      const hasCanAccess = reader.readBool();
      const policy: AccessPolicyInfo = { type: "none", canAccess: hasCanAccess ? reader.readBool() : null };
      reader.readBool(); // receipt_collection_initialized
      reader.assertDone();
      return policy;
    }
    reader.skipBytes(32); // metadata owner
    const greenBoxScheme = reader.readU8();
    const greenBoxBytes = reader.readVectorU8();
    const policyVariant = reader.readUleb128();
    let policy: AccessPolicyInfo;
    if (policyVariant === 0) {
      const allowlistCount = reader.readUleb128();
      reader.skipBytes(allowlistCount * 32);
      policy = { type: "allowlist", allowlistCount };
    } else if (policyVariant === 1) {
      policy = { type: "timelock", lockedUntilMicros: Number(reader.readU64()) };
    } else if (policyVariant === 2) {
      policy = { type: "purchasable", price: Number(reader.readU64()) };
    } else if (policyVariant === 3) {
      reader.skipBytes(32);
      reader.readString();
      policy = { type: "custom" };
    } else {
      return { type: "unknown", canAccess: null };
    }
    const hasCanAccess = reader.readBool();
    policy.canAccess = hasCanAccess ? reader.readBool() : null;
    reader.readBool(); // receipt_collection_initialized
    if (greenBoxScheme !== 0 || greenBoxBytes.byteLength > 0) {
      policy.greenBoxScheme = greenBoxScheme;
      policy.greenBoxBytes = greenBoxBytes;
    }
    reader.assertDone();
    return policy;
  } catch (error) {
    console.warn("Không thể đọc BCS access policy:", error);
    return { type: "unknown", canAccess: null };
  }
}

export function createAccessControlBlobName(ownerAddress: string, blobNameSuffix: string): string {
  const owner = ownerAddress.replace(/^0x/, "").padStart(64, "0");
  return `@${owner}/${blobNameSuffix.replace(/^\/+/, "")}`;
}

/**
 * Queries the same on-chain source as shelbyproject's Explorer. A query error
 * deliberately remains `unknown`, never silently becomes a public blob.
 */
export async function queryAccessPolicy(
  ownerAddress: string,
  blobNameSuffix: string,
  signal?: AbortSignal,
  network: SupportedShelbyNetwork = getStoredShelbyNetwork(),
): Promise<AccessPolicyInfo> {
  try {
    signal?.throwIfAborted();
    const moduleAddress = getAccessControlModuleAddress(network);
    if (!moduleAddress) {
      // ShelbyNet object-v2 does not use the legacy Testnet access-control
      // deployment. Verify the on-chain encryption scheme instead: only an
      // explicitly unencrypted object is readable without a decryptor.
      const metadata = await getShelbyRuntime(network).blobClient.getFullObjectMetadata({
        account: ownerAddress,
        name: BlobNameSchema.parse(blobNameSuffix),
      });
      signal?.throwIfAborted();
      if (metadata?.encryption === "Unencrypted") return { type: "none", canAccess: true };
      return { type: "unknown", canAccess: null };
    }
    const result = await aptosClient(network).view({
      payload: {
        function: `${moduleAddress}::access_control::query3_bcs`,
        functionArguments: [ownerAddress, createAccessControlBlobName(ownerAddress, blobNameSuffix)],
      },
    });
    signal?.throwIfAborted();
    if (typeof result[0] !== "string") return { type: "unknown", canAccess: null };
    return parseAccessPolicyQuery(result[0]);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn(`Không thể truy vấn access policy cho ${blobNameSuffix}:`, error);
    return { type: "unknown", canAccess: null };
  }
}

export async function queryAccessPolicies(
  ownerAddress: string,
  blobNames: string[],
  signal?: AbortSignal,
  network: SupportedShelbyNetwork = getStoredShelbyNetwork(),
): Promise<AccessPoliciesSnapshot> {
  const policiesByName = new Map<string, AccessPolicyInfo>();
  const uniqueNames = [...new Set(blobNames.filter(Boolean))];
  const batchSize = 6;
  for (let offset = 0; offset < uniqueNames.length; offset += batchSize) {
    signal?.throwIfAborted();
    const batch = uniqueNames.slice(offset, offset + batchSize);
    const policies = await Promise.all(batch.map((blobName) => queryAccessPolicy(ownerAddress, blobName, signal, network)));
    signal?.throwIfAborted();
    batch.forEach((blobName, index) => policiesByName.set(blobName, policies[index]));
  }
  const unresolvedNames = uniqueNames.filter((name) => policiesByName.get(name)?.type === "unknown");
  return {
    policies: policiesByName,
    verified: unresolvedNames.length === 0,
    unresolvedNames,
  };
}
