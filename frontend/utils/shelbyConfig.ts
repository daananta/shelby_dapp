import { ShelbyClient } from "@shelby-protocol/sdk/browser";
import { getShelbyClientKeyResult } from "@/utils/geomiClientKey";
import { assertShelbyNetworkAvailable, getStoredShelbyNetwork, toAptosNetwork, type SupportedShelbyNetwork } from "@/utils/shelbyNetwork";

export interface ShelbyRuntime {
  network: SupportedShelbyNetwork;
  client: ShelbyClient;
  blobClient: ShelbyClient["coordination"];
  rpcClient: ShelbyClient["rpc"];
  aptos: ShelbyClient["aptos"];
  blobApiUrl: string;
  clientKeyIssue: ReturnType<typeof getShelbyClientKeyResult>["issue"];
}

const runtimeCache = new Map<SupportedShelbyNetwork, ShelbyRuntime>();

const DEFAULT_BLOB_API_BASE_URL: Record<SupportedShelbyNetwork, string> = {
  // Keep the direct-download endpoint aligned with Shelby SDK 0.5.0's
  // SHELBYNET coordinator base URL. The similarly named api.shelbynet host is
  // used for other services and does not serve the blob REST path.
  shelbynet: "https://shelby.shelbynet.shelby.xyz/shelby",
  testnet: "https://api.testnet.shelby.xyz/shelby",
};

function configuredBlobApiUrl(network: SupportedShelbyNetwork): string {
  const configured = network === "shelbynet"
    ? import.meta.env.VITE_SHELBYNET_BLOB_API_URL
    : import.meta.env.VITE_TESTNET_BLOB_API_URL || import.meta.env.VITE_SHELBY_BLOB_API_URL;
  return (configured?.trim() || `${DEFAULT_BLOB_API_BASE_URL[network]}/v1/blobs`).replace(/\/$/, "");
}

export function getShelbyRuntime(network: SupportedShelbyNetwork = getStoredShelbyNetwork()): ShelbyRuntime {
  assertShelbyNetworkAvailable(network);
  const cached = runtimeCache.get(network);
  if (cached) return cached;
  const keyResult = getShelbyClientKeyResult(network);
  const aptosNetwork = toAptosNetwork(network);
  const blobApiUrl = configuredBlobApiUrl(network);
  const apiKey = keyResult.key || undefined;
  const client = new ShelbyClient({
    network: aptosNetwork,
    ...(apiKey ? { apiKey } : {}),
    aptos: {
      network: aptosNetwork,
      ...(apiKey ? { clientConfig: { API_KEY: apiKey } } : {}),
    },
  });
  const runtime: ShelbyRuntime = {
    network,
    client,
    blobClient: client.coordination,
    rpcClient: client.rpc,
    aptos: client.aptos,
    blobApiUrl,
    clientKeyIssue: keyResult.issue,
  };
  runtimeCache.set(network, runtime);
  return runtime;
}

// Keep HTTP access in one place. The SDK endpoint and the public blob endpoint
// are not necessarily the same, especially when switching between Shelby
// environments. Set VITE_SHELBY_BLOB_API_URL for a custom deployment.
export function getBlobNameSuffix(blobName: string, owner?: string): string {
  const normalized = blobName.replace(/^@/, "").replace(/^\//, "");
  const ownerPrefix = owner?.toLowerCase();
  const parts = normalized.split("/");
  if (ownerPrefix && parts[0]?.toLowerCase() === ownerPrefix) {
    return parts.slice(1).join("/");
  }
  return normalized;
}

export function getShelbyBlobUrl(owner: string, blobName: string, network: SupportedShelbyNetwork = getStoredShelbyNetwork()): string {
  const suffix = getBlobNameSuffix(blobName, owner)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${getShelbyRuntime(network).blobApiUrl}/${encodeURIComponent(owner)}/${suffix}`;
}
