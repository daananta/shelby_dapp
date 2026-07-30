/** Internal E2E-only switch. It cannot be enabled through a public URL. */
export function isMockWorkspace() {
  if (typeof window === "undefined") return false;
  return import.meta.env.DEV && (window as any).__SHELBY_E2E__ === true;
}
