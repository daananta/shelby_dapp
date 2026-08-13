import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatToolObservation, ChatToolResult } from "@/utils/chatTools";
import type { AnswerReceipt, RetrievalResult } from "@/utils/ragTypes";
import type { HotRagProofSnapshot } from "@/utils/hotRagProof";
import { localize } from "@/i18n";
import { isSupportedShelbyNetwork } from "@/utils/shelbyNetwork";

export interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  imageUrls?: string[];
  links?: { label: string; url: string }[];
  sources?: RetrievalResult[];
  tool?: ChatToolResult["name"];
  toolObservation?: ChatToolObservation;
  referencedSources?: string[];
  typing?: boolean;
  receipt?: AnswerReceipt;
  hotReadProof?: HotRagProofSnapshot;
  interrupted?: boolean;
}

const CHAT_STORAGE = "shelby-rag-explorer.chat-v1";
const CHAT_TOOL_NAMES = new Set<ChatToolResult["name"]>([
  "wallet_address",
  "apt_balance",
  "shelbyusd_balance",
  "account_info",
  "blob_inventory",
  "document_inventory",
  "document_lookup",
  "show_images",
  "identity",
  "calculator",
]);

let fallbackMessageSequence = 0;

function nextMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  fallbackMessageSequence += 1;
  return `chat-${Date.now().toString(36)}-${fallbackMessageSequence.toString(36)}`;
}

export function createChatMessage(message: Omit<ChatMessage, "id"> & { id?: string }): ChatMessage {
  const id = typeof message.id === "string" && message.id.trim() ? message.id : nextMessageId();
  return { ...message, id };
}

function isChatMessage(value: unknown): value is Partial<ChatMessage> & Pick<ChatMessage, "role" | "text"> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatMessage>;
  return (candidate.role === "user" || candidate.role === "ai") && typeof candidate.text === "string";
}

function normalizeStringList(value: unknown, limit: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter((item): item is string => typeof item === "string").slice(0, limit);
  return normalized.length ? normalized : undefined;
}

function normalizeLinks(value: unknown): ChatMessage["links"] {
  if (!Array.isArray(value)) return undefined;
  const links = value
    .filter((item): item is { label: string; url: string } => (
      Boolean(item)
      && typeof item === "object"
      && typeof (item as { label?: unknown }).label === "string"
      && typeof (item as { url?: unknown }).url === "string"
    ))
    .slice(0, 8)
    .map(({ label, url }) => ({ label, url }));
  return links.length ? links : undefined;
}

function normalizeChatTool(value: unknown): ChatToolResult["name"] | undefined {
  return typeof value === "string" && CHAT_TOOL_NAMES.has(value as ChatToolResult["name"])
    ? value as ChatToolResult["name"]
    : undefined;
}

function normalizeToolObservation(value: unknown): ChatToolObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ChatToolObservation>;
  if (
    candidate.version !== 1
    || candidate.kind !== "blob_inventory"
    || (
      candidate.status !== "verified"
      && candidate.status !== "stale"
      && candidate.status !== "not_loaded"
    )
    || typeof candidate.observedAt !== "number"
    || !Number.isFinite(candidate.observedAt)
  ) return undefined;
  const fetchedAt = typeof candidate.fetchedAt === "number" && Number.isFinite(candidate.fetchedAt)
    ? candidate.fetchedAt
    : undefined;
  return {
    version: 1,
    kind: "blob_inventory",
    status: candidate.status,
    observedAt: candidate.observedAt,
    fetchedAt,
    network: isSupportedShelbyNetwork(candidate.network) ? candidate.network : undefined,
  };
}

export function normalizeStoredChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isChatMessage)
    .slice(-20)
    .map((message) => {
      const tool = message.role === "ai" ? normalizeChatTool(message.tool) : undefined;
      return createChatMessage({
        id: typeof message.id === "string" ? message.id : undefined,
        role: message.role,
        text: message.text || (message.typing
          ? localize("The response was interrupted when the page closed.", "Phản hồi bị gián đoạn khi đóng trang.")
          : ""),
        imageUrls: message.role === "ai" ? normalizeStringList(message.imageUrls, 12) : undefined,
        links: message.role === "ai" ? normalizeLinks(message.links) : undefined,
        sources: message.role === "ai" && Array.isArray(message.sources)
          ? message.sources.filter((source): source is RetrievalResult => Boolean(source) && typeof source === "object").slice(0, 12)
          : undefined,
        tool,
        toolObservation: tool === "blob_inventory" ? normalizeToolObservation(message.toolObservation) : undefined,
        referencedSources: message.role === "ai" ? normalizeStringList(message.referencedSources, 20) : undefined,
        receipt: message.role === "ai" && message.receipt && typeof message.receipt === "object"
          ? message.receipt
          : undefined,
        hotReadProof: message.role === "ai" && message.hotReadProof && typeof message.hotReadProof === "object"
          ? message.hotReadProof
          : undefined,
        interrupted: message.interrupted === true || message.typing === true ? true : undefined,
      });
    });
}

