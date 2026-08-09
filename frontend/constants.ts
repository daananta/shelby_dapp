import { configuredDefaultShelbyNetwork, toAptosNetwork } from "@/utils/shelbyNetwork";

/** Static bootstrap default only. Runtime code must use ShelbyNetworkProvider. */
export const DEFAULT_SHELBY_NETWORK = configuredDefaultShelbyNetwork();
/** @deprecated Use useShelbyNetwork() and toAptosNetwork(). */
export const NETWORK = toAptosNetwork(DEFAULT_SHELBY_NETWORK);
