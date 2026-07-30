import { CheckCircle2, ScanText, Square } from "lucide-react";
import type { CSSProperties } from "react";
import { useLanguage } from "@/i18n";

interface IndexingStepperProps {
  indexingAll: boolean;
  indexProgress: { done: number; total: number; currentName: string; stage?: string } | null;
  indexLogs: { at: number; text: string }[];
  onCancel?: () => void;
}

const MATRIX_COLUMNS = [
  "01001SHELBY10110RAG0010110",
  "11010BLOB00101APTOS1010011",
  "00101VECTOR11010DATA010110",
  "10110CHUNK01001PROOF110010",
  "01101INDEX10110QUERY001011",
  "10010MERKLE01101RAG1101001",
  "01011SHELBY10010BLOB011010",
  "11100DATA01011PROOF1001010",
  "00110CHUNK11100INDEX010110",
  "10101QUERY00110APTOS111000",
];

function ratioFromText(text: string): number | undefined {
  const percent = [...text.matchAll(/(\d{1,3})\s*%/g)].at(-1);
  if (percent) return Math.max(0, Math.min(1, Number(percent[1]) / 100));
  const ratios = [...text.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  const ratio = ratios.at(-1);
  if (!ratio || Number(ratio[2]) <= 0) return undefined;
  return Math.max(0, Math.min(1, Number(ratio[1]) / Number(ratio[2])));
}

/** An honest UI estimate assembled from known pipeline boundaries and real subtask ratios. */
function fileProgressFromStage(stage: string): number {
  const normalized = stage.toLocaleLowerCase("vi-VN");
  const ratio = ratioFromText(stage);
  if (/hoàn tất|đã cập nhật/.test(normalized)) return 100;
  if (/commit/.test(normalized)) return 98;
  if (/embedding/.test(normalized)) return Math.round(76 + (ratio ?? 0.2) * 20);
  if (/ocr/.test(normalized)) return Math.round(48 + (ratio ?? 0.15) * 27);
  if (/đọc text pdf|đọc nội dung|đọc json|đọc văn bản/.test(normalized)) return Math.round(31 + (ratio ?? 0.15) * 17);
  if (/phân tích video/.test(normalized)) return 55;
  if (/phân tích ảnh|nhập gói rag|nhận diện nội dung/.test(normalized)) return 30;
  if (/tải blob|xác thực ví và tải/.test(normalized)) return 18;
  if (/kiểm tra quyền/.test(normalized)) return 7;
  if (/chuẩn bị/.test(normalized)) return 2;
  return 4;
}

export function IndexingStepper({
  indexingAll,
  indexProgress,
  indexLogs,
  onCancel,
}: IndexingStepperProps) {
  const { language, t } = useLanguage();
  if (!indexingAll || !indexProgress) return null;

  const stages = [
    { key: "policy", label: t("Check access", "Kiểm tra quyền"), match: ["Kiểm tra quyền truy cập"] },
    { key: "download", label: t("Load data", "Tải dữ liệu"), match: ["Xác thực ví và tải blob", "Tải blob"] },
    { key: "ocr", label: t("Read content", "Đọc nội dung"), match: ["Nhận diện nội dung", "Đọc ", "OCR", "Phân tích ảnh", "Phân tích video", "Nhập gói RAG portable"] },
    { key: "embeddings", label: t("Build index", "Lập chỉ mục"), match: ["embedding"] },
    { key: "commit", label: t("Complete", "Hoàn tất"), match: ["Commit index", "Hoàn tất"] }
  ];

  const currentStage = indexProgress.stage ?? "";
  let activeIndex = stages.findIndex((stage) => stage.match.some((match) => currentStage.toLowerCase().includes(match.toLowerCase())));
  if (activeIndex === -1) {
    if (currentStage === "Chuẩn bị") activeIndex = 0;
    else if (currentStage === "Hoàn tất") activeIndex = 4;
    else activeIndex = 0;
  }
  const currentFilePercent = fileProgressFromStage(currentStage);
  const rawBatchPercent = indexProgress.total > 0
    ? ((Math.min(indexProgress.done, indexProgress.total) + (indexProgress.done < indexProgress.total ? currentFilePercent / 100 : 0)) / indexProgress.total) * 100
    : 0;
  const batchPercent = rawBatchPercent > 0 ? Math.min(100, Math.max(1, Math.round(rawBatchPercent))) : 0;

  return (
    <div className="rounded-2xl border border-[#d9e1d6] bg-gradient-to-br from-[#f8faf5] to-white p-4 shadow-[0_10px_30px_rgba(43,61,47,.05)] dark:border-white/10 dark:from-white/[0.045] dark:to-white/[0.02]">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2.5 text-[15px] font-bold tracking-[-0.015em] text-slate-900 dark:text-slate-100">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#172019] text-[#c5fb7e] dark:bg-lime-300 dark:text-slate-950">
              <ScanText className="h-4 w-4" />
            </span>
            {t("Building RAG on this device", "Đang tạo RAG trên thiết bị")}
          </h4>
          <p className="ml-10 mt-0.5 truncate text-[12px] leading-5 text-slate-500 dark:text-slate-400">
            {t("Processing", "Đang xử lý")} <span className="font-semibold text-slate-700 dark:text-slate-300">{indexProgress.currentName}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="rounded-full border border-[#dce6d8] bg-white px-3 py-1.5 text-[11px] font-bold text-[#315f3e] shadow-sm dark:border-white/10 dark:bg-white/[0.04] dark:text-lime-300">
            <span className="font-extrabold tabular-nums">{batchPercent}%</span>
            <span className="mx-1.5 text-slate-300 dark:text-white/15">·</span>
            {t("File", "Tệp")} {Math.min(indexProgress.done + 1, indexProgress.total)} / {indexProgress.total}
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-rose-200 bg-white px-3 text-[11px] font-bold text-rose-700 shadow-sm transition-colors hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 dark:border-rose-300/20 dark:bg-white/[0.04] dark:text-rose-300 dark:hover:bg-rose-300/10"
              aria-label={t("Stop building RAG", "Dừng tạo RAG")}
            >
              <Square className="h-3 w-3 fill-current" /> {t("Stop", "Dừng")}
            </button>
          )}
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-[#e1e8de] bg-white/80 px-3 py-2 dark:border-white/[0.06] dark:bg-black/15">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold text-slate-500 dark:text-slate-400">
          <span>{t("Estimated file progress", "Tiến độ ước tính của tệp")}</span>
          <span className="tabular-nums text-[#315f3e] dark:text-lime-300">{currentFilePercent}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#e9eee6] dark:bg-white/[0.07]">
          <div className="rag-progress-fill h-full rounded-full bg-gradient-to-r from-emerald-600 via-lime-500 to-lime-300 transition-[width] duration-500 ease-out" style={{ width: `${currentFilePercent}%` }} />
        </div>
      </div>

      <div className="relative mb-3 flex items-start justify-between px-1">
        <div className="absolute left-0 right-0 top-3.5 z-0 h-0.5 -translate-y-1/2 bg-slate-200 dark:bg-slate-800" />
        <div
          className="absolute left-0 top-3.5 z-0 h-0.5 -translate-y-1/2 bg-gradient-to-r from-emerald-600 to-lime-400 transition-all duration-500 dark:from-emerald-400 dark:to-lime-300"
          style={{ width: `${(activeIndex / (stages.length - 1)) * 100}%` }}
        />

        {stages.map((step, idx) => {
          const isCompleted = idx < activeIndex;
          const isActive = idx === activeIndex;

          return (
            <div key={step.key} className="flex flex-col items-center z-10 relative">
              <div
                aria-current={isActive ? "step" : undefined}
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-bold transition-[background-color,border-color,color,box-shadow] duration-300 ${
                  isCompleted
                    ? "border-emerald-600 bg-emerald-600 text-white shadow-sm dark:border-emerald-400 dark:bg-emerald-400 dark:text-slate-950"
                    : isActive
                      ? "rag-progress-orbit border-[#52735a] bg-[#eef7e8] text-[#315f3e] shadow-[0_0_0_4px_rgba(132,204,102,.18)] dark:border-lime-300 dark:bg-lime-300/10 dark:text-lime-300"
                      : "border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle2 className="h-4 w-4 stroke-[3px]" />
                ) : isActive ? (
                  <span className="h-2 w-2 rounded-full bg-current" />
                ) : (
                  idx + 1
                )}
              </div>
              <span className={`mt-1.5 text-[10px] font-semibold tracking-[-0.01em] ${
                isActive
                  ? "text-[#315f3e] dark:text-lime-300"
                  : isCompleted
                    ? "text-slate-700 dark:text-slate-300"
                    : "text-slate-400 dark:text-slate-500"
              }`}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="matrix-console relative mt-3 overflow-hidden rounded-xl border border-emerald-900/10 px-3 py-2.5 dark:border-lime-300/10">
        <div className="matrix-rain" aria-hidden="true">
          {MATRIX_COLUMNS.map((column, index) => (
            <span
              key={`${column}:${index}`}
              style={{ "--matrix-delay": `${-index * 1.15}s`, "--matrix-duration": `${10 + (index % 4) * 2.3}s` } as CSSProperties}
            >
              {column}
            </span>
          ))}
        </div>
        <div className="custom-scrollbar relative z-10 max-h-[88px] space-y-1.5 overflow-y-auto pr-1">
          {indexLogs.map((log, index) => (
            <div key={`${log.at}:${index}`} className="flex justify-between text-[11px] leading-4 text-slate-600 dark:text-slate-300">
              <span className="truncate">{log.text}</span>
              <span className="ml-3 flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-emerald-950/[0.06] px-1.5 py-0.5 text-[9px] font-extrabold tabular-nums text-emerald-800 dark:bg-lime-300/10 dark:text-lime-300" title={t("Estimated file progress", "Tiến độ ước tính của tệp")}>{fileProgressFromStage(log.text)}%</span>
                <time className="text-slate-400 dark:text-slate-500">{new Date(log.at).toLocaleTimeString(language === "vi" ? "vi-VN" : "en-US", { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
