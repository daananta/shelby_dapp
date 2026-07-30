export interface GeminiUsagePreferences {
  chat: boolean;
  contentAnalysis: boolean;
  semanticSearch: boolean;
}

export const GEMINI_USAGE_STORAGE_KEY = "shelby-rag-explorer.gemini-usage-v1";
export const GEMINI_USAGE_EVENT = "shelby:gemini-usage";

export const DEFAULT_GEMINI_USAGE: GeminiUsagePreferences = {
  chat: true,
  contentAnalysis: false,
  semanticSearch: false,
};

export function getGeminiUsagePreferences(): GeminiUsagePreferences {
  if (typeof window === "undefined") return DEFAULT_GEMINI_USAGE;
  try {
    const saved = JSON.parse(localStorage.getItem(GEMINI_USAGE_STORAGE_KEY) ?? "{}") as Partial<GeminiUsagePreferences>;
    return {
      chat: typeof saved.chat === "boolean" ? saved.chat : DEFAULT_GEMINI_USAGE.chat,
      contentAnalysis: typeof saved.contentAnalysis === "boolean" ? saved.contentAnalysis : DEFAULT_GEMINI_USAGE.contentAnalysis,
      semanticSearch: typeof saved.semanticSearch === "boolean" ? saved.semanticSearch : DEFAULT_GEMINI_USAGE.semanticSearch,
    };
  } catch {
    return DEFAULT_GEMINI_USAGE;
  }
}

export function saveGeminiUsagePreferences(preferences: GeminiUsagePreferences) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(GEMINI_USAGE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences still update through the in-page event for this session.
  }
  window.dispatchEvent(new CustomEvent<GeminiUsagePreferences>(GEMINI_USAGE_EVENT, { detail: preferences }));
}
