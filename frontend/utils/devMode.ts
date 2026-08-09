/** Internal E2E-only wallet. It cannot be enabled through a public URL. */
export function isE2EWalletConnected() {
  if (typeof window === "undefined") return false;
  const mode = (window as any).__SHELBY_E2E__;
  return import.meta.env.DEV && (mode === true || mode === "remote-error" || mode === "remote-live");
}

/** Full deterministic storage mock used by the regular E2E suite. */
export function isMockWorkspace() {
  if (typeof window === "undefined") return false;
  return import.meta.env.DEV && (window as any).__SHELBY_E2E__ === true;
}

/** Deterministic unsafe-client-key state used by the configuration error regression test. */
export function isE2EShelbyConfigurationError() {
  if (typeof window === "undefined") return false;
  return import.meta.env.DEV && (window as any).__SHELBY_E2E__ === "remote-error";
}
