import { Network } from "@aptos-labs/ts-sdk";

export type SupportedShelbyNetwork = "shelbynet" | "testnet";

export interface ShelbyNetworkCapabilities {
  availability: "active" | "temporarily_unavailable";
  canRead: boolean;
  canWrite: boolean;
  uploadProtocol: "object-v2" | "legacy";
}

export const SHELBY_NETWORK_CAPABILITIES: Readonly<Record<SupportedShelbyNetwork, ShelbyNetworkCapabilities>> = {
  shelbynet: {
    availability: "active",
    canRead: true,
    canWrite: true,
    uploadProtocol: "object-v2",
  },
  // Shelby Testnet is currently restricted to Shelby core developers. Keep its
  // identity and legacy data model for a future reopening, but never construct
  // clients or send requests to it from this public release.
  testnet: {
    availability: "temporarily_unavailable",
    canRead: false,
    canWrite: false,
    uploadProtocol: "legacy",
  },
};

export class ShelbyNetworkUnavailableError extends Error {
  readonly network: SupportedShelbyNetwork;

  constructor(network: SupportedShelbyNetwork) {
    super(`${shelbyNetworkLabel(network)} is temporarily unavailable.`);
    this.name = "ShelbyNetworkUnavailableError";
    this.network = network;
  }
}

export interface ShelbyWorkspaceIdentity {
  network: SupportedShelbyNetwork;
  owner: string;
}

export const SHELBY_NETWORK_STORAGE_KEY = "shelby-rag-explorer.network-v1";

export function isSupportedShelbyNetwork(value: unknown): value is SupportedShelbyNetwork {
  return value === "shelbynet" || value === "testnet";
}

export function getShelbyNetworkCapabilities(network: SupportedShelbyNetwork): ShelbyNetworkCapabilities {
  return SHELBY_NETWORK_CAPABILITIES[network];
}

export function isShelbyNetworkAvailable(network: SupportedShelbyNetwork): boolean {
  return getShelbyNetworkCapabilities(network).availability === "active";
}

export function assertShelbyNetworkAvailable(network: SupportedShelbyNetwork): void {
  if (!isShelbyNetworkAvailable(network)) throw new ShelbyNetworkUnavailableError(network);
}

export function resolveOperationalShelbyNetwork(value: unknown): SupportedShelbyNetwork {
  return isSupportedShelbyNetwork(value) && isShelbyNetworkAvailable(value) ? value : "shelbynet";
}

export function configuredDefaultShelbyNetwork(): SupportedShelbyNetwork {
  const configured = import.meta.env.VITE_DEFAULT_SHELBY_NETWORK?.trim().toLowerCase();
  return resolveOperationalShelbyNetwork(configured);
}

export function getStoredShelbyNetwork(): SupportedShelbyNetwork {
  if (typeof window === "undefined") return configuredDefaultShelbyNetwork();
  try {
    const saved = window.localStorage.getItem(SHELBY_NETWORK_STORAGE_KEY)?.toLowerCase();
    const resolved = saved ? resolveOperationalShelbyNetwork(saved) : configuredDefaultShelbyNetwork();
    // Migrate only the network preference. Testnet-scoped RAG, chat and upload
    // journals intentionally remain untouched for a future reopening.
    if (saved && saved !== resolved) window.localStorage.setItem(SHELBY_NETWORK_STORAGE_KEY, resolved);
    return resolved;
  } catch {
    return configuredDefaultShelbyNetwork();
  }
}

export function persistShelbyNetwork(network: SupportedShelbyNetwork): boolean {
  if (!isShelbyNetworkAvailable(network)) return false;
  try { window.localStorage.setItem(SHELBY_NETWORK_STORAGE_KEY, network); } catch { /* in-memory selection still works */ }
  return true;
}

export function toAptosNetwork(network: SupportedShelbyNetwork): Network.SHELBYNET | Network.TESTNET {
  return network === "shelbynet" ? Network.SHELBYNET : Network.TESTNET;
}

export function shelbyNetworkLabel(network: SupportedShelbyNetwork): string {
  return network === "shelbynet" ? "ShelbyNet" : "Shelby Testnet";
}

export interface WalletNetworkDescriptor {
  name?: string | null;
  chainId?: number | null;
  url?: string | null;
}

const SHELBYNET_APTOS_RPC_HOSTS = new Set(["api.shelbynet.shelby.xyz"]);

function networkUrlHostname(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isWalletNetworkMatch(
  walletNetwork: WalletNetworkDescriptor | string | null | undefined,
  network: SupportedShelbyNetwork,
): boolean {
  const descriptor = typeof walletNetwork === "string" ? { name: walletNetwork } : walletNetwork;
  const walletNetworkName = descriptor?.name?.trim().toLowerCase();
  if (!walletNetworkName) return false;
  if (walletNetworkName === toAptosNetwork(network).toLowerCase()) return true;

  // Petra currently exposes ShelbyNet as a custom network even when its RPC is
  // the canonical ShelbyNet Aptos endpoint. Accept only that exact hostname;
  // arbitrary custom networks remain blocked.
  return network === "shelbynet"
    && walletNetworkName === Network.CUSTOM
    && SHELBYNET_APTOS_RPC_HOSTS.has(networkUrlHostname(descriptor?.url));
}

export function createShelbyWorkspaceKey(identity: ShelbyWorkspaceIdentity): string {
  return `${identity.network}:${identity.owner.toLowerCase()}`;
}

export function parseShelbyWorkspaceKey(value: string): ShelbyWorkspaceIdentity {
  const separator = value.indexOf(":");
  if (separator > 0) {
    const network = value.slice(0, separator);
    if (isSupportedShelbyNetwork(network)) {
      return { network, owner: value.slice(separator + 1).toLowerCase() };
    }
  }
  // Existing v4 records were created on Shelby Testnet.
  return { network: "testnet", owner: value.toLowerCase() };
}
