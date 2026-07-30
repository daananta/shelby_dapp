export type GeomiClientKeyIssue = "missing" | "unsafe_key_type" | null;

export interface GeomiClientKeyResult {
  key: string;
  issue: GeomiClientKeyIssue;
}

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

const configuredClientKey = parseGeomiClientKey(import.meta.env.VITE_SHELBY_CLIENT_API_KEY);

export const SHELBY_CLIENT_API_KEY = configuredClientKey.key;
export const SHELBY_CLIENT_KEY_ISSUE = configuredClientKey.issue;
