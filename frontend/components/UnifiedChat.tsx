import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowDown, Bookmark, ChevronDown, Cloud, Database, FileCheck2, Fingerprint, KeyRound, MessageSquare, Send, ShieldCheck, Sparkles, Square, Trash2, X } from "lucide-react";
import { deactivateActiveRagOwner, getPageRecord, getRagSources, hasRemoteRagProvider, isHotRemoteRagProvider, searchDocuments, setActiveRagOwner } from "@/utils/ragOrama";
import type { AnswerReceipt, RetrievalResult } from "@/utils/ragTypes";
import { clearStoredCloudApiKey, describeImageWithCloud, getCloudErrorKind, getStoredCloudApiKey, isCloudProviderError, normalizeCloudError, storeCloudApiKey, streamCloudAgentAnswer, verifyCloudApiKey } from "@/utils/aiProvider";
import { describeImageWithHostedAi, streamHostedAgentAnswer } from "@/utils/openRouterProvider";
import { analyzeIndexedImage, createChatToolObservation, readBlobInventory, readBlobInventoryForAgent, readConnectedWallet, runChatTool, type ChatToolResult } from "@/utils/chatTools";
import { buildAdaptiveAgentSystemInstruction, isInternalGuideSource } from "@/utils/agentPolicy";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isE2EWalletConnected } from "@/utils/devMode";
import { buildAdaptiveGeminiHistory } from "@/utils/conversationMemory";
import { createChatMessage, type ChatMessage, useChatManager } from "@/hooks/useChatManager";
import { assignCitationIds, createAnswerReceipt, finalizeCitationGrounding } from "@/utils/answerReceipt";
import { AnswerReceiptPanel } from "@/components/chat/AnswerReceiptPanel";
import { LiveProofMeter } from "@/components/chat/LiveProofMeter";
import { useGeminiUsage } from "@/hooks/useGeminiUsage";
import type { HotRagProofSnapshot } from "@/utils/hotRagProof";
import { normalizeGeminiApiKey } from "@/utils/geminiApiKey";
import { useLanguage } from "@/i18n";
import type { BlobInventoryRefreshCapability } from "@/utils/agentCapabilities";
import { useShelbyNetwork } from "@/network/ShelbyNetworkProvider";
import { createShelbyWorkspaceKey } from "@/utils/shelbyNetwork";
const MOCK_ACCOUNT = { address: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" };

const shortProof = (value: string | undefined, unavailable: string) => value ? (value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value) : unavailable;
const formatBytes = (value: number | undefined, unavailable: string) => value === undefined ? unavailable : value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;

interface UnifiedChatProps {
  refreshBlobInventory?: BlobInventoryRefreshCapability;
}

export function UnifiedChat({ refreshBlobInventory }: UnifiedChatProps) {
  const { language, t } = useLanguage();
  const { network } = useShelbyNetwork();
  const unavailable = t("Unavailable", "Chưa có");
  const accessLabel = (value?: NonNullable<RetrievalResult["provenance"]>["accessTag"]) => ({
    public: t("Public", "Công khai"),
    allowlist: t("Allowlist", "Danh sách cho phép"),
    purchasable: t("Access required", "Cần quyền truy cập"),
    time_lock: t("Time lock", "Khóa thời gian"),
  }[String(value)] ?? t("Unknown", "Không rõ"));
  const extractionLabel = (value?: string) => ({
    text_layer: t("Original text", "Văn bản gốc"),
    local_ocr: t("On-device OCR", "OCR trên thiết bị"),
    cloud_vision: t("AI image reading", "AI đọc hình ảnh"),
    cloud_video: t("AI video reading", "AI đọc video"),
    mixed: t("Text + OCR", "Văn bản + OCR"),
  }[value ?? ""] ?? t("Unknown", "Không rõ"));
  const cloudErrorMessage = (error: unknown) => {
    const normalized = normalizeCloudError(error);
    if (language === "vi") return normalized.message;
    const kind = getCloudErrorKind(error);
    if (kind === "rate_limit") return "Gemini temporarily limited this request (429). The API key was not rejected; wait and try again, or check this model's usage and rate limits.";
    if (kind === "invalid_key") return "The Gemini API key is invalid or cannot access this model.";
    if (kind === "network") return "Unable to reach Gemini. Check your network and try again.";
    if (kind === "timeout") return "Gemini took too long to respond. The request was stopped after 30 seconds; please try again.";
    return "Gemini did not respond.";
  };
  const { preferences: geminiUsage } = useGeminiUsage();
  const { account: realAccount } = useWallet();
  const account = isE2EWalletConnected()
    ? MOCK_ACCOUNT
    : realAccount;
  const ownerKey = createShelbyWorkspaceKey({ network, owner: account?.address.toString() ?? "disconnected" });
  const { query, setQuery, messages, setMessages, loading, status, setStatus, beginRequest, isRequestCurrent, finishRequest, abortRequest, clearMessages } = useChatManager(ownerKey);
  const [cloudApiKey, setCloudApiKey] = useState("");
  const [cloudKeyState, setCloudKeyState] = useState<"empty" | "checking" | "ready" | "limited" | "unverified" | "invalid">("empty");
  const activeGeminiApiKey = cloudKeyState === "empty" || cloudKeyState === "invalid"
    ? ""
    : getStoredCloudApiKey();
  const activeChatProvider = activeGeminiApiKey ? "gemini" : "qwen";
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

  const renderHighlightedText = (fullText: string, excerpt: string) => {
    if (!excerpt || !fullText) return <span className="whitespace-pre-wrap">{fullText}</span>;
    const cleanExcerpt = excerpt.replace(/\s+/g, " ").trim();
    const words = cleanExcerpt.split(/\s+/).filter(Boolean);
    if (words.length < 3) {
      const parts = fullText.split(excerpt);
      return (
        <span className="whitespace-pre-wrap">
          {parts.map((part, i) => i === 0 ? part : <span key={i} className="bg-yellow-100 dark:bg-yellow-950/60 border border-yellow-300/40 text-slate-800 dark:text-slate-200 rounded px-0.5 font-medium">{excerpt}{part}</span>)}
        </span>
      );
    }
    const regexStr = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    try {
      const regex = new RegExp(`(${regexStr})`, 'i');
      const parts = fullText.split(regex);
      return (
        <span className="whitespace-pre-wrap">
          {parts.map((part, i) => {
            if (regex.test(part)) {
              return (
                <mark key={i} className="bg-yellow-200/90 dark:bg-cyan-950/80 border border-yellow-300 dark:border-cyan-500/30 text-slate-900 dark:text-slate-100 rounded px-1 py-0.5 font-medium shadow-sm">
                  {part}
                </mark>
              );
            }
            return part;
          })}
        </span>
      );
    } catch {
      return <span className="whitespace-pre-wrap">{fullText}</span>;
    }
  };

  const [ragReady, setRagReady] = useState(false);
  const [ragMode, setRagMode] = useState<"local" | "hot" | "none">("none");

  useEffect(() => {
    const savedKey = getStoredCloudApiKey();
    if (savedKey) {
      setCloudApiKey(savedKey);
      setCloudKeyState("ready");
    }
  }, []);

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
      let finalAgentToolResult = agentToolResult as ChatToolResult | null;
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
      // Keep this generation current until a new receipt, wallet switch or
      // clear action replaces it. React may commit the queued message update
      // after this finally block has run.
      if (wasCurrent) setReceiptBusyId(null);
    }
  };
  const [showApiPanel, setShowApiPanel] = useState(false);
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
  const geminiCtaClass = cloudKeyState === "ready"
    ? "border-emerald-300 bg-gradient-to-r from-emerald-50 to-lime-50 text-emerald-800 shadow-[0_4px_16px_rgba(16,185,129,0.12)] hover:border-emerald-400 hover:shadow-[0_6px_20px_rgba(16,185,129,0.18)] dark:border-lime-300/30 dark:from-lime-300/10 dark:to-emerald-300/5 dark:text-lime-200"
    : cloudKeyState === "limited" || cloudKeyState === "unverified"
      ? "border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400 hover:bg-amber-100/80 dark:border-amber-300/25 dark:bg-amber-300/10 dark:text-amber-200"
      : "border-lime-300 bg-lime-50/80 text-emerald-900 shadow-[0_3px_12px_rgba(132,204,22,0.10)] hover:border-lime-400 hover:bg-lime-100/80 dark:border-lime-300/25 dark:bg-lime-300/10 dark:text-lime-200";
  const geminiCtaLabel = cloudKeyState === "ready"
    ? t("Gemini ready", "Gemini sẵn sàng")
    : cloudKeyState === "limited" || cloudKeyState === "unverified"
      ? t("Check Gemini", "Kiểm tra Gemini")
      : t("Use Gemini", "Dùng Gemini");

  return (
    <Card className="glass-panel border-white/40 dark:border-white/10 mt-0 flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] shadow-sm">
      <CardContent className="flex h-full min-h-0 flex-1 flex-col p-0">
        {/* Compact header */}
        <div className="flex min-h-[64px] items-center justify-between gap-3 border-b border-black/5 px-5 dark:border-white/5 bg-white/40 dark:bg-black/20">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[#172019] text-[#c5fb7e] dark:bg-lime-300 dark:text-slate-950"><MessageSquare className="h-4 w-4" /></div>
            <div className="min-w-0"><h3 className="truncate text-[15px] font-extrabold tracking-[-0.02em] text-[#101512] dark:text-white">{t("Knowledge Assistant", "Trợ lý tri thức")}</h3><p className="text-[11px] leading-4 text-slate-500 dark:text-slate-400">{t("Natural answers with sources when needed", "Trả lời tự nhiên, kèm nguồn khi cần")}</p></div>
          </div>
          <div className="flex items-center gap-3">
            {/* Inline status chips */}
            <div className="hidden items-center gap-3 sm:flex">
              <span className={ragReady ? "status-chip ok" : "status-chip"} title={ragMode === "hot" ? t("Fetch only relevant parts from Shelby", "Chỉ đọc các phần liên quan từ Shelby") : t("Reference data", "Dữ liệu tham khảo")}><span className={`status-dot ${ragReady ? "green" : "gray"}`} /> {ragMode === "hot" ? t("Reading from Shelby", "Đọc từ Shelby") : ragReady ? t("Data ready", "Đã có dữ liệu") : t("No data yet", "Chưa có dữ liệu")}</span>
              <span
                className={geminiUsage.chat ? "status-chip ok" : "status-chip"}
                title={geminiUsage.chat
                  ? activeChatProvider === "gemini"
                    ? t("Chat uses your saved Gemini key; Gemini 2.5 Flash is preferred", "Chat dùng Gemini key đã lưu; ưu tiên Gemini 2.5 Flash")
                    : t("No Gemini key is saved, so chat uses the app's Qwen3.7 Flash", "Chưa lưu Gemini key nên chat dùng Qwen3.7 Flash của ứng dụng")
                  : t("AI chat is off in Settings", "Chat AI đang tắt trong Cấu hình")}
              >
                <span className={`status-dot ${geminiUsage.chat ? "green" : "gray"}`} />
                {geminiUsage.chat
                  ? activeChatProvider === "gemini" ? "Gemini" : "Qwen 3.7"
                  : t("Chat off", "Chat đã tắt")}
              </span>
            </div>
            <button
              type="button"
              aria-expanded={showApiPanel}
              aria-controls="gemini-key-panel"
              data-state={cloudKeyState}
              className={`flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-[11px] font-extrabold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${geminiCtaClass}`}
              onClick={() => setShowApiPanel((value) => !value)}
              title={t("Use Gemini for chat and richer RAG processing", "Dùng Gemini cho chat và xử lý RAG tốt hơn")}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {geminiCtaLabel}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showApiPanel ? "rotate-180" : ""}`} />
            </button>
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

        {/* API Key (Collapsible) */}
        {!geminiUsage.chat && !showApiPanel && (
          <button onClick={() => window.dispatchEvent(new Event("shelby:open-rag-config"))} className="mx-4 mt-3 flex items-center justify-between rounded-xl bg-emerald-50/80 px-3 py-2 text-left transition-colors hover:bg-emerald-50 dark:bg-emerald-300/[0.045] dark:hover:bg-emerald-300/[0.065]">
            <span className="flex items-center gap-2 text-[12px] font-semibold text-emerald-800 dark:text-emerald-200"><MessageSquare className="h-3.5 w-3.5" />{t("AI chat is off to save quota", "Chat AI đang tắt để tiết kiệm quota")}</span>
            <span className="text-[11px] font-bold text-emerald-700 dark:text-lime-300">{t("Open Settings", "Mở Cấu hình")} →</span>
          </button>
        )}
        {showApiPanel ? (
          <div id="gemini-key-panel" className="mx-4 mt-3 rounded-xl border border-[#dfe4dc] bg-[#f5f6f2] p-3 dark:border-white/[0.06] dark:bg-white/[0.025]">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="block text-[12px] font-semibold text-slate-700 dark:text-slate-300">
                  {activeChatProvider === "gemini"
                    ? t("Chat is using Gemini", "Chat đang dùng Gemini")
                    : t("Chat is using Qwen3.7 Flash", "Chat đang dùng Qwen3.7 Flash")}
                </span>
                <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                  {t(
                    "Save a Gemini key to switch chat to Gemini 2.5 Flash first and enable richer OCR, image, video, and semantic indexing.",
                    "Lưu Gemini key để chuyển chat sang Gemini 2.5 Flash trước, đồng thời mở khóa OCR, ảnh, video và lập chỉ mục ngữ nghĩa tốt hơn.",
                  )}
                </span>
              </div>
              <button className="text-[11px] text-slate-400 hover:text-slate-600" onClick={() => setShowApiPanel(false)}>{t("Close", "Đóng")}</button>
            </div>
            <span className="mb-1.5 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">{t("Gemini API key", "Gemini API key")}</span>
            <div className="flex gap-1.5">
              <Input
                type="password"
                name="gemini-api-key"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="h-10 rounded-lg border-[#d8ddd5] bg-[#fdfefa] text-[13px] dark:border-white/[0.08] dark:bg-black/20"
                value={cloudApiKey}
                onChange={(event) => {
                  const nextKey = event.target.value;
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
                onKeyDown={(event) => event.key === "Enter" && void saveCloudKey()}
                placeholder={t("Paste Gemini API key…", "Dán Gemini API key…")}
              />
              <Button
                size="sm"
                className="h-10 shrink-0 rounded-lg bg-[#172019] px-3.5 text-[12px] text-[#c5fb7e] hover:bg-[#263029] dark:bg-lime-300 dark:text-slate-950"
                onClick={() => void saveCloudKey()}
                disabled={!cloudApiKey || cloudKeyState === "checking"}
              >
                {cloudKeyState === "checking"
                  ? <><KeyRound className="mr-1.5 h-3.5 w-3.5" />{t("Checking", "Đang kiểm tra")}</>
                  : (cloudKeyState === "limited" || cloudKeyState === "unverified")
                    && normalizeGeminiApiKey(cloudApiKey) === getStoredCloudApiKey()
                    ? t("Try again", "Thử lại")
                    : t("Save & check", "Lưu & kiểm tra")}
              </Button>
              {(cloudKeyState === "ready" || cloudKeyState === "limited" || cloudKeyState === "unverified") && (
                <Button size="sm" variant="ghost" className="h-8 text-[11px] text-slate-400" onClick={() => { clearStoredCloudApiKey(); setCloudApiKey(""); setCloudKeyState("empty"); setStatus(t("API key removed.", "Đã xoá API key.")); }}>{t("Remove", "Xoá")}</Button>
              )}
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <p className={`text-[11px] leading-4 ${cloudKeyState === "ready" ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"}`}>
                {t("This Gemini key stays only in this browser tab. It is never added to RAG or uploaded to Shelby.", "Gemini key chỉ được lưu trong phiên tab này. Key không được đưa vào RAG hay tải lên Shelby.")}
              </p>
              {normalizeGeminiApiKey(cloudApiKey) && <span className="shrink-0 pl-3 font-mono text-[10px] font-bold text-slate-500 dark:text-slate-400">Key …{normalizeGeminiApiKey(cloudApiKey).slice(-4)}</span>}
            </div>
          </div>
        ) : null}

        {/* Status message */}
        {status && !loading && (
          <p className="mx-4 mt-3 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500 dark:border-white/[0.04] dark:bg-white/[0.02] dark:text-slate-400" role="status" aria-live="polite">{status}</p>
        )}

        {/* Chat messages area */}
        <div className="relative flex min-h-0 flex-1 gap-3 overflow-hidden px-3 pb-2 pt-3 sm:px-5 sm:pt-5">
          <div data-testid="chat-scroll" ref={messagesScrollRef} onScroll={handleMessagesScroll} className="custom-scrollbar flex min-h-0 min-w-0 flex-1 flex-col space-y-4 overflow-y-auto overscroll-contain rounded-2xl bg-transparent p-2 sm:p-2">
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
                  <span>{t("Data", "Dữ liệu")}</span><span className="text-slate-300 dark:text-slate-700">→</span><span>{t("Prepare on device", "Chuẩn bị trên máy")}</span><span className="text-slate-300 dark:text-slate-700">→</span><span className={ragReady ? "text-emerald-700 dark:text-lime-300" : ""}>{t("Ready to search", "Sẵn sàng tra cứu")}</span>
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
              <div
                key={message.id}
                className={`px-4 py-3.5 transition-all ${message.role === "user" ? "max-w-[78%]" : "max-w-[92%]"} ${
                  message.role === "user"
                    ? "self-end ml-auto rounded-2xl rounded-tr-sm bg-gradient-to-br from-lime-100/90 to-emerald-100/80 text-slate-900 dark:from-lime-900/40 dark:to-emerald-900/30 dark:text-lime-50 border border-lime-200/50 dark:border-lime-800/50 backdrop-blur-md shadow-sm"
                    : "mr-auto rounded-2xl rounded-tl-sm bg-white/80 dark:bg-slate-900/60 text-slate-800 dark:text-slate-200 border border-white/40 dark:border-white/10 backdrop-blur-md shadow-sm"
                }`}
              >
                {/* Message header */}
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
                  {message.role === "user" ? (
                    <span className="text-indigo-500 dark:text-indigo-400">{t("You", "Bạn")}</span>
                  ) : message.tool === "document_lookup" ? (
                    <><Bookmark className="h-3 w-3 text-emerald-600" /><span>{t("Sourced answer", "Trả lời có nguồn")}</span></>
                  ) : message.tool === "blob_inventory" ? (
                    <><Database className="h-3 w-3 text-emerald-600" /><span>{t("Shelby data", "Dữ liệu Shelby")}</span></>
                  ) : message.tool === "show_images" ? (
                    <><Sparkles className="h-3 w-3 text-emerald-600" /><span>{t("AI · Image", "AI · Hình ảnh")}</span></>
                  ) : message.tool ? (
                    <><Database className="h-3 w-3 text-emerald-600" /><span>{t("App data", "Dữ liệu từ ứng dụng")}</span></>
                  ) : (
                    <><Sparkles className="w-3 h-3 text-indigo-400" /><span>AI</span></>
                  )}
                </div>

                {/* Message content parsed with react-markdown */}
                <div className="prose prose-slate max-w-none text-[15px] leading-7 prose-p:my-2 prose-li:my-1 dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => /^(https?:|mailto:)/i.test(url) ? url : ""}>
                    {message.text}
                  </ReactMarkdown>
                </div>

                {message.typing && (
                  <span className="ml-1 inline-flex gap-1 align-middle" aria-label={t("Finishing the answer", "Đang hoàn thiện câu trả lời")}><span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" /></span>
                )}

                {message.interrupted && !message.typing ? (
                  <p className="mt-2 text-[11px] font-medium text-amber-700 dark:text-amber-300">{t("The response stopped before completion.", "Phản hồi đã dừng trước khi hoàn tất.")}</p>
                ) : null}

                {message.role === "ai" && message.hotReadProof && !message.typing ? <LiveProofMeter proof={message.hotReadProof} /> : null}

                {/* Evidence citations */}
                {message.sources?.length ? (
                  <details className="group mt-2.5 rounded-lg border border-slate-100 dark:border-white/[0.06] bg-slate-50/30 dark:bg-slate-900/20 p-2.5 text-xs">
                    <summary className="flex cursor-pointer select-none items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-400">
                      <span className="flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                        {t("Inspect sources", "Kiểm chứng câu trả lời")} ({message.sources.length})
                      </span>
                      <ChevronDown className="h-3 w-3 text-slate-400 transition-transform duration-200 group-open:rotate-180" />
                    </summary>
                    <div className="mt-2 space-y-2 border-t border-slate-100 dark:border-white/[0.04] pt-2">
                      {message.sources.map((source, sourceIndex) => {
                        const scorePct = Math.max(0, Math.min(100, Math.round(source.score * 100)));
                        return (
                          <button
                            type="button"
                            key={`${source.source}:${source.pageNumber}:${sourceIndex}`}
                            onClick={() => setActiveVisualSource(source)}
                            className="flex w-full flex-col gap-1 rounded-lg border border-slate-100 bg-white/60 p-2 text-left transition-colors hover:border-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-white/[0.04] dark:bg-slate-950/30 dark:hover:border-indigo-500/30"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-1 truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
                                <Bookmark className="h-2.5 w-2.5 text-indigo-500 shrink-0" />
                                {source.citationId ? `[${source.citationId}] ` : ""}{source.displayName}{source.pageNumber ? ` · p.${source.pageNumber}` : ""}
                              </span>
                              <div className="flex items-center gap-1 shrink-0">
                                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${source.method === "semantic" ? "bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-300" : "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300"}`}>
                                  {source.method === "semantic" ? t("Semantic", "Theo ý nghĩa") : t("Keyword", "Từ khóa")}
                                </span>
                                <span className="text-[10px] text-slate-400">{scorePct}%</span>
                              </div>
                            </div>
                            <p className="line-clamp-3 border-l-2 border-slate-200 pl-3 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">{source.excerpt}</p>
                          </button>
                        );
                      })}
                    </div>
                  </details>
                ) : null}

                {message.role === "ai" && message.sources?.length && !message.typing ? (
                  <button
                    type="button"
                    className="mt-2.5 flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 text-[10px] font-extrabold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-300/15 dark:bg-emerald-300/[0.06] dark:text-emerald-300"
                    onClick={() => void handleAnswerReceipt(message.id)}
                    disabled={receiptBusyId !== null}
                  >
                    <FileCheck2 className="h-3.5 w-3.5" />
                    {message.receipt ? t("View Answer Receipt", "Xem Phiếu kiểm chứng") : receiptBusyId === message.id ? t("Checking against Shelby…", "Đang đối chiếu với Shelby…") : t("Create Answer Receipt", "Tạo Phiếu kiểm chứng")}
                  </button>
                ) : null}

                {message.links?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {message.links.map((link) => (
                      <a key={`${link.url}:${link.label}`} href={link.url} target="_blank" rel="noreferrer" className="rounded-md border border-indigo-100 bg-indigo-50/50 px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-100 dark:border-indigo-500/15 dark:bg-indigo-950/30 dark:text-indigo-300 transition-colors">
                        {link.label}
                      </a>
                    ))}
                  </div>
                ) : null}

                {message.imageUrls?.length ? (
                  <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {message.imageUrls.map((url) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer" className="block">
                        <img src={url} alt={t("Shelby blob preview", "Blob Shelby")} className="max-h-48 w-full rounded-lg border border-slate-100 dark:border-white/[0.06] bg-slate-50 dark:bg-black/20 object-contain" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {loading && !messages.some((message) => message.typing) && (
              <div className="mr-auto w-full max-w-[92%] rounded-2xl rounded-tl-sm border border-[#e4e8e1] bg-white/75 px-4 py-3.5 text-[13px] text-slate-500 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-900/50 dark:text-slate-400" role="status" aria-live="polite">
                <div className="flex items-center gap-3"><span className="flex gap-1" aria-hidden="true"><span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" /></span><span>{t("Composing an answer", "Đang soạn câu trả lời")}</span></div>
              </div>
            )}
          </div>

          {showJumpToLatest && (
            <button onClick={jumpToLatest} className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-bold text-slate-700 shadow-lg transition hover:-translate-y-0.5 dark:border-white/10 dark:bg-slate-950 dark:text-white">
              <ArrowDown className="h-3.5 w-3.5" /> {t("Latest message", "Tin mới nhất")}
            </button>
          )}

          {/* Verifiable RAG proof panel */}
          {activeVisualSource && (
            <aside role="dialog" aria-modal="false" aria-labelledby="answer-proof-title" onKeyDown={(event) => { if (event.key === "Escape") setActiveVisualSource(null); }} data-testid="answer-proof" className="absolute bottom-3 right-3 top-3 z-20 flex min-h-[280px] w-[min(24rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-emerald-200/70 bg-white/95 shadow-xl backdrop-blur-md animate-in slide-in-from-right duration-200 dark:border-emerald-300/10 dark:bg-slate-950/95">
              <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-emerald-50/80 to-lime-50/30 px-3.5 py-3 dark:border-white/[0.06] dark:from-emerald-300/[0.06] dark:to-transparent">
                <div className="min-w-0">
                  <h4 id="answer-proof-title" className="flex items-center gap-1.5 text-xs font-extrabold text-slate-900 dark:text-white">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    {t("Inspect answer evidence", "Kiểm chứng câu trả lời")}
                  </h4>
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">{activeVisualSource.provenance?.blobMerkleRoot ? t("Source fingerprint available", "Có mã tệp nguồn để đối chiếu") : t("Local excerpt · re-index to add a source fingerprint", "Đoạn trích trên máy · nạp lại để bổ sung mã tệp")}</p>
                </div>
                <Button autoFocus variant="ghost" size="icon" className="h-9 w-9 text-slate-400 hover:text-slate-900 dark:hover:text-white" onClick={() => setActiveVisualSource(null)}>
                  <span className="sr-only">{t("Close evidence viewer", "Đóng trình xem bằng chứng")}</span>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto bg-slate-50/35 p-3 dark:bg-slate-900/20">
                <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
                  <div className="mb-2 flex items-center justify-between gap-2"><span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">1 · {t("Excerpt", "Đoạn trích")}</span><span className="text-[10px] font-semibold text-slate-400">{Math.max(0, Math.min(100, Math.round(activeVisualSource.score * 100)))}% {t("relevant", "liên quan")}</span></div>
                  <p className="select-text border-l-2 border-emerald-300 pl-3 text-xs leading-5 text-slate-600 dark:border-emerald-500/40 dark:text-slate-300">{activeVisualSource.excerpt}</p>
                  <details className="group mt-2 border-t border-slate-100 pt-2 dark:border-white/[0.05]">
                    <summary className="flex cursor-pointer items-center justify-between text-[10px] font-bold text-slate-500"><span>{t("View full page context", "Xem ngữ cảnh đầy đủ của trang")}</span><ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" /></summary>
                    <div className="mt-2 max-h-52 select-text overflow-y-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[10px] leading-5 text-slate-600 dark:bg-black/20 dark:text-slate-300">{renderHighlightedText(visualPageText, activeVisualSource.excerpt)}</div>
                  </details>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
                  <p className="mb-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-500">2 · {t("Location in source", "Vị trí trong tài liệu")}</p>
                  <dl className="grid gap-2 text-[10px]">
                    <div className="flex items-start justify-between gap-3"><dt className="text-slate-400">{t("Source", "Nguồn")}</dt><dd className="max-w-[70%] break-words text-right font-bold text-slate-700 dark:text-slate-200">{activeVisualSource.displayName}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-400">{t("Location", "Vị trí")}</dt><dd className="font-bold text-slate-700 dark:text-slate-200">{activeVisualSource.provenance?.mimeType?.startsWith("video/") ? t("In video", "Trong video") : `${activeVisualSource.pageNumber}/${activeVisualSource.totalPages}`}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-400">{t("Extraction", "Cách đọc")}</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{extractionLabel(activeVisualSource.provenance?.extractionMethod)}</dd></div>
                  </dl>
                </section>

                <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
                  <div className="mb-2 flex items-center justify-between"><p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">3 · {t("Shelby trail", "Dấu vết trên Shelby")}</p>{activeVisualSource.provenance?.blobMerkleRoot && <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-extrabold text-emerald-700 dark:bg-emerald-300/10 dark:text-emerald-300"><Fingerprint className="h-3 w-3" />{t("Fingerprint", "Có mã nguồn")}</span>}</div>
                  {activeVisualSource.provenance ? (
                    <div className="grid gap-2 text-[10px]">
                      <dl className="grid gap-2">
                        <div className="flex justify-between gap-3"><dt className="flex items-center gap-1 text-slate-400"><Cloud className="h-3 w-3" />{t("Access", "Quyền truy cập")}</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{accessLabel(activeVisualSource.provenance.accessTag)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-slate-400">{t("Read from", "Đã đọc từ")}</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{activeVisualSource.provenance.storageMode === "shelby_hot" ? `${t("Shelby on demand", "Shelby theo nhu cầu")}${activeVisualSource.provenance.bytesRead !== undefined ? ` · ${formatBytes(activeVisualSource.provenance.bytesRead, unavailable)}` : ""}` : t("Local index", "Kho trên máy")}</dd></div>
                      </dl>
                      <details className="group mt-1 border-t border-slate-100 pt-2 dark:border-white/[0.05]">
                        <summary className="flex cursor-pointer items-center justify-between text-[10px] font-bold text-slate-500"><span>{t("Technical details", "Chi tiết kỹ thuật")}</span><ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" /></summary>
                        <dl className="mt-2 grid gap-2 text-[10px]">
                          <div className="flex justify-between gap-3"><dt className="text-slate-400">{t("Data part ID", "Mã phần dữ liệu")}</dt><dd className="font-mono font-semibold text-slate-700 dark:text-slate-200" title={activeVisualSource.provenance.chunkId}>{shortProof(activeVisualSource.provenance.chunkId, unavailable)}</dd></div>
                          <div className="flex justify-between gap-3"><dt className="text-slate-400">Blob ID</dt><dd className="font-mono font-semibold text-slate-700 dark:text-slate-200" title={activeVisualSource.provenance.blobId}>{shortProof(activeVisualSource.provenance.blobId, unavailable)}</dd></div>
                          <div className="flex justify-between gap-3"><dt className="text-slate-400">{t("Size", "Kích thước")}</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{formatBytes(activeVisualSource.provenance.blobSize, unavailable)}</dd></div>
                          <div className="flex justify-between gap-3"><dt className="flex items-center gap-1 text-slate-400"><Database className="h-3 w-3" />{t("Indexed at", "Tạo chỉ mục lúc")}</dt><dd className="font-semibold text-slate-700 dark:text-slate-200">{new Date(activeVisualSource.provenance.indexedAt).toLocaleString(language === "vi" ? "vi-VN" : "en-US")}</dd></div>
                          <div className="rounded-lg bg-slate-50 p-2 dark:bg-black/20"><dt className="text-slate-400">Merkle root</dt><dd className="mt-1 break-all font-mono text-[9px] leading-4 text-slate-700 dark:text-slate-200">{activeVisualSource.provenance.blobMerkleRoot ?? t("Legacy RAG has no stored verification fingerprint", "Bản RAG cũ chưa lưu mã xác minh")}</dd></div>
                        </dl>
                      </details>
                    </div>
                  ) : <p className="text-[10px] leading-4 text-slate-500">{t("This data was created by an older version. Re-index the document once to add its Blob ID and verification fingerprint.", "Dữ liệu này được tạo bằng phiên bản cũ. Nạp lại tài liệu một lần để bổ sung Blob ID và mã xác minh.")}</p>}
                </section>
                {activeVisualSource.link && <a href={activeVisualSource.link} target="_blank" rel="noreferrer" className="flex h-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-[10px] font-extrabold text-slate-700 hover:border-emerald-300 hover:text-emerald-700 dark:border-white/[0.07] dark:bg-white/[0.025] dark:text-slate-200">{t("Open original blob on Shelby", "Mở blob gốc trên Shelby")} ↗</a>}
              </div>
            </aside>
          )}
          {activeReceipt && <AnswerReceiptPanel receipt={activeReceipt} onClose={() => setActiveReceipt(null)} />}
        </div>

        {/* Input bar */}
        <div className="flex gap-3 bg-transparent p-4 sm:px-5 sm:pb-5">
          <Input
            aria-label={t("Enter a question", "Nhập câu hỏi")}
            className="h-14 rounded-2xl border-black/5 bg-white/60 px-5 text-sm shadow-inner backdrop-blur-md focus-visible:ring-lime-500 dark:border-white/5 dark:bg-black/40 dark:text-slate-100 transition-all focus:bg-white dark:focus:bg-black/60"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={!geminiUsage.chat ? t("Use wallet and Shelby data tools…", "Dùng công cụ ví và kho Shelby…") : ragReady ? t("Ask about your indexed data…", "Hỏi về dữ liệu đã nạp…") : t("Ask general knowledge or use a data tool…", "Hỏi kiến thức chung hoặc dùng công cụ…")}
            onKeyDown={(event) => event.key === "Enter" && !loading && void handleAsk()}
          />
          <Button
            className="h-14 w-14 shrink-0 rounded-2xl bg-gradient-to-br from-lime-400 to-emerald-500 p-0 text-slate-950 shadow-md hover:-translate-y-0.5 hover:shadow-lg transition-all disabled:opacity-50"
            onClick={() => loading ? abortRequest() : void handleAsk()}
            disabled={!loading && !query.trim()}
            aria-label={loading ? t("Stop response", "Dừng phản hồi") : t("Send question", "Gửi câu hỏi")}
          >
            {loading ? <Square className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
