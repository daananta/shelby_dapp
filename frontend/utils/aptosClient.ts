import { Aptos, AptosConfig } from "@aptos-labs/ts-sdk";
import { getShelbyClientKeyResult } from "@/utils/geomiClientKey";
import { assertShelbyNetworkAvailable, getStoredShelbyNetwork, toAptosNetwork, type SupportedShelbyNetwork } from "@/utils/shelbyNetwork";

const clients = new Map<SupportedShelbyNetwork, Aptos>();

// Reuse same Aptos instance to utilize cookie based sticky routing
export function aptosClient(network: SupportedShelbyNetwork = getStoredShelbyNetwork()) {
  assertShelbyNetworkAvailable(network);
  const cached = clients.get(network);
  if (cached) return cached;
  const apiKey = getShelbyClientKeyResult(network).key || undefined;
  const client = new Aptos(new AptosConfig({
    network: toAptosNetwork(network),
    ...(apiKey ? { clientConfig: { API_KEY: apiKey } } : {}),
  }));
  clients.set(network, client);
  return client;
}
