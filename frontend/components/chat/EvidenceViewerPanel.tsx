import { Button } from "@/components/ui/button";
import { ChevronDown, Cloud, Database, Fingerprint, ShieldCheck, X } from "lucide-react";
import type { RetrievalResult } from "@/utils/ragTypes";
import { useLanguage } from "@/i18n";

export interface EvidenceViewerPanelProps {
  source: RetrievalResult | null;
  onClose: () => void;
  visualPageText: string;
}

const shortProof = (value: string | undefined, unavailable: string) =>
  value ? (value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value) : unavailable;

const formatBytes = (value: number | undefined, unavailable: string) =>
  value === undefined
    ? unavailable
    : value < 1024
      ? `${value} B`
      : value < 1024 ** 2
        ? `${(value / 1024).toFixed(1)} KB`
        : `${(value / 1024 ** 2).toFixed(1)} MB`;

function renderHighlightedText(fullText: string, excerpt: string) {
  if (!fullText) return excerpt;
  const cleanExcerpt = excerpt.trim();
  const index = fullText.indexOf(cleanExcerpt);
  if (index === -1) return fullText;
  const before = fullText.slice(0, index);
  const match = fullText.slice(index, index + cleanExcerpt.length);
  const after = fullText.slice(index + cleanExcerpt.length);
  return (
    <>
      {before}
      <mark className="rounded bg-lime-200/80 px-1 py-0.5 text-slate-900 dark:bg-lime-400/40 dark:text-lime-100">
        {match}
      </mark>
      {after}
    </>
  );
}

