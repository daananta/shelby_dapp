import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardCheck,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/i18n";
import {
  createProductTourState,
  PRODUCT_TOUR_QUESTION_EN,
  PRODUCT_TOUR_QUESTION,
  PRODUCT_TOUR_STEPS,
  PRODUCT_TOUR_STORAGE_KEY,
  readProductTourState,
  reduceProductTourState,
  writeProductTourState,
  type ProductTourState,
  type ProductTourTarget,
} from "@/utils/productTour";

export interface ProductTourReadiness {
  walletConnected?: boolean;
  blobCount?: number;
  indexedBlobCount?: number;
  hasSourcedAnswer?: boolean;
  hasAnswerReceipt?: boolean;
}

export interface ProductTourProps {
  open: boolean;
  onClose: () => void;
  /** UI navigation only. The panel never uploads, signs or submits a transaction. */
  onNavigate?: (target: ProductTourTarget) => void;
  /** Lets the host fill the composer without sending the question. */
  onSelectQuestion?: (question: string) => void;
  readiness?: ProductTourReadiness;
  storageKey?: string;
}

function safeSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function ProductTour({
  open,
  onClose,
  onNavigate,
  onSelectQuestion,
  readiness,
  storageKey = PRODUCT_TOUR_STORAGE_KEY,
}: ProductTourProps) {
  const { t } = useLanguage();
  const storage = useMemo(safeSessionStorage, []);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [state, setState] = useState<ProductTourState>(() =>
    readProductTourState(storage, storageKey) ?? createProductTourState(),
  );

  useEffect(() => {
    writeProductTourState(storage, state, storageKey);
  }, [state, storage, storageKey]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  const step = PRODUCT_TOUR_STEPS[state.currentStep];
  const sampleQuestion = t(PRODUCT_TOUR_QUESTION_EN, PRODUCT_TOUR_QUESTION);
  const readinessSteps = [
    {
      label: readiness?.walletConnected && readiness?.blobCount
        ? t(
            `${readiness.blobCount} real ${readiness.blobCount === 1 ? "file is" : "files are"} ready`,
            `${readiness.blobCount} tệp thật đã sẵn sàng`,
          )
        : t("Connect your wallet and select real data", "Kết nối ví và chọn dữ liệu thật"),
      ready: Boolean(readiness?.walletConnected && readiness?.blobCount),
    },
    {
      label: readiness?.indexedBlobCount
        ? t(
            `${readiness.indexedBlobCount} ${readiness.indexedBlobCount === 1 ? "file is" : "files are"} searchable`,
            `${readiness.indexedBlobCount} tệp có thể tra cứu`,
          )
        : t("Prepare at least one file for search", "Tạo RAG cho ít nhất một tệp"),
      ready: Boolean(readiness?.indexedBlobCount),
    },
    {
      label: readiness?.hasSourcedAnswer
        ? t("A sourced answer is ready", "Đã có câu trả lời kèm nguồn")
        : t("Ask a question that needs your data", "Hỏi một câu cần dùng tài liệu"),
      ready: Boolean(readiness?.hasSourcedAnswer),
    },
    {
      label: readiness?.hasAnswerReceipt
        ? t("An Answer Receipt is ready", "Đã có Phiếu kiểm chứng")
        : t("Create an Answer Receipt", "Tạo Phiếu kiểm chứng cho câu trả lời"),
      ready: Boolean(readiness?.hasAnswerReceipt),
    },
  ];
  const readyCount = readinessSteps.filter((item) => item.ready).length;
  const progress = Math.round((readyCount / readinessSteps.length) * 100);
  const move = (action: Parameters<typeof reduceProductTourState>[1]) => {
    setState((current) => reduceProductTourState(current, action));
  };
  const runNavigationOnlyAction = () => {
    if (step.target === "chat") onSelectQuestion?.(sampleQuestion);
    onNavigate?.(step.target);
    move({ type: "NEXT" });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-slate-950/35 p-3 backdrop-blur-[2px] sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-tour-title"
        data-testid="product-tour"
        className="ml-auto flex h-full w-full max-w-[28rem] flex-col overflow-hidden rounded-[1.6rem] border border-white/70 bg-[#fbfcf8]/95 shadow-[0_30px_90px_rgba(15,23,42,.26)] backdrop-blur-xl dark:border-white/10 dark:bg-[#0b120d]/95"
      >
        <header className="border-b border-[#dde6da] px-5 pb-4 pt-5 dark:border-white/[0.08]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="mb-1 flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.16em] text-emerald-700 dark:text-lime-300">
                <Sparkles className="h-3.5 w-3.5" /> {t("Guided product tour", "Hướng dẫn sản phẩm")}
              </p>
              <h2 id="product-tour-title" className="text-lg font-black tracking-[-0.03em] text-slate-950 dark:text-white">
                {t("Explore verifiable RAG", "Khám phá RAG kiểm chứng được")}
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                {t(
                  "A step-by-step guide using your real data. It never uploads files or signs transactions for you.",
                  "Hướng dẫn từng bước bằng dữ liệu thật của bạn. Ứng dụng không tự tải lên hay ký giao dịch.",
                )}
              </p>
            </div>
            <Button
              ref={closeButtonRef}
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-full"
              onClick={onClose}
              aria-label={t("Close product tour", "Đóng hướng dẫn sản phẩm")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10"
              role="progressbar"
              aria-label={t("Workspace readiness", "Mức sẵn sàng của kho")}
              aria-valuemin={0}
              aria-valuemax={4}
              aria-valuenow={readyCount}
            >
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-lime-400 transition-[width] duration-300" style={{ width: `${progress}%` }} />
            </div>
            <span className="whitespace-nowrap text-[11px] font-extrabold tabular-nums text-emerald-700 dark:text-lime-300">
              {t("Ready", "Sẵn sàng")} {readyCount}/4
            </span>
          </div>
        </header>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <ol className="mb-6 grid grid-cols-4 gap-2" aria-label={t("Product tour steps", "Các bước hướng dẫn sản phẩm")}>
            {PRODUCT_TOUR_STEPS.map((item, index) => {
              const completed = readinessSteps[index]?.ready;
              const active = index === state.currentStep;
              const itemTitle = t(item.titleEn, item.title);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => move({ type: "GO_TO", step: index as 0 | 1 | 2 | 3 })}
                    className={`flex w-full flex-col items-center gap-1.5 rounded-xl border px-1 py-2 text-center transition-colors ${
                      active
                        ? "border-emerald-500 bg-emerald-50 text-emerald-800 dark:border-lime-300/60 dark:bg-lime-300/10 dark:text-lime-300"
                        : "border-slate-200 bg-white/70 text-slate-400 hover:border-emerald-300 dark:border-white/[0.07] dark:bg-white/[0.025]"
                    }`}
                    aria-current={active ? "step" : undefined}
                    aria-label={`${t("Step", "Bước")} ${index + 1}: ${itemTitle}`}
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${completed ? "bg-emerald-600 text-white" : active ? "bg-emerald-700 text-white dark:bg-lime-300 dark:text-slate-950" : "bg-slate-100 dark:bg-white/10"}`}>
                      {completed ? <Check className="h-3 w-3 stroke-[3]" /> : index + 1}
                    </span>
                    <span className="text-[9px] font-bold">{t(item.captionEn, item.caption)}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <section className="rounded-2xl border border-[#dce6d9] bg-white p-4 shadow-[0_12px_35px_rgba(42,62,46,.06)] dark:border-white/[0.08] dark:bg-white/[0.035]">
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-full bg-[#172019] px-2.5 py-1 text-[10px] font-extrabold text-[#c5fb7e] dark:bg-lime-300 dark:text-slate-950">
                {t("Step", "Bước")} {state.currentStep + 1}/4
              </span>
              <span className="text-[10px] font-bold text-slate-400">{t(step.captionEn, step.caption)}</span>
            </div>
            <h3 className="mt-4 text-base font-black tracking-[-0.02em] text-slate-900 dark:text-white">
              {t(step.titleEn, step.title)}
            </h3>
            <p className="mt-2 text-[13px] leading-6 text-slate-600 dark:text-slate-300">
              {t(step.descriptionEn, step.description)}
            </p>

            {step.target === "chat" && (
              <blockquote className="mt-3 rounded-xl border-l-2 border-emerald-500 bg-emerald-50/70 px-3 py-2.5 text-[11px] leading-5 text-emerald-900 dark:bg-lime-300/[0.07] dark:text-lime-100">
                “{sampleQuestion}”
              </blockquote>
            )}

            <Button
              type="button"
              className="mt-4 h-10 w-full rounded-xl bg-[#172019] text-xs font-extrabold text-[#c5fb7e] hover:bg-[#263329] dark:bg-lime-300 dark:text-slate-950 dark:hover:bg-lime-200"
              onClick={runNavigationOnlyAction}
            >
              {step.target === "receipt" ? <ShieldCheck className="mr-2 h-4 w-4" /> : <ArrowRight className="mr-2 h-4 w-4" />}
              {t(step.actionLabelEn, step.actionLabel)}
            </Button>
            <p className="mt-2 text-center text-[9px] leading-4 text-slate-400">
              {t(
                "The guide will close while you complete this action and resume where you left off next time.",
                "Bảng hướng dẫn sẽ thu gọn để bạn thao tác, rồi tiếp tục ở lần mở kế tiếp.",
              )}
            </p>
          </section>

          <section className="mt-4 rounded-2xl bg-[#f0f4ed] p-3.5 dark:bg-white/[0.035]">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-extrabold text-slate-700 dark:text-slate-200">
              <ClipboardCheck className="h-4 w-4 text-emerald-600 dark:text-lime-300" />{" "}
              {t("Workspace checklist", "Kiểm tra nhanh kho dữ liệu")}
            </div>
            <ul className="space-y-2">
              {readinessSteps.map((item) => (
                <li key={item.label} className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${item.ready ? "bg-emerald-600 text-white" : "border border-slate-300 text-transparent dark:border-white/20"}`}>
                    <Check className="h-2.5 w-2.5 stroke-[3]" />
                  </span>
                  {item.label}
                </li>
              ))}
            </ul>
          </section>

          <p className="mt-4 text-center text-[10px] leading-4 text-slate-400">
            {t(
              "The guide only remembers your current step in this tab. It never stores API keys, file names, or wallet data.",
              "Hướng dẫn chỉ lưu bước đang xem trong phiên tab. Không lưu API key, tên tệp hay dữ liệu ví.",
            )}
          </p>
        </div>

        <footer className="flex items-center gap-2 border-t border-[#dde6da] p-4 dark:border-white/[0.08]">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 rounded-xl"
            onClick={() => move({ type: "RESET" })}
            aria-label={t("Restart product tour", "Bắt đầu lại hướng dẫn sản phẩm")}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" className="h-10 flex-1 rounded-xl text-xs font-bold" disabled={state.currentStep === 0} onClick={() => move({ type: "BACK" })}>
            <ArrowLeft className="mr-1.5 h-4 w-4" /> {t("Back", "Quay lại")}
          </Button>
          <Button
            type="button"
            className="h-10 flex-1 rounded-xl bg-emerald-600 text-xs font-extrabold text-white hover:bg-emerald-700"
            onClick={() => {
              if (state.finished) onClose();
              else move({ type: "NEXT" });
            }}
          >
            {state.finished ? t("Close", "Đóng") : state.currentStep === 3 ? t("Finish", "Hoàn tất") : t("Next", "Tiếp")}
            {!state.finished && <ArrowRight className="ml-1.5 h-4 w-4" />}
          </Button>
        </footer>
      </aside>
    </div>
  );
}
