import { Activity, ChevronDown, Cloud, Database, ShieldCheck, Zap } from "lucide-react";
import type { HotRagProofSnapshot } from "@/utils/hotRagProof";
import { useLanguage } from "@/i18n";

interface LiveProofMeterProps {
  proof: HotRagProofSnapshot;
}

const formatBytes = (bytes: number | null, unavailable: string) => {
  if (bytes === null) return unavailable;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

const formatRange = (start: number | null, end: number | null, locale: string, standalone: string) => {
  if (start === null || end === null) return standalone;
  return `${start.toLocaleString(locale)}–${end.toLocaleString(locale)}`;
};

export function LiveProofMeter({ proof }: LiveProofMeterProps) {
  const { language, t } = useLanguage();
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";
  const bytes = (value: number | null) => formatBytes(value, t("Not measured", "Chưa đo được"));
  const { capsule, retrieval, reads } = proof;
  const measuredRatio = retrieval.capsuleReadRatio;
  const readPercent = measuredRatio === null ? null : Math.min(100, measuredRatio * 100);
  const savedPercent = readPercent === null ? null : Math.max(0, Math.round(100 - readPercent));
  const isCacheOnly = retrieval.cacheHits > 0 && retrieval.cacheMisses === 0;
  const modeLabel = retrieval.rangeReads > 0 ? t("Fetched only the required ranges", "Chỉ đọc đúng phần cần thiết") : t("Fetched the relevant parts", "Đọc phần liên quan");
  const readPercentLabel = readPercent === null
    ? null
    : readPercent > 0 && readPercent < 0.1
      ? `< 0${language === "vi" ? "," : "."}1%`
      : `${readPercent.toLocaleString(numberLocale, { maximumFractionDigits: readPercent < 10 ? 1 : 0 })}%`;
  const headline = isCacheOnly
    ? t("No additional download", "Không tải thêm dữ liệu")
    : readPercentLabel && readPercent !== null
      ? `${readPercent >= 100 ? t("Fetched", "Đã tải") : t("Fetched only", "Chỉ tải")} ${readPercentLabel} ${t("of the RAG", "kho RAG")}`
      : t(`${retrieval.uniqueShards} relevant parts fetched`, `${retrieval.uniqueShards} phần liên quan đã được đọc`);

  return (
    <details className="group mt-2.5 overflow-hidden rounded-xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/80 via-white/70 to-lime-50/60 text-xs shadow-[0_8px_24px_rgba(16,185,129,0.06)] dark:border-emerald-300/15 dark:from-emerald-400/[0.08] dark:via-slate-950/30 dark:to-lime-300/[0.04]">
      <summary className="cursor-pointer list-none p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#172019] text-[#c5fb7e] dark:bg-lime-300 dark:text-[#101713]">
              <Activity className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-extrabold text-slate-800 dark:text-slate-100">{t("Data fetched directly from Shelby", "Dữ liệu đọc trực tiếp từ Shelby")}</span>
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.06em] text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">{t("Measured", "Số liệu thật")}</span>
              </div>
              <p className="mt-1 text-base font-black tracking-[-0.025em] text-emerald-800 dark:text-lime-300">{headline}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                {isCacheOnly
                  ? t(`${bytes(retrieval.cacheBytesReused)} reused from cache`, `${bytes(retrieval.cacheBytesReused)} được dùng lại từ bộ nhớ tạm`)
                  : retrieval.networkBytesRead === null
                    ? `${modeLabel} · ${t("Shelby did not report enough byte data to calculate a percentage", "Shelby chưa trả đủ số byte để tính phần trăm")}`
                    : t(
                      `${bytes(retrieval.networkBytesRead)} of ${bytes(capsule.totalBytes)}${savedPercent === null ? "" : ` · avoided ${savedPercent}%`}`,
                      `${bytes(retrieval.networkBytesRead)} trên tổng ${bytes(capsule.totalBytes)}${savedPercent === null ? "" : ` · tránh tải ${savedPercent}%`}`,
                    )}
              </p>
            </div>
          </div>
          <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
        </div>

        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-emerald-950/10 dark:bg-white/10" aria-label={readPercent === null ? t("Not enough data to measure the download ratio", "Chưa đo đủ tỷ lệ dữ liệu tải") : t(`Fetched ${readPercent.toFixed(1)}% of the RAG`, `Đã tải ${readPercent.toFixed(1)}% bản RAG`)}>
          <div
            className="h-full rounded-full bg-gradient-to-r from-lime-400 to-emerald-500 transition-[width] duration-500"
            style={{ width: readPercent === null ? "0%" : `${readPercent}%`, minWidth: readPercent !== null && readPercent > 0 ? 2 : 0 }}
          />
        </div>

        <div className="mt-2 grid grid-cols-3 gap-1.5 text-[11px]">
          <span className="rounded-md bg-white/70 px-2 py-1 text-slate-600 dark:bg-white/[0.04] dark:text-slate-300"><Zap className="mr-1 inline h-3 w-3 text-amber-500" />{Math.round(retrieval.latencyMs)} ms</span>
          <span className="rounded-md bg-white/70 px-2 py-1 text-slate-600 dark:bg-white/[0.04] dark:text-slate-300"><Database className="mr-1 inline h-3 w-3 text-emerald-600" />{retrieval.uniqueShards} {t("parts", "phần")}</span>
          <span className="rounded-md bg-white/70 px-2 py-1 text-slate-600 dark:bg-white/[0.04] dark:text-slate-300"><Cloud className="mr-1 inline h-3 w-3 text-sky-500" />{retrieval.cacheHits} {t("reused", "dùng lại")}</span>
        </div>
      </summary>

      <div className="border-t border-emerald-200/60 px-3 pb-3 pt-2.5 dark:border-emerald-300/10">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3 w-3" />
          {t("Measurements recorded for this query", "Số liệu được ghi trong lần tra cứu này")}
        </div>
        <div className="space-y-1.5">
          {reads.map((read) => (
            <div key={`${read.blobName}:${read.shardIndex}`} className="grid grid-cols-[1fr_auto] gap-2 rounded-lg bg-white/70 px-2.5 py-2 dark:bg-black/15">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-bold text-slate-700 dark:text-slate-200">{t("Part", "Phần")} {read.shardIndex + 1} · {read.cacheHit ? t("cache", "bộ nhớ tạm") : read.readKind === "range" ? t("range read", "đọc theo vùng") : t("standalone blob", "đọc tệp riêng")}</p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-400">byte {formatRange(read.rangeStart, read.rangeEnd, numberLocale, t("standalone blob", "blob riêng"))}</p>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{read.cacheHit ? t("0 B network", "0 B mạng") : bytes(read.networkBytesRead)}</p>
                <p className="mt-0.5 text-[10px] text-slate-400">{Math.round(read.latencyMs)} ms</p>
              </div>
            </div>
          ))}
        </div>
        {proof.bootstrap.networkBytesRead !== null ? (
          <p className="mt-2 text-[10px] leading-4 text-slate-400">{t("Initial catalog", "Mục lục khởi tạo")}: {bytes(proof.bootstrap.networkBytesRead)} · {t("fetched only when the RAG is opened.", "chỉ tải khi mở bản RAG.")}</p>
        ) : null}
      </div>
    </details>
  );
}
