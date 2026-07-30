import { normalizeGeminiApiKey } from "@/utils/geminiApiKey";

const CLOUD_API_KEY_STORAGE = "shelby-rag-explorer.gemini-api-key";
export const CLOUD_API_KEY_EVENT = "shelby:cloud-key";
let inMemoryCloudApiKey = "";

export function getStoredCloudApiKey(): string {
  try {
    const sessionKey = normalizeGeminiApiKey(sessionStorage.getItem(CLOUD_API_KEY_STORAGE));
    if (sessionKey) {
      inMemoryCloudApiKey = sessionKey;
      return sessionKey;
    }
  } catch {
    // Fall back to tab memory in privacy-restricted contexts.
  }
  try {
    const legacyKey = localStorage.getItem(CLOUD_API_KEY_STORAGE);
    if (legacyKey) {
      // Older builds persisted the BYOK credential. Remove it instead of
      // silently copying a long-lived secret into the new session-only store.
      localStorage.removeItem(CLOUD_API_KEY_STORAGE);
    }
  } catch {
    // Access can be blocked even when the Storage API exists.
  }
  return inMemoryCloudApiKey;
}

export function storeCloudApiKey(apiKey: string) {
  inMemoryCloudApiKey = normalizeGeminiApiKey(apiKey);
  try { sessionStorage.setItem(CLOUD_API_KEY_STORAGE, inMemoryCloudApiKey); } catch { /* tab memory remains available */ }
  try { localStorage.removeItem(CLOUD_API_KEY_STORAGE); } catch { /* best-effort legacy cleanup */ }
  window.dispatchEvent(new Event(CLOUD_API_KEY_EVENT));
}

export function clearStoredCloudApiKey() {
  inMemoryCloudApiKey = "";
  try { sessionStorage.removeItem(CLOUD_API_KEY_STORAGE); } catch { /* already unavailable */ }
  try { localStorage.removeItem(CLOUD_API_KEY_STORAGE); } catch { /* already unavailable */ }
  window.dispatchEvent(new Event(CLOUD_API_KEY_EVENT));
}
