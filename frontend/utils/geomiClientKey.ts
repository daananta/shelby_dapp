export type GeomiClientKeyIssue = "missing" | "unsafe_key_type" | null;

export interface GeomiClientKeyResult {
  key: string;
  issue: GeomiClientKeyIssue;
}

import type { SupportedShelbyNetwork } from "@/utils/shelbyNetwork";

/**
 * Only Geomi client keys (`AG-…`) are safe to ship in a public Vite bundle.
 * Server keys use a different format and must never be accepted here.
 */
export function parseGeomiClientKey(value: string | null | undefined): GeomiClientKeyResult {
  let candidate = value?.trim() ?? "";
  if (
    candidate.length >= 2
    && ((candidate.startsWith('"') && candidate.endsWith('"'))
      || (candidate.startsWith("'") && candidate.endsWith("'")))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }
  if (!candidate) return { key: "", issue: "missing" };
  // Geomi documents the public client-key prefix, but not a permanent
  // character alphabet for the opaque suffix. Validate the security boundary
  // (client vs server key) without rejecting future valid client formats.
  if (!/^AG-\S+$/i.test(candidate)) return { key: "", issue: "unsafe_key_type" };
  return { key: candidate, issue: null };
}

/** Missing keys use ShelbyNet's lower-limit anonymous read path. */
export function isBlockingGeomiClientKeyIssue(issue: GeomiClientKeyIssue): boolean {
  return issue === "unsafe_key_type";
}

const legacyClientKey = import.meta.env.VITE_SHELBY_CLIENT_API_KEY;
const configuredClientKeys: Record<SupportedShelbyNetwork, GeomiClientKeyResult> = {
  shelbynet: parseGeomiClientKey(import.meta.env.VITE_SHELBYNET_CLIENT_API_KEY),
  // The legacy key belonged to the old Testnet-only runtime. Never silently
  // reuse it for ShelbyNet, where a 401/403 must remain network-local.
  testnet: parseGeomiClientKey(import.meta.env.VITE_TESTNET_CLIENT_API_KEY || legacyClientKey),
};

export function getShelbyClientKeyResult(network: SupportedShelbyNetwork): GeomiClientKeyResult {
  return configuredClientKeys[network];
}

/** @deprecated Use getShelbyClientKeyResult(activeNetwork). */
export const SHELBY_CLIENT_API_KEY = configuredClientKeys.testnet.key;
/** @deprecated Use getShelbyClientKeyResult(activeNetwork). */
export const SHELBY_CLIENT_KEY_ISSUE = configuredClientKeys.testnet.issue;
