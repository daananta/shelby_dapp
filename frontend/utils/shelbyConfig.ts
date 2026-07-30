import { ShelbyBlobClient, ShelbyRPCClient } from "@shelby-protocol/sdk/browser";

const rawApiKey = import.meta.env.VITE_APTOS_API_KEY || "";
const apiKey = rawApiKey.startsWith('"') && rawApiKey.endsWith('"')
  ? rawApiKey.slice(1, -1)
  : rawApiKey;

export const sdkConfig = {
  network: (import.meta.env.VITE_APP_NETWORK ?? "testnet") as any,
  apiKey: apiKey || "",
};

export const blobClient = new ShelbyBlobClient(sdkConfig);
export const rpcClient = new ShelbyRPCClient(sdkConfig);

// Keep HTTP access in one place. The SDK endpoint and the public blob endpoint
// are not necessarily the same, especially when switching between Shelby
// environments. Set VITE_SHELBY_BLOB_API_URL for a custom deployment.
export const shelbyBlobApiUrl = (
  import.meta.env.VITE_SHELBY_BLOB_API_URL ??
  "https://api.testnet.shelby.xyz/shelby/v1/blobs"
).replace(/\/$/, "");

export function getBlobNameSuffix(blobName: string, owner?: string): string {
  const normalized = blobName.replace(/^@/, "").replace(/^\//, "");
  const ownerPrefix = owner?.toLowerCase();
  const parts = normalized.split("/");
  if (ownerPrefix && parts[0]?.toLowerCase() === ownerPrefix) {
    return parts.slice(1).join("/");
  }
  return normalized;
}

export function getShelbyBlobUrl(owner: string, blobName: string): string {
  const suffix = getBlobNameSuffix(blobName, owner)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${shelbyBlobApiUrl}/${encodeURIComponent(owner)}/${suffix}`;
}

// Helper to clean key strings from ed25519-priv- or 0x prefixes
export const cleanKey = (key: string): string => {
  let k = key.trim();
  if (k.startsWith("ed25519-priv-")) {
    k = k.substring("ed25519-priv-".length);
  }
  if (k.startsWith("0x")) {
    k = k.substring(2);
  }
  return k;
};
