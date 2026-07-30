import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GEMINI_USAGE, GEMINI_USAGE_EVENT, GEMINI_USAGE_STORAGE_KEY, getGeminiUsagePreferences, saveGeminiUsagePreferences } from "@/utils/geminiUsage";

describe("Gemini usage preferences", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("CustomEvent", class<T> extends Event {
      detail: T;
      constructor(type: string, init: CustomEventInit<T> = {}) {
        super(type);
        this.detail = init.detail as T;
      }
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults to chat only so indexing does not silently spend the key", () => {
    expect(getGeminiUsagePreferences()).toEqual(DEFAULT_GEMINI_USAGE);
  });

  it("persists explicit permissions and notifies the current tab", () => {
    const listener = vi.fn();
    window.addEventListener(GEMINI_USAGE_EVENT, listener);
    const preferences = { chat: false, contentAnalysis: true, semanticSearch: true };
    saveGeminiUsagePreferences(preferences);
    expect(JSON.parse(localStorage.getItem(GEMINI_USAGE_STORAGE_KEY)!)).toEqual(preferences);
    expect(getGeminiUsagePreferences()).toEqual(preferences);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(GEMINI_USAGE_EVENT, listener);
  });
});