export function prepareMessagesForPersistence(messages: ChatMessage[]): ChatMessage[] {
  return messages.slice(-20).map((message) => {
    const { typing, ...stable } = message;
    if (!typing) return stable;
    return {
      ...stable,
      text: stable.text || localize("The response was interrupted when the page closed.", "Phản hồi bị gián đoạn khi đóng trang."),
      interrupted: true,
    };
  });
}

export interface ChatRequestContext {
  controller: AbortController;
  signal: AbortSignal;
  ownerKey: string;
  generation: number;
}

export function useChatManager(ownerKey: string) {
  const storageKey = `${CHAT_STORAGE}:${ownerKey || "disconnected"}`;
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [loadedStorageKey, setLoadedStorageKey] = useState("");
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const activeOwnerKeyRef = useRef(ownerKey);
  const activeStorageKeyRef = useRef(storageKey);
  const latestMessagesRef = useRef<ChatMessage[]>([]);
  latestMessagesRef.current = messages;

  const persistNow = useCallback(() => {
    if (loadedStorageKey !== storageKey) return;
    const stableMessages = prepareMessagesForPersistence(latestMessagesRef.current);
    try {
      if (stableMessages.length) localStorage.setItem(storageKey, JSON.stringify(stableMessages));
      else localStorage.removeItem(storageKey);
    } catch {
      // Chat persistence is best-effort; a storage quota failure must not crash chat.
    }
  }, [loadedStorageKey, storageKey]);

  useLayoutEffect(() => {
    const previousStorageKey = activeStorageKeyRef.current;
    if (previousStorageKey !== storageKey) {
      const previousMessages = prepareMessagesForPersistence(latestMessagesRef.current);
      try {
        if (previousMessages.length) localStorage.setItem(previousStorageKey, JSON.stringify(previousMessages));
        else localStorage.removeItem(previousStorageKey);
      } catch {
        // Switching wallets must continue even when local persistence is unavailable.
      }
    }
    activeStorageKeyRef.current = storageKey;
    requestGenerationRef.current += 1;
    activeOwnerKeyRef.current = ownerKey;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setLoading(false);
    setStatus("");
    setQuery("");
    try {
      const saved = localStorage.getItem(storageKey);
      const nextMessages = normalizeStoredChatMessages(saved ? JSON.parse(saved) : []);
      latestMessagesRef.current = nextMessages;
      setMessages(nextMessages);
    } catch {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Ignore storage access errors and start with an empty conversation.
      }
      latestMessagesRef.current = [];
      setMessages([]);
    }
    setLoadedStorageKey(storageKey);
  }, [ownerKey, storageKey]);

  useEffect(() => {
    const clearCurrentChat = () => {
      requestGenerationRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      setLoading(false);
      setStatus("");
      try {
        localStorage.removeItem(activeStorageKeyRef.current);
      } catch {
        // Clearing in-memory chat must still work when storage is unavailable.
      }
      latestMessagesRef.current = [];
      setMessages([]);
    };
    window.addEventListener("shelby:clear-chat", clearCurrentChat);
    return () => window.removeEventListener("shelby:clear-chat", clearCurrentChat);
  }, []);

  useEffect(() => {
    if (loadedStorageKey !== storageKey || messages.some((message) => message.typing)) return;
    const timeout = window.setTimeout(persistNow, 250);
    return () => window.clearTimeout(timeout);
  }, [loadedStorageKey, messages, persistNow, storageKey]);

  useEffect(() => {
    const onPageHide = () => persistNow();
    const onVisibilityChange = () => { if (document.visibilityState === "hidden") persistNow(); };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [persistNow]);

  useEffect(() => () => requestAbortRef.current?.abort(), []);

  const beginRequest = (): ChatRequestContext => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    requestAbortRef.current = controller;
    setLoading(true);
    return { controller, signal: controller.signal, ownerKey: activeOwnerKeyRef.current, generation };
  };

  const isRequestCurrent = (request: ChatRequestContext) => (
    requestAbortRef.current === request.controller
    && requestGenerationRef.current === request.generation
    && activeOwnerKeyRef.current === request.ownerKey
  );

  const finishRequest = (request: ChatRequestContext, options: { clearStatus?: boolean } = {}) => {
    if (!isRequestCurrent(request)) return;
    // Keep the completed controller as the current generation until another
    // request or wallet replaces it. React may apply a queued functional state
    // update after this function returns; clearing the ref here would discard
    // the final answer even though it belongs to this request.
    setLoading(false);
    if (options.clearStatus !== false) setStatus("");
  };

  const abortRequest = () => {
    requestAbortRef.current?.abort();
    setStatus(localize("Stopping the request…", "Đang dừng yêu cầu…"));
  };

  const clearMessages = () => {
    requestGenerationRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setLoading(false);
    setStatus("");
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Clearing in-memory chat should still work when storage is unavailable.
    }
    latestMessagesRef.current = [];
    setMessages([]);
  };

  return { storageKey, query, setQuery, messages, setMessages, loading, status, setStatus, requestAbortRef, beginRequest, isRequestCurrent, finishRequest, abortRequest, clearMessages };
}
