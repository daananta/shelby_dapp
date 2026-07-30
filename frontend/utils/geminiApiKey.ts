/**
 * Treat Gemini API keys as opaque credentials.
 *
 * Google currently issues both legacy `AIza…` standard keys and newer `AQ…`
 * authorization keys. Do not validate a prefix or a fixed length here because
 * either can change without changing the Gemini request contract.
 */
export function normalizeGeminiApiKey(value: string | null | undefined): string {
  return value?.trim() ?? "";
}
