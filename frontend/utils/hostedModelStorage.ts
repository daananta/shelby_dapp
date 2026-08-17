export const HOSTED_MODEL_STORAGE_KEY = "shelby-rag-explorer.hosted-model";
export const CHAT_PROVIDER_STORAGE_KEY = "shelby-rag-explorer.chat-provider";
export const DEFAULT_HOSTED_MODEL = "qwen/qwen3.7-flash";
export const DEFAULT_CHAT_PROVIDER = "qwen";

export type HostedAiModel = "qwen/qwen3.8-max-free" | "qwen/qwen3.7-flash";
export type ChatProvider = "qwen" | "gemini";
export type ChatModelSelection = HostedAiModel | "gemini";

export function getStoredHostedModel(): HostedAiModel {
  if (typeof window === "undefined") return DEFAULT_HOSTED_MODEL;
  try {
    const stored = localStorage.getItem(HOSTED_MODEL_STORAGE_KEY);
    if (stored === "qwen/qwen3.7-flash" || stored === "qwen/qwen3.8-max-free") {
      return stored;
    }
    // Backward compatibility for temporary alias
    if (stored === "qwen/qwen3.8-flash") {
      return "qwen/qwen3.8-max-free";
    }
  } catch {
    // Ignore localStorage errors
  }
  return DEFAULT_HOSTED_MODEL;
}

export function setStoredHostedModel(model: HostedAiModel): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HOSTED_MODEL_STORAGE_KEY, model);
  } catch {
    // Ignore localStorage errors
  }
}

export function getStoredChatProvider(): ChatProvider {
  if (typeof window === "undefined") return DEFAULT_CHAT_PROVIDER;
  try {
    return sessionStorage.getItem(CHAT_PROVIDER_STORAGE_KEY) === "gemini" ? "gemini" : DEFAULT_CHAT_PROVIDER;
  } catch {
    return DEFAULT_CHAT_PROVIDER;
  }
}

export function setStoredChatProvider(provider: ChatProvider): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(CHAT_PROVIDER_STORAGE_KEY, provider);
  } catch {
    // Ignore sessionStorage errors
  }
}
