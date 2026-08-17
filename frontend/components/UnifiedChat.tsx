import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowDown, MessageSquare, Sparkles, Trash2 } from "lucide-react";
import { deactivateActiveRagOwner, getPageRecord, getRagSources, hasRemoteRagProvider, isHotRemoteRagProvider, searchDocuments, setActiveRagOwner } from "@/utils/ragOrama";
import type { AnswerReceipt, RetrievalResult } from "@/utils/ragTypes";
import { clearStoredCloudApiKey, describeImageWithCloud, getCloudErrorKind, getStoredCloudApiKey, isCloudProviderError, normalizeCloudError, storeCloudApiKey, streamCloudAgentAnswer, verifyCloudApiKey } from "@/utils/aiProvider";
import { describeImageWithHostedAi, streamHostedAgentAnswer } from "@/utils/openRouterProvider";
import { analyzeIndexedImage, createChatToolObservation, readBlobInventory, readBlobInventoryForAgent, readConnectedWallet, runChatTool, type ChatToolResult } from "@/utils/chatTools";
import { buildAdaptiveAgentSystemInstruction, isInternalGuideSource } from "@/utils/agentPolicy";
import { isE2EWalletConnected } from "@/utils/devMode";
import { buildAdaptiveGeminiHistory } from "@/utils/conversationMemory";
import { createChatMessage, type ChatMessage, useChatManager } from "@/hooks/useChatManager";
import { assignCitationIds, createAnswerReceipt, finalizeCitationGrounding } from "@/utils/answerReceipt";
import { AnswerReceiptPanel } from "@/components/chat/AnswerReceiptPanel";
import { ChatApiKeyModal } from "@/components/chat/ChatApiKeyModal";
import { ChatModelSelector } from "@/components/chat/ChatModelSelector";
import { ChatMessageItem } from "@/components/chat/ChatMessageItem";
import { ChatInputBar } from "@/components/chat/ChatInputBar";
import { EvidenceViewerPanel } from "@/components/chat/EvidenceViewerPanel";
import { useGeminiUsage } from "@/hooks/useGeminiUsage";
import type { HotRagProofSnapshot } from "@/utils/hotRagProof";
import { normalizeGeminiApiKey } from "@/utils/geminiApiKey";
import { useLanguage } from "@/i18n";
import type { BlobInventoryRefreshCapability } from "@/utils/agentCapabilities";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";
import { createShelbyWorkspaceKey } from "@/utils/shelbyNetwork";
import {
  DEFAULT_HOSTED_MODEL,
  getStoredChatProvider,
  getStoredHostedModel,
  setStoredChatProvider,
  setStoredHostedModel,
  type ChatProvider,
  type HostedAiModel,
} from "@/utils/hostedModelStorage";