export function EvidenceViewerPanel({
  source,
  onClose,
  visualPageText,
}: EvidenceViewerPanelProps) {
  const { language, t } = useLanguage();
  if (!source) return null;

  const unavailable = t("Unavailable", "Chưa có");
  const accessLabel = (value?: NonNullable<RetrievalResult["provenance"]>["accessTag"]) =>
    ({
      public: t("Public", "Công khai"),
      allowlist: t("Allowlist", "Danh sách cho phép"),
      purchasable: t("Access required", "Cần quyền truy cập"),
      time_lock: t("Time lock", "Khóa thời gian"),
    }[String(value)] ?? t("Unknown", "Không rõ"));

  const extractionLabel = (value?: string) =>
    ({
      text_layer: t("Original text", "Văn bản gốc"),
      local_ocr: t("On-device OCR", "OCR trên thiết bị"),
      cloud_vision: t("AI image reading", "AI đọc hình ảnh"),
      cloud_video: t("AI video reading", "AI đọc video"),
      mixed: t("Text + OCR", "Văn bản + OCR"),
    }[value ?? ""] ?? t("Unknown", "Không rõ"));

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="answer-proof-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      data-testid="answer-proof"
      className="absolute bottom-3 right-3 top-3 z-20 flex min-h-[280px] w-[min(24rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-emerald-200/70 bg-white/95 shadow-xl backdrop-blur-md animate-in slide-in-from-right duration-200 dark:border-emerald-300/10 dark:bg-slate-950/95"
    >
      <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-emerald-50/80 to-lime-50/30 px-3.5 py-3 dark:border-white/[0.06] dark:from-emerald-300/[0.06] dark:to-transparent">
        <div className="min-w-0">
          <h4
            id="answer-proof-title"
            className="flex items-center gap-1.5 text-xs font-extrabold text-slate-900 dark:text-white"
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            {t("Inspect answer evidence", "Kiểm chứng câu trả lời")}
          </h4>
          <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
            {source.provenance?.blobMerkleRoot
              ? t("Source fingerprint available", "Có mã tệp nguồn để đối chiếu")
              : t(
                  "Local excerpt · re-index to add a source fingerprint",
                  "Đoạn trích trên máy · nạp lại để bổ sung mã tệp",
                )}
          </p>
        </div>
        <Button
          autoFocus
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-slate-400 hover:text-slate-900 dark:hover:text-white"
          onClick={onClose}
        >
          <span className="sr-only">{t("Close evidence viewer", "Đóng trình xem bằng chứng")}</span>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto bg-slate-50/35 p-3 dark:bg-slate-900/20">
        <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
              1 · {t("Excerpt", "Đoạn trích")}
            </span>
            <span className="text-[10px] font-semibold text-slate-400">
              {Math.max(0, Math.min(100, Math.round(source.score * 100)))}% {t("relevant", "liên quan")}
            </span>
          </div>
          <p className="select-text border-l-2 border-emerald-300 pl-3 text-xs leading-5 text-slate-600 dark:border-emerald-500/40 dark:text-slate-300">
            {source.excerpt}
          </p>
          <details className="group mt-2 border-t border-slate-100 pt-2 dark:border-white/[0.05]">
            <summary className="flex cursor-pointer items-center justify-between text-[10px] font-bold text-slate-500">
              <span>{t("View full page context", "Xem ngữ cảnh đầy đủ của trang")}</span>
              <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-2 max-h-52 select-text overflow-y-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[10px] leading-5 text-slate-600 dark:bg-black/20 dark:text-slate-300">
              {renderHighlightedText(visualPageText, source.excerpt)}
            </div>
          </details>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
          <p className="mb-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
            2 · {t("Location in source", "Vị trí trong tài liệu")}
          </p>
          <dl className="grid gap-2 text-[10px]">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-400">{t("Source", "Nguồn")}</dt>
              <dd className="max-w-[70%] break-words text-right font-bold text-slate-700 dark:text-slate-200">
                {source.displayName}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">{t("Location", "Vị trí")}</dt>
              <dd className="font-bold text-slate-700 dark:text-slate-200">
                {source.provenance?.mimeType?.startsWith("video/")
                  ? t("In video", "Trong video")
                  : `${source.pageNumber}/${source.totalPages}`}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">{t("Extraction", "Cách đọc")}</dt>
              <dd className="font-semibold text-slate-700 dark:text-slate-200">
                {extractionLabel(source.provenance?.extractionMethod)}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
              3 · {t("Shelby trail", "Dấu vết trên Shelby")}
            </p>
            {source.provenance?.blobMerkleRoot && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-extrabold text-emerald-700 dark:bg-emerald-300/10 dark:text-emerald-300">
                <Fingerprint className="h-3 w-3" />
                {t("Fingerprint", "Có mã nguồn")}
              </span>
            )}
          </div>
          {source.provenance ? (
            <div className="grid gap-2 text-[10px]">
              <dl className="grid gap-2">
                <div className="flex justify-between gap-3">
                  <dt className="flex items-center gap-1 text-slate-400">
                    <Cloud className="h-3 w-3" />
                    {t("Access", "Quyền truy cập")}
                  </dt>
                  <dd className="font-semibold text-slate-700 dark:text-slate-200">
                    {accessLabel(source.provenance.accessTag)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-400">{t("Read from", "Đã đọc từ")}</dt>
                  <dd className="font-semibold text-slate-700 dark:text-slate-200">
                    {source.provenance.storageMode === "shelby_hot"
                      ? `${t("Shelby on demand", "Shelby theo nhu cầu")}${
                          source.provenance.bytesRead !== undefined
                            ? ` · ${formatBytes(source.provenance.bytesRead, unavailable)}`
                            : ""
                        }`
                      : t("Local index", "Kho trên máy")}
                  </dd>
                </div>
              </dl>
              <details className="group mt-1 border-t border-slate-100 pt-2 dark:border-white/[0.05]">
                <summary className="flex cursor-pointer items-center justify-between text-[10px] font-bold text-slate-500">
                  <span>{t("Technical details", "Chi tiết kỹ thuật")}</span>
                  <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                </summary>
                <dl className="mt-2 grid gap-2 text-[10px]">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-400">{t("Data part ID", "Mã phần dữ liệu")}</dt>
                    <dd
                      className="font-mono font-semibold text-slate-700 dark:text-slate-200"
                      title={source.provenance.chunkId}
                    >
                      {shortProof(source.provenance.chunkId, unavailable)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-400">Blob ID</dt>
                    <dd
                      className="font-mono font-semibold text-slate-700 dark:text-slate-200"
                      title={source.provenance.blobId}
                    >
                      {shortProof(source.provenance.blobId, unavailable)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-400">{t("Size", "Kích thước")}</dt>
                    <dd className="font-semibold text-slate-700 dark:text-slate-200">
                      {formatBytes(source.provenance.blobSize, unavailable)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="flex items-center gap-1 text-slate-400">
                      <Database className="h-3 w-3" />
                      {t("Indexed at", "Tạo chỉ mục lúc")}
                    </dt>
                    <dd className="font-semibold text-slate-700 dark:text-slate-200">
                      {new Date(source.provenance.indexedAt).toLocaleString(
                        language === "vi" ? "vi-VN" : "en-US",
                      )}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-2 dark:bg-black/20">
                    <dt className="text-slate-400">Merkle root</dt>
                    <dd className="mt-1 break-all font-mono text-[9px] leading-4 text-slate-700 dark:text-slate-200">
                      {source.provenance.blobMerkleRoot ??
                        t(
                          "Legacy RAG has no stored verification fingerprint",
                          "Bản RAG cũ chưa lưu mã xác minh",
                        )}
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
          ) : (
            <p className="text-[10px] leading-4 text-slate-500">
              {t(
                "This data was created by an older version. Re-index the document once to add its Blob ID and verification fingerprint.",
                "Dữ liệu này được tạo bằng phiên bản cũ. Nạp lại tài liệu một lần để bổ sung Blob ID và mã xác minh.",
              )}
            </p>
          )}
        </section>
        {source.link && (
          <a
            href={source.link}
            target="_blank"
            rel="noreferrer"
            className="flex h-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-[10px] font-extrabold text-slate-700 hover:border-emerald-300 hover:text-emerald-700 dark:border-white/[0.07] dark:bg-white/[0.025] dark:text-slate-200"
          >
            {t("Open original blob on Shelby", "Mở blob gốc trên Shelby")} ↗
          </a>
        )}
      </div>
    </aside>
  );
}
