import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_PROVIDER_STORAGE_KEY,
  DEFAULT_CHAT_PROVIDER,
  DEFAULT_HOSTED_MODEL,
  HOSTED_MODEL_STORAGE_KEY,
  getStoredChatProvider,
  getStoredHostedModel,
  setStoredChatProvider,
  setStoredHostedModel,
} from "@/utils/hostedModelStorage";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}

describe("chat model preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", createStorage());
    vi.stubGlobal("sessionStorage", createStorage());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults new sessions to Qwen 3.7 Flash", () => {
    expect(DEFAULT_HOSTED_MODEL).toBe("qwen/qwen3.7-flash");
    expect(DEFAULT_CHAT_PROVIDER).toBe("qwen");
    expect(getStoredHostedModel()).toBe("qwen/qwen3.7-flash");
    expect(getStoredChatProvider()).toBe("qwen");
  });

  it("persists explicit Qwen and provider choices in their intended scopes", () => {
    setStoredHostedModel("qwen/qwen3.8-max-free");
    setStoredChatProvider("gemini");

    expect(localStorage.getItem(HOSTED_MODEL_STORAGE_KEY)).toBe("qwen/qwen3.8-max-free");
    expect(sessionStorage.getItem(CHAT_PROVIDER_STORAGE_KEY)).toBe("gemini");
    expect(getStoredHostedModel()).toBe("qwen/qwen3.8-max-free");
    expect(getStoredChatProvider()).toBe("gemini");
  });

  it("keeps the legacy Qwen 3.8 alias compatible with the free upstream model", () => {
    localStorage.setItem(HOSTED_MODEL_STORAGE_KEY, "qwen/qwen3.8-flash");
    expect(getStoredHostedModel()).toBe("qwen/qwen3.8-max-free");
  });
});
