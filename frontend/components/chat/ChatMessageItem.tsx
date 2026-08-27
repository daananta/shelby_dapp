import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bookmark, Check, ChevronDown, Copy, Database, FileCheck2, ShieldCheck, Sparkles } from "lucide-react";
import type { ChatMessage } from "@/hooks/useChatManager";
import type { RetrievalResult } from "@/utils/ragTypes";
import { LiveProofMeter } from "@/components/chat/LiveProofMeter";
import { useLanguage } from "@/i18n";

export interface ChatMessageItemProps {
  message: ChatMessage;
  onOpenSourceProof: (source: RetrievalResult) => void;
  onRequestAnswerReceipt: (messageId: string) => void;
  receiptBusyId: string | null;
}

export function ChatMessageItem({
  message,
  onOpenSourceProof,
  onRequestAnswerReceipt,
  receiptBusyId,
}: ChatMessageItemProps) {
  const { t } = useLanguage();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyResetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  };

  const copyLabel = copyState === "copied"
    ? t("Copied", "Đã sao chép")
    : copyState === "error"
      ? t("Copy failed", "Không thể sao chép")
      : t("Copy answer", "Sao chép câu trả lời");

  return (
    <div
      className={`px-4 py-3.5 transition-all ${
        message.role === "user" ? "max-w-[78%]" : "max-w-[92%]"
      } ${
        message.role === "user"
          ? "self-end ml-auto rounded-2xl rounded-tr-sm bg-gradient-to-br from-lime-100/90 to-emerald-100/80 text-slate-900 dark:from-lime-900/40 dark:to-emerald-900/30 dark:text-lime-50 border border-lime-200/50 dark:border-lime-800/50 backdrop-blur-md shadow-sm"
          : "mr-auto rounded-2xl rounded-tl-sm bg-white/80 dark:bg-slate-900/60 text-slate-800 dark:text-slate-200 border border-white/40 dark:border-white/10 backdrop-blur-md shadow-sm"
      }`}
    >
      {/* Message header */}
      <div className="mb-2 flex min-h-6 items-center justify-between gap-3 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
        <span className="flex min-w-0 items-center gap-1.5">
          {message.role === "user" ? (
            <span className="text-indigo-500 dark:text-indigo-400">{t("You", "Bạn")}</span>
          ) : message.tool === "document_lookup" ? (
            <>
              <Bookmark className="h-3 w-3 text-emerald-600" />
              <span>{t("Sourced answer", "Trả lời có nguồn")}</span>
            </>
          ) : message.tool === "blob_inventory" ? (
            <>
              <Database className="h-3 w-3 text-emerald-600" />
              <span>{t("Shelby data", "Dữ liệu Shelby")}</span>
            </>
          ) : message.tool === "show_images" ? (
            <>
              <Sparkles className="h-3 w-3 text-emerald-600" />
              <span>{t("AI · Image", "AI · Hình ảnh")}</span>
            </>
          ) : message.tool ? (
            <>
              <Database className="h-3 w-3 text-emerald-600" />
              <span>{t("App data", "Dữ liệu từ ứng dụng")}</span>
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3 text-indigo-400" />
              <span>AI</span>
            </>
          )}
        </span>
        {message.role === "ai" && !message.typing && message.text.trim() ? (
          <button
            type="button"
            onClick={() => void copyAnswer()}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[10px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              copyState === "error"
                ? "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-300"
                : "border-slate-200/80 bg-white/60 text-slate-500 hover:border-emerald-200 hover:text-emerald-700 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-400 dark:hover:text-lime-300"
            }`}
            aria-label={copyLabel}
            title={copyLabel}
          >
            {copyState === "copied" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            <span className="hidden sm:inline" aria-live="polite">{copyLabel}</span>
          </button>
        ) : null}
      </div>

      {/* Message content parsed with react-markdown */}
      <div className="prose prose-slate max-w-none text-[15px] leading-7 prose-p:my-2 prose-li:my-1 dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => (/^(https?:|mailto:)/i.test(url) ? url : "")}
        >
          {message.text}
        </ReactMarkdown>
      </div>

      {message.typing && (
        <span
          className="ml-1 inline-flex gap-1 align-middle"
          aria-label={t("Finishing the answer", "Đang hoàn thiện câu trả lời")}
        >
          <span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="calm-dot h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
      )}

      {message.interrupted && !message.typing ? (
        <p className="mt-2 text-[11px] font-medium text-amber-700 dark:text-amber-300">
          {t("The response stopped before completion.", "Phản hồi đã dừng trước khi hoàn tất.")}
        </p>
      ) : null}

      {message.role === "ai" && message.hotReadProof && !message.typing ? (
        <LiveProofMeter proof={message.hotReadProof} />
      ) : null}

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
                  onClick={() => onOpenSourceProof(source)}
                  className="flex w-full flex-col gap-1 rounded-lg border border-slate-100 bg-white/60 p-2 text-left transition-colors hover:border-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-white/[0.04] dark:bg-slate-950/30 dark:hover:border-indigo-500/30"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
                      <Bookmark className="h-2.5 w-2.5 text-indigo-500 shrink-0" />
                      {source.citationId ? `[${source.citationId}] ` : ""}
                      {source.displayName}
                      {source.pageNumber ? ` · p.${source.pageNumber}` : ""}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                          source.method === "semantic"
                            ? "bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-300"
                            : "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300"
                        }`}
                      >
                        {source.method === "semantic"
                          ? t("Semantic", "Theo ý nghĩa")
                          : t("Keyword", "Từ khóa")}
                      </span>
                      <span className="text-[10px] text-slate-400">{scorePct}%</span>
                    </div>
                  </div>
                  <p className="line-clamp-3 border-l-2 border-slate-200 pl-3 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    {source.excerpt}
                  </p>
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
          onClick={() => void onRequestAnswerReceipt(message.id)}
          disabled={receiptBusyId !== null}
        >
          <FileCheck2 className="h-3.5 w-3.5" />
          {message.receipt
            ? t("View Answer Receipt", "Xem Phiếu kiểm chứng")
            : receiptBusyId === message.id
              ? t("Checking against Shelby…", "Đang đối chiếu với Shelby…")
              : t("Create Answer Receipt", "Tạo Phiếu kiểm chứng")}
        </button>
      ) : null}

      {message.links?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {message.links.map((link) => (
            <a
              key={`${link.url}:${link.label}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-indigo-100 bg-indigo-50/50 px-2 py-1 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-100 dark:border-indigo-500/15 dark:bg-indigo-950/30 dark:text-indigo-300 transition-colors"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}

      {message.imageUrls?.length ? (
        <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {message.imageUrls.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="block">
              <img
                src={url}
                alt={t("Shelby blob preview", "Blob Shelby")}
                className="max-h-48 w-full rounded-lg border border-slate-100 dark:border-white/[0.06] bg-slate-50 dark:bg-black/20 object-contain"
              />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
