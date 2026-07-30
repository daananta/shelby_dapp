import { useEffect, useState } from "react";
import { GEMINI_USAGE_EVENT, getGeminiUsagePreferences, saveGeminiUsagePreferences, type GeminiUsagePreferences } from "@/utils/geminiUsage";

export function useGeminiUsage() {
  const [preferences, setPreferences] = useState<GeminiUsagePreferences>(() => getGeminiUsagePreferences());

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<GeminiUsagePreferences>).detail;
      setPreferences(detail ?? getGeminiUsagePreferences());
    };
    window.addEventListener(GEMINI_USAGE_EVENT, refresh);
    return () => window.removeEventListener(GEMINI_USAGE_EVENT, refresh);
  }, []);

  const setPreference = (key: keyof GeminiUsagePreferences, enabled: boolean) => {
    const next = { ...getGeminiUsagePreferences(), [key]: enabled };
    saveGeminiUsagePreferences(next);
    setPreferences(next);
  };

  return { preferences, setPreference };
}