const MOCK_ACCOUNT = { address: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" };

interface UnifiedChatProps {
  refreshBlobInventory?: BlobInventoryRefreshCapability;
}

export function UnifiedChat({ refreshBlobInventory }: UnifiedChatProps) {
  const { language, t } = useLanguage();
  const { network } = useShelbyNetwork();

  const cloudErrorMessage = (error: unknown) => {
    const normalized = normalizeCloudError(error);
    return normalized.message;
  };

  const { preferences: geminiUsage } = useGeminiUsage();
  const { account: realAccount } = useWallet();
  const account = isE2EWalletConnected() ? MOCK_ACCOUNT : realAccount;
  const ownerKey = createShelbyWorkspaceKey({ network, owner: account?.address.toString() ?? "disconnected" });
  const { query, setQuery, messages, setMessages, loading, status, setStatus, beginRequest, isRequestCurrent, finishRequest, abortRequest, clearMessages } = useChatManager(ownerKey);
  const [cloudApiKey, setCloudApiKey] = useState("");
  const [cloudKeyState, setCloudKeyState] = useState<"empty" | "checking" | "ready" | "limited" | "unverified" | "invalid">("empty");
  const [hostedModel, setHostedModel] = useState<HostedAiModel>(getStoredHostedModel);
  const [activeChatProvider, setActiveChatProvider] = useState<ChatProvider>(() => (
    getStoredCloudApiKey() ? getStoredChatProvider() : "qwen"
  ));
  const activeGeminiApiKey = activeChatProvider === "gemini"
    && cloudKeyState !== "empty"
    && cloudKeyState !== "invalid"
    ? getStoredCloudApiKey()
    : "";
  const keyCheckGenerationRef = useRef(0);
  const [activeVisualSource, setActiveVisualSource] = useState<RetrievalResult | null>(null);
  const [activeReceipt, setActiveReceipt] = useState<AnswerReceipt | null>(null);
  const [receiptBusyId, setReceiptBusyId] = useState<string | null>(null);
  const receiptAbortRef = useRef<AbortController | null>(null);
  const receiptGenerationRef = useRef(0);
  const activeOwnerKeyRef = useRef(ownerKey);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [visualPageText, setVisualPageText] = useState("");
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [showApiPanel, setShowApiPanel] = useState(false);
  const [ragReady, setRagReady] = useState(false);
  const [ragMode, setRagMode] = useState<"local" | "hot" | "none">("none");

  useEffect(() => () => receiptAbortRef.current?.abort(), []);

  useEffect(() => {
    const cancelReceipt = () => {
      receiptGenerationRef.current += 1;
      receiptAbortRef.current?.abort();
      receiptAbortRef.current = null;
      setReceiptBusyId(null);
      setActiveReceipt(null);
    };
    window.addEventListener("shelby:clear-chat", cancelReceipt);
    return () => window.removeEventListener("shelby:clear-chat", cancelReceipt);
  }, []);

  useLayoutEffect(() => {
    activeOwnerKeyRef.current = ownerKey;
    receiptGenerationRef.current += 1;
    receiptAbortRef.current?.abort();
    receiptAbortRef.current = null;
    setReceiptBusyId(null);
    setActiveReceipt(null);
    setActiveVisualSource(null);
  }, [ownerKey]);

  useEffect(() => {
    const openAiSettings = () => setShowApiPanel(true);
    window.addEventListener("shelby:open-ai-settings", openAiSettings);
    return () => window.removeEventListener("shelby:open-ai-settings", openAiSettings);
  }, []);

  useEffect(() => {
    const fillTourQuestion = (event: Event) => {
      const question = (event as CustomEvent<string>).detail;
      if (question) setQuery(question);
    };
    window.addEventListener("shelby:tour-question", fillTourQuestion);
    return () => window.removeEventListener("shelby:tour-question", fillTourQuestion);
  }, [setQuery]);

  useEffect(() => {
    const openLatestReceipt = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== "receipt") return;
      const receipt = [...messages].reverse().find((message) => message.receipt)?.receipt;
      if (receipt) setActiveReceipt(receipt);
      else setStatus(t("Create an Answer Receipt for a sourced answer first.", "Hãy tạo Phiếu kiểm chứng cho một câu trả lời có nguồn trước."));
    };
    window.addEventListener("shelby:tour-navigate", openLatestReceipt);
    return () => window.removeEventListener("shelby:tour-navigate", openLatestReceipt);
  }, [messages, setStatus, t]);

  useEffect(() => {
    const publishTourReadiness = () => window.dispatchEvent(new CustomEvent("shelby:tour-readiness", { detail: {
      hasSourcedAnswer: messages.some((message) => message.role === "ai" && Boolean(message.sources?.length)),
      hasAnswerReceipt: messages.some((message) => Boolean(message.receipt)),
    } }));
    publishTourReadiness();
    window.addEventListener("shelby:tour-readiness-request", publishTourReadiness);
    return () => window.removeEventListener("shelby:tour-readiness-request", publishTourReadiness);
  }, [messages]);

  useEffect(() => {
    const container = messagesScrollRef.current;
    if (!container || !autoFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: loading ? "auto" : "smooth" });
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, messages]);

  useEffect(() => {
    if (activeVisualSource) {
      const pageRec = getPageRecord(activeVisualSource.documentId, activeVisualSource.pageNumber);
      setVisualPageText(pageRec?.rawText || t("The full page text is not available in the local index.", "Không tìm thấy nội dung trang trong dữ liệu trên máy."));
    } else {
      setVisualPageText("");
    }
  }, [activeVisualSource, t]);

  useEffect(() => {
    const savedKey = getStoredCloudApiKey();
    if (savedKey) {
      setCloudApiKey(savedKey);
      setCloudKeyState("ready");
    }
  }, []);

  const selectChatProvider = (provider: ChatProvider) => {
    setActiveChatProvider(provider);
    setStoredChatProvider(provider);
  };

  const selectQwenModel = (model: HostedAiModel) => {
    setHostedModel(model);
    setStoredHostedModel(model);
    selectChatProvider("qwen");
  };

  useEffect(() => {
    const effectOwner = account ? ownerKey : "";
    const refresh = async () => {
      if (account) await setActiveRagOwner(ownerKey);
      const hasLocal = getRagSources().some((source) => source.status === "indexed");
      setRagReady(hasLocal || hasRemoteRagProvider());
      setRagMode(hasLocal ? "local" : isHotRemoteRagProvider() ? "hot" : "none");
    };
    void refresh();
    window.addEventListener("shelby:rag-state", refresh);
    return () => {
      window.removeEventListener("shelby:rag-state", refresh);
      if (effectOwner) void deactivateActiveRagOwner(effectOwner);
    };
  }, [account, ownerKey]);

  const saveCloudKey = async () => {
    const candidate = normalizeGeminiApiKey(cloudApiKey);
    if (!candidate) return;
    const previousStoredKey = getStoredCloudApiKey();
    const previousCloudKeyState = cloudKeyState;
    const checkGeneration = ++keyCheckGenerationRef.current;
    try {
      setCloudKeyState("checking");
      setStatus(t(`Checking key …${candidate.slice(-4)} with Gemini…`, `Đang kiểm tra key …${candidate.slice(-4)} với Gemini…`));
      const model = await verifyCloudApiKey(candidate);
      if (checkGeneration !== keyCheckGenerationRef.current) return;
      setCloudApiKey(candidate);
      storeCloudApiKey(candidate);
      setCloudKeyState("ready");
      selectChatProvider("gemini");
      setStatus(t(
        `✓ Key …${candidate.slice(-4)} was accepted; ${model} is available.`,
        `✓ Key …${candidate.slice(-4)} đã được Gemini chấp nhận; ${model} khả dụng.`,
      ));
    } catch (error) {
      if (checkGeneration !== keyCheckGenerationRef.current) return;
      const kind = getCloudErrorKind(error);
      const normalizedMessage = cloudErrorMessage(error);
      if (kind === "rate_limit") {
        setCloudApiKey(candidate);
        storeCloudApiKey(candidate);
        setCloudKeyState("limited");
        setStatus(t(
          `⚠ Key …${candidate.slice(-4)} was saved locally. ${normalizedMessage} You do not need to enter it again; wait, then select Try again.`,
          `⚠ Key …${candidate.slice(-4)} đã được lưu cục bộ. ${normalizedMessage} Bạn không cần nhập lại; hãy chờ rồi chọn Thử lại.`,
        ));
      } else if (kind === "invalid_key") {
        if (previousStoredKey && previousStoredKey !== candidate) {
          setCloudApiKey(previousStoredKey);
          setCloudKeyState(
            previousCloudKeyState === "ready"
              || previousCloudKeyState === "limited"
              || previousCloudKeyState === "unverified"
              ? previousCloudKeyState
              : "unverified",
          );
          setStatus(t(
            `✕ Unable to use key …${candidate.slice(-4)}: ${normalizedMessage} Previous key …${previousStoredKey.slice(-4)} remains active.`,
            `✕ Không thể dùng key …${candidate.slice(-4)}: ${normalizedMessage} Key trước đó …${previousStoredKey.slice(-4)} vẫn hoạt động.`,
          ));
        } else {
          clearStoredCloudApiKey();
          setCloudKeyState("invalid");
          setStatus(t(`✕ Unable to use key …${candidate.slice(-4)}: ${normalizedMessage}`, `✕ Không thể dùng key …${candidate.slice(-4)}: ${normalizedMessage}`));
        }
      } else {
        setCloudApiKey(candidate);
        storeCloudApiKey(candidate);
        setCloudKeyState("unverified");
        setStatus(t(
          `Key …${candidate.slice(-4)} was saved locally but could not be verified: ${normalizedMessage} Try again when the connection is available.`,
          `Key …${candidate.slice(-4)} đã được lưu cục bộ nhưng chưa thể kiểm tra: ${normalizedMessage} Hãy thử lại khi kết nối ổn định.`,
        ));
      }
    }
  };

  const handleAsk = async (presetQuestion?: string) => {
    const userQuery = (presetQuestion ?? query).trim();
    if (!userQuery || loading) return;
    const geminiApiKey = activeGeminiApiKey;
    const request = beginRequest();
    const { signal } = request;
    let pendingMessageId: string | undefined;
    let streamedText = "";
    let preserveStatus = false;
    const updateCurrentMessages = (updater: (previous: ChatMessage[]) => ChatMessage[]) => {
      setMessages((previous) => isRequestCurrent(request) ? updater(previous) : previous);
    };
    const assertRequestCurrent = () => {
      signal.throwIfAborted();
      if (!isRequestCurrent(request)) throw new DOMException("Chat request was superseded", "AbortError");
    };
    autoFollowRef.current = true;
    setShowJumpToLatest(false);
    setQuery("");
    updateCurrentMessages((previous) => [...previous, createChatMessage({ role: "user", text: userQuery })]);
    let hotReadProof: HotRagProofSnapshot | undefined;
    const captureHotReadProof = (event: Event) => {
      if (!isRequestCurrent(request)) return;
      const proof = (event as CustomEvent<HotRagProofSnapshot>).detail;
      if (proof?.format === "shelby-hot-rag-read-proof") hotReadProof = proof;
    };
    window.addEventListener("shelby:hot-rag-read", captureHotReadProof);
    try {
      setStatus("");
      if (account) await setActiveRagOwner(ownerKey);
      assertRequestCurrent();
      const recentImageMessage = [...messages.slice(-4)].reverse().find((message) => (
        message.role === "ai"
        && Boolean(message.imageUrls?.length)
        && Boolean(message.referencedSources?.length)
      ));
      const preferredImageSources = recentImageMessage?.referencedSources ?? [];
      if (!geminiUsage.chat) {
        updateCurrentMessages((previous) => [...previous, createChatMessage({ role: "ai", text: t(
          "AI chat is off. Enable it in Settings to ask general questions or use wallet and Shelby data tools.",
          "Trò chuyện với AI đang tắt. Hãy bật lại trong Cấu hình để hỏi kiến thức chung hoặc dùng dữ liệu ví và Shelby.",
        ) })]);
        return;
      }
      let relevantDocs: RetrievalResult[] = [];
      const latestPrompt = userQuery;
      const contents = [
        ...buildAdaptiveGeminiHistory(messages),
        { role: "user", parts: [{ text: latestPrompt }] }
      ];

      const pendingMessage = createChatMessage({ role: "ai", text: "", typing: true });
      pendingMessageId = pendingMessage.id;
      updateCurrentMessages((previous) => [...previous, pendingMessage]);
      let knowledgeSearchAttempted = false;
      let agentToolResult: ChatToolResult | null = null;
      const streamAgentAnswer = geminiApiKey ? streamCloudAgentAnswer : streamHostedAgentAnswer;
      await streamAgentAnswer(
        {
          contents,
          systemInstruction: buildAdaptiveAgentSystemInstruction({ activeNetwork: network }),
          activeNetwork: network,
          ...(geminiApiKey ? { cloudApiKey: geminiApiKey } : {}),
        },
        (chunk, mode = "append") => {
          if (signal.aborted || !isRequestCurrent(request)) return;
          streamedText = mode === "replace" ? chunk : streamedText + chunk;
          updateCurrentMessages((previous) => previous.map((message) => message.id === pendingMessageId ? { ...message, text: streamedText } : message));
        },
        {
          searchKnowledge: async ({ query: semanticQuery }, requestSignal) => {
            assertRequestCurrent();
            requestSignal?.throwIfAborted();
            knowledgeSearchAttempted = true;
            if (!ragReady) {
              return { found: false, evidence: [], message: "The user has no searchable knowledge base on this device or Shelby." };
            }
            let matches = await searchDocuments(semanticQuery, 12, requestSignal ?? signal);
            requestSignal?.throwIfAborted();
            assertRequestCurrent();
            const explicitlyRequestsGuide = /\b(?:agents?|skill)\.md\b/i.test(userQuery);
            matches = matches.filter((doc) => !doc.imageUrl && (explicitlyRequestsGuide || !isInternalGuideSource(doc.source) && !isInternalGuideSource(doc.displayName)));
            relevantDocs = assignCitationIds(matches.slice(0, 8));
            return {
              found: relevantDocs.length > 0,
              evidence: relevantDocs.map((doc) => ({
                citation: doc.citationId ?? "",
                page: doc.pageNumber,
                excerpt: doc.excerpt,
              })),
              message: relevantDocs.length
                ? "Answer naturally in the user's language. Use only the supplied citation ids for document-derived claims; do not mention filenames or retrieval steps."
                : "No sufficiently relevant passage was found. State this limitation in the user's language and do not guess document content.",
            };
          },
          getWalletBlobInventory: async (inventoryRequest, requestSignal) => {
            assertRequestCurrent();
            requestSignal?.throwIfAborted();
            const result = readBlobInventory(inventoryRequest.detail, { language, network });
            if (!agentToolResult?.imageUrls?.length) agentToolResult = result;
            const payload = readBlobInventoryForAgent(inventoryRequest, { network });
            const status = payload.status;
            if (status === "not_loaded") return { ...payload, ok: false, code: "inventory_unavailable" };
            return payload;
          },
          getConnectedWallet: async ({ detail }, requestSignal) => {
            assertRequestCurrent();
            const activeSignal = requestSignal ?? signal;
            activeSignal.throwIfAborted();
            const result = await readConnectedWallet(
              detail,
              account?.address.toString(),
              { language, network },
              activeSignal,
            );
            activeSignal.throwIfAborted();
            assertRequestCurrent();
            agentToolResult = result;
            const walletData = result.walletData;
            const requiredExactStrings = walletData?.detail === "address"
              ? walletData.address ? [walletData.address] : []
              : walletData?.detail === "account_info"
                ? [walletData.sequenceNumber, walletData.authenticationKey].filter((value): value is string => Boolean(value))
                : walletData?.formattedAmount ? [walletData.formattedAmount] : [];
            return {
              ok: true,
              kind: result.name,
              facts: result.text,
              wallet: walletData ?? { kind: "connected_wallet", detail, connected: false },
              ...(requiredExactStrings.length ? { answerContract: { requiredExactStrings } } : {}),
            };
          },
          inspectApplication: async ({ query: applicationQuery }, requestSignal) => {
            assertRequestCurrent();
            const activeSignal = requestSignal ?? signal;
            activeSignal.throwIfAborted();
            const toolContext = {
              preferredSources: preferredImageSources,
              language,
              network,
            };
            let result = await runChatTool(applicationQuery, account?.address.toString(), toolContext, activeSignal);
            if (
              (!result || result.name === "blob_inventory")
              && applicationQuery.trim() !== userQuery
            ) {
              result = await runChatTool(userQuery, account?.address.toString(), toolContext, activeSignal);
            }
            activeSignal.throwIfAborted();
            assertRequestCurrent();
            if (!result || ["blob_inventory", "wallet_address", "apt_balance", "shelbyusd_balance", "account_info"].includes(result.name)) {
              return { ok: false, code: "application_inspection_unavailable" };
            }
            agentToolResult = result;
            return {
              ok: true,
              kind: result.name,
              facts: result.text,
              referencedSources: result.referencedSources ?? [],
              previewCount: result.imageUrls?.length ?? 0,
              linkCount: result.links?.length ?? 0,
            };
          },
          analyzeIndexedImage: async ({ source, question }, requestSignal) => {
            assertRequestCurrent();
            const activeSignal = requestSignal ?? signal;
            activeSignal.throwIfAborted();
            const outcome = await analyzeIndexedImage(source, question, {
              preferredSources: preferredImageSources,
              language,
              provider: geminiApiKey ? "gemini" : "qwen",
              describeImage: (image, visualQuestion, visionSignal) => geminiApiKey
                ? describeImageWithCloud(image.url, image.displayName, geminiApiKey, visionSignal ?? activeSignal, undefined, visualQuestion)
                : describeImageWithHostedAi(image.url, image.displayName, language, visionSignal ?? activeSignal, undefined, visualQuestion),
            }, activeSignal);
            activeSignal.throwIfAborted();
            assertRequestCurrent();
            if (!outcome.ok) {
              return {
                ok: false,
                code: outcome.code,
                candidates: outcome.candidates,
                message: "Choose one indexed image source before visual analysis. Do not infer pixels from its filename.",
              };
            }
            agentToolResult = outcome.result;
            return {
              ok: true,
              kind: "image_analysis",
              facts: outcome.result.text,
              cached: outcome.cached,
              referencedSources: outcome.result.referencedSources ?? [],
              previewCount: outcome.result.imageUrls?.length ?? 0,
              linkCount: outcome.result.links?.length ?? 0,
            };
          },
          ...(refreshBlobInventory ? {
            refreshWalletBlobInventory: async (requestSignal?: AbortSignal) => {
              assertRequestCurrent();
              const activeSignal = requestSignal ?? signal;
              activeSignal.throwIfAborted();
              if (!refreshBlobInventory) {
                return { ok: false, code: "refresh_not_authorized_for_turn" };
              }
              const refreshed = await refreshBlobInventory("count", activeSignal);
              activeSignal.throwIfAborted();
              assertRequestCurrent();
              if (refreshed.status !== "refreshed") {
                return {
                  ok: false,
                  code: refreshed.code ?? "shelby_refresh_failed",
                  message: "The live Shelby refresh did not complete. Do not present cached data as current.",
                };
              }
              return {
                ok: true,
                refreshedAt: refreshed.fetchedAt,
                source: refreshed.source,
                message: "Refresh completed. Call get_wallet_blob_inventory before answering.",
              };
            },
          } : {}),
        },
        signal,
      );
      assertRequestCurrent();
      const finalAgentToolResult = agentToolResult as ChatToolResult | null;
      const hasImagePreview = Boolean(finalAgentToolResult?.imageUrls?.length);
      const shouldGroundKnowledgeAnswer = knowledgeSearchAttempted
        && !hasImagePreview
        && (relevantDocs.length > 0 || !finalAgentToolResult);
      const grounding = finalizeCitationGrounding(
        streamedText,
        relevantDocs,
        t(
          "I found potentially relevant passages, but the generated answer did not cite them reliably. I will not present it as a verified document answer; please try asking again.",
          "Tôi tìm thấy các đoạn có thể liên quan, nhưng câu trả lời vừa tạo không trích dẫn chúng đáng tin cậy. Tôi sẽ không trình bày đó là câu trả lời đã kiểm chứng; bạn hãy thử hỏi lại.",
        ),
        {
          retrievalAttempted: shouldGroundKnowledgeAnswer,
          noEvidenceMessage: t(
            "I searched your knowledge base but could not find evidence relevant enough to answer. Try naming the file or asking with more specific terms.",
            "Tôi đã tìm trong kho dữ liệu nhưng chưa thấy bằng chứng đủ liên quan để trả lời. Hãy thử nêu tên tệp hoặc hỏi cụ thể hơn.",
          ),
        },
      );
      const citedSources = grounding.sources;
      const citedLinks = citedSources.flatMap((doc) => doc.link ? [{
        label: t(
          `${doc.displayName}${doc.pageNumber ? ` · page ${doc.pageNumber}` : ""}`,
          `${doc.displayName}${doc.pageNumber ? ` · trang ${doc.pageNumber}` : ""}`,
        ),
        url: doc.link,
      }] : []);
      updateCurrentMessages((previous) => previous.map((message) => message.id === pendingMessageId ? {
        ...message,
        text: grounding.answer,
        typing: false,
        interrupted: undefined,
        sources: citedSources,
        links: citedLinks.slice(0, 4),
        imageUrls: finalAgentToolResult?.imageUrls,
        referencedSources: finalAgentToolResult?.referencedSources,
        hotReadProof,
        tool: finalAgentToolResult?.name,
        toolObservation: createChatToolObservation(finalAgentToolResult),
      } : message));
    } catch (error) {
      if (!isRequestCurrent(request)) return;
      if (signal.aborted) {
        if (pendingMessageId) {
          updateCurrentMessages((previous) => previous.map((message) => message.id === pendingMessageId ? { ...message, typing: false, interrupted: true, text: message.text || t("Response stopped.", "Đã dừng phản hồi.") } : message));
        } else {
          updateCurrentMessages((previous) => [...previous, createChatMessage({ role: "ai", text: t("Request stopped.", "Đã dừng yêu cầu."), interrupted: true })]);
        }
      } else {
        const cloudProviderError = isCloudProviderError(error);
        const cloudErrorKind = cloudProviderError ? error.kind : "other";
        const limitedKeyIsStillActive = Boolean(geminiApiKey) && getStoredCloudApiKey() === geminiApiKey;
        if (cloudProviderError && cloudErrorKind === "rate_limit" && limitedKeyIsStillActive) {
          setCloudKeyState("limited");
          setShowApiPanel(true);
          setStatus(t(
            `Gemini temporarily limited the request for key …${geminiApiKey.slice(-4)}. The key remains saved locally; wait, then select Try again.`,
            `Gemini đang tạm giới hạn yêu cầu của key …${geminiApiKey.slice(-4)}. Key vẫn được lưu cục bộ; hãy chờ rồi chọn Thử lại.`,
          ));
          preserveStatus = true;
        }
        const errorText = `❌ ${pendingMessageId && cloudProviderError
          ? cloudErrorMessage(error)
          : error instanceof Error
            ? error.message
            : String(error)}`;
        if (pendingMessageId) {
          updateCurrentMessages((previous) => previous.map((message) => message.id === pendingMessageId ? { ...message, typing: false, interrupted: Boolean(message.text), text: message.text || errorText } : message));
        } else {
          updateCurrentMessages((previous) => [...previous, createChatMessage({ role: "ai", text: errorText })]);
        }
      }
    } finally {
      window.removeEventListener("shelby:hot-rag-read", captureHotReadProof);
      finishRequest(request, { clearStatus: !preserveStatus });
    }
  };

  const handleAnswerReceipt = async (messageId: string) => {
    const messageIndex = messages.findIndex((item) => item.id === messageId);
    const message = messages[messageIndex];
    if (!message?.sources?.length || !account) return;
    if (message.receipt) {
      setActiveReceipt(message.receipt);
      return;
    }
    const question = [...messages.slice(0, messageIndex)].reverse().find((item) => item.role === "user")?.text;
    if (!question) return;
    receiptAbortRef.current?.abort();
    const controller = new AbortController();
    const receiptOwnerKey = ownerKey;
    const generation = receiptGenerationRef.current + 1;
    receiptGenerationRef.current = generation;
    receiptAbortRef.current = controller;
    const isReceiptCurrent = () => (
      receiptAbortRef.current === controller
      && receiptGenerationRef.current === generation
      && activeOwnerKeyRef.current === receiptOwnerKey
    );
    setReceiptBusyId(messageId);
    setStatus(t("Creating Answer Receipt…", "Đang tạo Phiếu kiểm chứng…"));
    try {
      const receipt = await createAnswerReceipt({
        network,
        wallet: account.address.toString(),
        question,
        answer: message.text,
        sources: message.sources,
        signal: controller.signal,
        onProgress: (progress) => { if (isReceiptCurrent()) setStatus(progress); },
      });
      if (!isReceiptCurrent() || !messagesRef.current.some((item) => item.id === messageId)) return;
      setMessages((previous) => isReceiptCurrent() ? previous.map((item) => item.id === messageId ? { ...item, receipt } : item) : previous);
      setActiveVisualSource(null);
      setActiveReceipt(receipt);
      setStatus(t("Answer Receipt is ready.", "Phiếu kiểm chứng đã sẵn sàng."));
    } catch (error) {
      if (isReceiptCurrent() && !controller.signal.aborted) setStatus(t(
        `Unable to create receipt: ${error instanceof Error ? error.message : String(error)}`,
        `Không thể tạo phiếu: ${error instanceof Error ? error.message : String(error)}`,
      ));
    } finally {
      const wasCurrent = isReceiptCurrent();
      if (wasCurrent) setReceiptBusyId(null);
    }
  };

  const handleClearChat = () => {
    receiptGenerationRef.current += 1;
    receiptAbortRef.current?.abort();
    receiptAbortRef.current = null;
    setReceiptBusyId(null);
    setActiveReceipt(null);
    clearMessages();
  };

  const handleMessagesScroll = () => {
    const container = messagesScrollRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const nearBottom = distanceFromBottom < 72;
    autoFollowRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom && messages.length > 0);
  };

  const jumpToLatest = () => {
    const container = messagesScrollRef.current;
    if (!container) return;
    autoFollowRef.current = true;
    setShowJumpToLatest(false);
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  };

  const SUGGESTIONS = [
    t("Summarize the indexed documents", "Tóm tắt nội dung tài liệu đã nạp"),
    t("How many blobs does this wallet have on Shelby?", "Ví này có bao nhiêu blob trên Shelby?"),
    t("List the main topics in my documents", "Liệt kê các chủ đề chính trong tài liệu"),
  ];
  const visibleSuggestions = !geminiUsage.chat ? [
    t("How many blobs does this wallet have on Shelby?", "Ví này có bao nhiêu blob trên Shelby?"),
    t("Which wallet is connected?", "Ví đang kết nối là gì?"),
    t("Which PDF books do I have?", "Tôi có sách PDF nào?"),
  ] : ragReady ? SUGGESTIONS : [
    t("How many blobs does this wallet have on Shelby?", "Ví này có bao nhiêu blob trên Shelby?"),
    t("Which wallet is connected?", "Ví đang kết nối là gì?"),
    t("What is Shelby Protocol used for?", "Shelby Protocol dùng để làm gì?"),
  ];

  return (
    <Card className="glass-panel border-white/40 dark:border-white/10 mt-0 flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] shadow-sm">
      <CardContent className="flex h-full min-h-0 flex-1 flex-col p-0">
        {/* Compact header */}
        <div className="flex min-h-[64px] items-center justify-between gap-3 border-b border-black/5 px-5 dark:border-white/5 bg-white/40 dark:bg-black/20">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[#172019] text-[#c5fb7e] dark:bg-lime-300 dark:text-slate-950">
              <MessageSquare className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-extrabold tracking-[-0.02em] text-[#101512] dark:text-white">
                {t("Knowledge Assistant", "Trợ lý tri thức")}
              </h3>
              <p className="text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                {t("Natural answers with sources when needed", "Trả lời tự nhiên, kèm nguồn khi cần")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Inline status chips */}
            <div className="hidden items-center gap-3 sm:flex">
              <span
                className={ragReady ? "status-chip ok" : "status-chip"}
                title={ragMode === "hot" ? t("Fetch only relevant parts from Shelby", "Chỉ đọc các phần liên quan từ Shelby") : t("Reference data", "Dữ liệu tham khảo")}
              >
                <span className={`status-dot ${ragReady ? "green" : "gray"}`} />{" "}
                {ragMode === "hot" ? t("Reading from Shelby", "Đọc từ Shelby") : ragReady ? t("Data ready", "Đã có dữ liệu") : t("No data yet", "Chưa có dữ liệu")}
              </span>
              <span
                className={geminiUsage.chat ? "status-chip ok" : "status-chip"}
                title={geminiUsage.chat
                  ? activeChatProvider === "gemini"
                    ? t("Chat uses your saved Gemini key; Gemini 2.5 Flash is preferred", "Chat dùng Gemini key đã lưu; ưu tiên Gemini 2.5 Flash")
                    : hostedModel === "qwen/qwen3.8-max-free"
                      ? t("Chat uses Qwen 3.8 Flash", "Chat dùng Qwen 3.8 Flash")
                      : t("Chat uses Qwen 3.7 Flash", "Chat dùng Qwen 3.7 Flash")
                  : t("AI chat is off in Settings", "Chat AI đang tắt trong Cấu hình")}
              >
                <span className={`status-dot ${geminiUsage.chat ? "green" : "gray"}`} />
                {geminiUsage.chat
                  ? activeChatProvider === "gemini"
                    ? "Gemini"
                    : hostedModel === "qwen/qwen3.8-max-free"
                      ? "Qwen 3.8 Flash"
                      : "Qwen 3.7 Flash"
                  : t("Chat off", "Chat đã tắt")}
              </span>
            </div>
            {messages.length > 0 && (
              <button
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white transition-colors p-1"
                onClick={handleClearChat}
                title={t("Clear chat", "Xoá chat")}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <ChatModelSelector
          selectedModel={activeChatProvider === "gemini" ? "gemini" : hostedModel}
          cloudKeyState={cloudKeyState}
          geminiPanelOpen={showApiPanel}
          disabled={loading}
          onSelect={(model) => {
            if (model === "gemini") {
              setShowApiPanel(true);
              if (cloudKeyState === "ready" && getStoredCloudApiKey()) selectChatProvider("gemini");
              return;
            }
            selectQwenModel(model);
            setShowApiPanel(false);
          }}
        />

        {/* API Key Modal / Collapsible */}
        {!geminiUsage.chat && !showApiPanel && (
          <button
            onClick={() => window.dispatchEvent(new Event("shelby:open-rag-config"))}
            className="mx-4 mt-3 flex items-center justify-between rounded-xl bg-emerald-50/80 px-3 py-2 text-left transition-colors hover:bg-emerald-50 dark:bg-emerald-300/[0.045] dark:hover:bg-emerald-300/[0.065]"
          >
            <span className="flex items-center gap-2 text-[12px] font-semibold text-emerald-800 dark:text-emerald-200">
              <MessageSquare className="h-3.5 w-3.5" />
              {t("AI chat is off to save quota", "Chat AI đang tắt để tiết kiệm quota")}
            </span>
            <span className="text-[11px] font-bold text-emerald-700 dark:text-lime-300">
              {t("Open Settings", "Mở Cấu hình")} →
            </span>
          </button>
        )}

        <ChatApiKeyModal
          show={showApiPanel}
          onClose={() => setShowApiPanel(false)}
          cloudApiKey={cloudApiKey}
          onKeyChange={(nextKey) => {
            keyCheckGenerationRef.current += 1;
            setCloudApiKey(nextKey);
            setCloudKeyState((current) => {
              if (!getStoredCloudApiKey()) return "empty";
              return current === "ready" || current === "limited" || current === "unverified"
                ? current
                : "unverified";
            });
            setStatus("");
          }}
          cloudKeyState={cloudKeyState}
          onSave={saveCloudKey}
          onRemove={() => {
            clearStoredCloudApiKey();
            setCloudApiKey("");
            setCloudKeyState("empty");
            selectQwenModel(DEFAULT_HOSTED_MODEL);
            setShowApiPanel(false);
            setStatus(t("API key removed.", "Đã xoá API key."));
          }}
        />

        {/* Status message */}
        {status && !loading && (
          <p
            className="mx-4 mt-3 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500 dark:border-white/[0.04] dark:bg-white/[0.02] dark:text-slate-400"
            role="status"
            aria-live="polite"
          >
            {status}
          </p>
        )}

        {/* Chat messages area */}
        <div className="relative flex min-h-0 flex-1 gap-3 overflow-hidden px-3 pb-2 pt-3 sm:px-5 sm:pt-5">
          <div
            data-testid="chat-scroll"
            ref={messagesScrollRef}
            onScroll={handleMessagesScroll}
            className="custom-scrollbar flex min-h-0 min-w-0 flex-1 flex-col space-y-4 overflow-y-auto overscroll-contain rounded-2xl bg-transparent p-2 sm:p-2"
          >
            {/* Empty state with suggestions */}
            {messages.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center pb-16 text-center pt-8">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#172019] text-[#c5fb7e] shadow-[0_10px_30px_rgba(23,32,25,.12)] dark:bg-lime-300 dark:text-[#101713]">
                  <Sparkles className="h-5 w-5" />
                </div>
                <p className="mb-1.5 text-[18px] font-bold tracking-[-0.025em] text-[#27302a] dark:text-slate-200">
                  {!geminiUsage.chat ? t("Data tools are still available", "Công cụ dữ liệu vẫn sẵn sàng") : ragReady ? t("Ask anything about your documents", "Hỏi bất cứ điều gì về tài liệu") : t("You can still ask general questions", "Bạn vẫn có thể hỏi kiến thức chung")}
                </p>
                <p className="mb-5 max-w-md text-[13px] leading-5 text-slate-500 dark:text-slate-400">
                  {!geminiUsage.chat
                    ? t("AI chat is off, but you can still inspect the wallet, count blobs, and browse Shelby.", "Chat AI đang tắt, nhưng bạn vẫn có thể kiểm tra ví, đếm blob và xem kho Shelby.")
                    : ragReady
                      ? t("Ask naturally. AI consults your knowledge base only when needed and attaches sources you can inspect.", "Bạn cứ hỏi tự nhiên. AI chỉ dùng kho dữ liệu khi câu hỏi thật sự cần và sẽ đính kèm nguồn để bạn kiểm tra.")
                      : t("General questions work now; document questions become available after you create a RAG.", "Bạn có thể hỏi kiến thức chung ngay; câu hỏi về tài liệu sẽ khả dụng sau khi tạo RAG.")}
                </p>
                <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold text-slate-400" aria-label={t("Knowledge preparation flow", "Luồng tạo kho dữ liệu")}>
                  <span>{t("Data", "Dữ liệu")}</span>
                  <span className="text-slate-300 dark:text-slate-700">→</span>
                  <span>{t("Prepare on device", "Chuẩn bị trên máy")}</span>
                  <span className="text-slate-300 dark:text-slate-700">→</span>
                  <span className={ragReady ? "text-emerald-700 dark:text-lime-300" : ""}>{t("Ready to search", "Sẵn sàng tra cứu")}</span>
                </div>
                <div className="grid w-full max-w-md gap-2 sm:grid-cols-3">
                  {visibleSuggestions.map((suggestion) => (
                    <button key={suggestion} className="suggestion-pill text-left" onClick={() => void handleAsk(suggestion)}>
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <ChatMessageItem
                key={message.id}
                message={message}
                onOpenSourceProof={(source) => setActiveVisualSource(source)}
                onRequestAnswerReceipt={(id) => void handleAnswerReceipt(id)}
                receiptBusyId={receiptBusyId}
              />
            ))}

            {loading && !messages.some((message) => message.typing) && (
              <div
                className="mr-auto w-full max-w-[92%] rounded-2xl rounded-tl-sm border border-[#e4e8e1] bg-white/75 px-4 py-3.5 text-[13px] text-slate-500 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-900/50 dark:text-slate-400"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-center gap-3">
                  <span className="flex gap-1" aria-hidden="true">
                    <span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  </span>
                  <span>{t("Composing an answer", "Đang soạn câu trả lời")}</span>
                </div>
              </div>
            )}
          </div>

          {showJumpToLatest && (
            <button
              onClick={jumpToLatest}
              className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-bold text-slate-700 shadow-lg transition hover:-translate-y-0.5 dark:border-white/10 dark:bg-slate-950 dark:text-white"
            >
              <ArrowDown className="h-3.5 w-3.5" /> {t("Latest message", "Tin mới nhất")}
            </button>
          )}

          {/* Verifiable RAG proof panel */}
          <EvidenceViewerPanel
            source={activeVisualSource}
            onClose={() => setActiveVisualSource(null)}
            visualPageText={visualPageText}
          />

          {/* Answer Receipt audit modal */}
          {activeReceipt && <AnswerReceiptPanel receipt={activeReceipt} onClose={() => setActiveReceipt(null)} />}
        </div>

        {/* Input bar */}
        <ChatInputBar
          query={query}
          onQueryChange={setQuery}
          onSend={() => void handleAsk()}
          onAbort={abortRequest}
          loading={loading}
          placeholder={
            !geminiUsage.chat
              ? t("Use wallet and Shelby data tools…", "Dùng công cụ ví và kho Shelby…")
              : ragReady
                ? t("Ask about your indexed data…", "Hỏi về dữ liệu đã nạp…")
                : t("Ask general knowledge or use a data tool…", "Hỏi kiến thức chung hoặc dùng công cụ…")
          }
        />
      </CardContent>
    </Card>
  );
}
