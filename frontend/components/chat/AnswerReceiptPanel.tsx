import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, Download, FileCheck2, FileSearch, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadAnswerReceipt, verifyAnswerReceipt, type AnswerReceiptVerificationReport, type ReceiptCheckStatus } from "@/utils/answerReceipt";
import type { AnswerReceipt, AnswerVerificationLevel } from "@/utils/ragTypes";
import { useLanguage } from "@/i18n";

const levelCopy = (t: (english: string, vietnamese: string) => string): Record<AnswerVerificationLevel, { title: string; short: string; className: string }> => ({
  content_verified: { title: t("Content matched", "Đã đối chiếu nội dung"), short: t("The excerpt was found again in the matching Shelby source.", "Đoạn trích được tìm lại trong đúng tệp nguồn trên Shelby."), className: "text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-300/10 dark:border-emerald-300/20" },
  source_verified: { title: t("Source file matched", "Đã đối chiếu tệp nguồn"), short: t("The source bytes match Shelby; OCR/AI output is not cryptographic proof.", "Tệp gốc khớp Shelby; phần OCR/AI không được coi là bằng chứng mật mã."), className: "text-sky-700 bg-sky-50 border-sky-200 dark:text-sky-300 dark:bg-sky-300/10 dark:border-sky-300/20" },
  indexed_only: { title: t("Local index trail available", "Có dấu vết trong kho trên máy"), short: t("An indexed source exists, but the original file could not be checked again.", "Có nguồn đã lập chỉ mục nhưng chưa thể đối chiếu lại tệp gốc."), className: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-300/10 dark:border-amber-300/20" },
  failed: { title: t("Verification incomplete", "Đối chiếu chưa đạt"), short: t("At least one source no longer matches or could not be fetched.", "Ít nhất một nguồn không còn khớp hoặc không thể tải để kiểm tra."), className: "text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-300/10 dark:border-rose-300/20" },
});

export function AnswerReceiptPanel({ receipt, onClose }: { receipt: AnswerReceipt; onClose: () => void }) {
  const { language, t } = useLanguage();
  const levels = levelCopy(t);
  const overall = levels[receipt.level];
  const receiptFileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [verification, setVerification] = useState<{ fileName: string; report: AnswerReceiptVerificationReport } | null>(null);
  const [verificationBusy, setVerificationBusy] = useState(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')];
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
  }, []);

  const checkFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setVerification({
        fileName: file.name,
        report: {
          valid: false,
          integrityVerified: false,
          authenticated: false,
          compatible: false,
          checks: { schema: "fail", receiptId: "unavailable", envelopeDigest: "unavailable", citations: "unavailable", excerptHashes: "unavailable", declaredContentHashes: "unavailable", evidenceScope: "unavailable", sourceBytes: "unavailable", authenticity: "unavailable" },
          errors: [t("The file exceeds the 2 MB verification limit.", "File lớn hơn giới hạn kiểm tra 2 MB.")],
          warnings: [],
        },
      });
      return;
    }
    setVerificationBusy(true);
    try {
      setVerification({ fileName: file.name, report: await verifyAnswerReceipt(await file.text()) });
    } catch (error) {
      const report = await verifyAnswerReceipt("");
      report.errors = [t(`Unable to read file: ${error instanceof Error ? error.message : String(error)}`, `Không đọc được file: ${error instanceof Error ? error.message : String(error)}`)];
      setVerification({ fileName: file.name, report });
    } finally {
      setVerificationBusy(false);
      if (receiptFileRef.current) receiptFileRef.current.value = "";
    }
  };

  const statusCopy = (status: ReceiptCheckStatus) => status === "pass" ? t("Match", "Khớp") : status === "fail" ? t("Fail", "Sai") : status === "declared_only" ? t("Declared", "Có khai báo") : t("Unavailable", "Không có");
  const checkClass = (status: ReceiptCheckStatus) => status === "pass" ? "text-emerald-700 dark:text-emerald-300" : status === "fail" ? "text-rose-700 dark:text-rose-300" : "text-slate-400";
  const offlineConsistent = verification?.report.valid === true && verification.report.integrityVerified;
  return (
    <aside ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="answer-receipt-title" data-testid="answer-receipt" className="absolute inset-3 z-30 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-emerald-200/70 bg-white/95 shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-3 duration-200 dark:border-emerald-300/10 dark:bg-slate-950/95 sm:left-auto sm:w-[27rem]">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-white/[0.06]">
        <div>
          <h4 id="answer-receipt-title" className="flex items-center gap-2 text-sm font-extrabold text-slate-900 dark:text-white"><FileCheck2 className="h-4 w-4 text-emerald-600" />{t("Answer Receipt", "Phiếu kiểm chứng")}</h4>
          <p className="mt-0.5 text-[11px] text-slate-500">{t("A reproducible trail captured when the answer was created", "Đối chiếu câu trả lời với nguồn tại thời điểm tạo")}</p>
        </div>
        <Button ref={closeButtonRef} variant="ghost" size="icon" className="h-9 w-9" onClick={onClose} aria-label={t("Close Answer Receipt", "Đóng Phiếu kiểm chứng")}><X className="h-4 w-4" /></Button>
      </div>
      <div className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <section data-testid="receipt-overall-level" className={`rounded-xl border p-3 ${overall.className}`}>
          <div className="flex items-center gap-2 text-xs font-extrabold">{receipt.level === "failed" ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}{overall.title}</div>
          <p className="mt-1 text-[11px] leading-5 opacity-80">{overall.short}</p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
          <p className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">{t("Question", "Câu hỏi")}</p>
          <p className="mt-1 text-xs leading-5 text-slate-700 dark:text-slate-200">{receipt.question}</p>
        </section>

        <div className="space-y-2">
          {receipt.sources.map((source) => {
            const copy = levels[source.level];
            return (
              <section key={`${source.citationId}:${source.source}:${source.pageNumber}`} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-white/[0.025]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="truncate text-xs font-extrabold text-slate-800 dark:text-slate-100">[{source.citationId}] {source.displayName}</p><p className="mt-0.5 text-[11px] text-slate-400">{t("Page", "Trang")} {source.pageNumber || "—"}</p></div>
                  <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-extrabold ${copy.className}`}>{copy.title}</span>
                </div>
                <p className="mt-2 border-l-2 border-slate-200 pl-2 text-[11px] leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-300">{language === "vi" ? source.explanation : copy.short}</p>
                <details className="group mt-2 border-t border-slate-100 pt-2 dark:border-white/[0.05]">
                  <summary className="flex cursor-pointer items-center justify-between text-[10px] font-bold text-slate-400"><span>{t("Technical details", "Chi tiết kỹ thuật")}</span><ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" /></summary>
                  <dl className="mt-2 grid gap-1.5 break-all font-mono text-[9px] leading-4 text-slate-500">
                    <div><dt className="font-sans font-bold">{t("File fingerprint at indexing", "Mã tệp khi tạo RAG")}</dt><dd>{source.indexedBlobMerkleRoot ?? t("Unavailable", "Chưa có")}</dd></div>
                    <div><dt className="font-sans font-bold">{t("Recomputed file fingerprint", "Mã tệp vừa tính lại")}</dt><dd>{source.recomputedBlobMerkleRoot ?? t("Unavailable", "Chưa có")}</dd></div>
                  </dl>
                </details>
              </section>
            );
          })}
        </div>

        <p className="rounded-lg bg-slate-50 p-2.5 text-[11px] leading-5 text-slate-500 dark:bg-white/[0.025]">
          {language === "vi"
            ? receipt.note
            : "This receipt records source checks performed at creation time. It does not authenticate the author or prove every AI inference is correct."}
        </p>

        {verification ? (
          <section data-testid="receipt-offline-report" className={`rounded-xl border p-3 ${offlineConsistent ? "border-emerald-200 bg-emerald-50/70 dark:border-emerald-300/15 dark:bg-emerald-300/[0.06]" : verification.report.valid ? "border-amber-200 bg-amber-50/70 dark:border-amber-300/15 dark:bg-amber-300/[0.06]" : "border-rose-200 bg-rose-50/70 dark:border-rose-300/15 dark:bg-rose-300/[0.06]"}`}>
            <div className="flex items-start gap-2">
              {offlineConsistent ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <ShieldAlert className={`mt-0.5 h-4 w-4 shrink-0 ${verification.report.valid ? "text-amber-600" : "text-rose-600"}`} />}
              <div className="min-w-0">
                <p className="truncate text-[11px] font-extrabold text-slate-800 dark:text-slate-100">{verification.fileName}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-slate-600 dark:text-slate-300">
                  {offlineConsistent
                    ? t("Checksum matched; structure and internal links are consistent.", "Checksum khớp; cấu trúc và các liên kết nội bộ nhất quán.")
                    : verification.report.valid
                      ? t("The legacy structure is valid, but it has no checksum for the full payload.", "Cấu trúc bản cũ hợp lệ, nhưng chưa có checksum cho toàn payload.")
                      : t("The structure or internal checksum does not match.", "Cấu trúc hoặc checksum nội bộ không khớp.")}
                </p>
              </div>
            </div>
            <div className="mt-2.5 grid grid-cols-4 gap-1.5 rounded-lg bg-white/60 p-2 dark:bg-black/10">
              {([
                [t("Receipt ID", "Mã phiếu"), verification.report.checks.receiptId],
                ["Checksum", verification.report.checks.envelopeDigest],
                [t("Sources", "Nguồn"), verification.report.checks.citations],
                [t("Excerpts", "Đoạn trích"), verification.report.checks.excerptHashes],
              ] as Array<[string, ReceiptCheckStatus]>).map(([label, status]) => (
                <div key={label} className="text-center">
                  <p className={`text-[9px] font-extrabold ${checkClass(status)}`}>{statusCopy(status)}</p>
                  <p className="mt-0.5 text-[9px] text-slate-400">{label}</p>
                </div>
              ))}
            </div>
            {verification.report.errors.length ? <p className="mt-2 text-[9px] leading-4 text-rose-700 dark:text-rose-300">{language === "vi" ? verification.report.errors[0] : "The receipt did not pass one or more structural or checksum checks."}</p> : null}
            <p className="mt-2 text-[9px] leading-4 text-slate-400">{t(
              "Offline verification only checks that the current checksum and structure agree. Checksums can be recomputed, so this does not prove the file was never edited, authenticate its author, or refetch sources from Shelby.",
              "Kiểm tra ngoại tuyến chỉ xác nhận checksum và cấu trúc hiện tại nhất quán. Checksum có thể được tính lại, nên kết quả không chứng minh file chưa từng bị sửa, không xác thực người tạo và không tải lại nguồn từ Shelby.",
            )}</p>
          </section>
        ) : null}
      </div>
      <div className="border-t border-slate-100 p-3 dark:border-white/[0.06]">
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-10 rounded-xl bg-[#172019] text-[11px] font-extrabold text-[#c5fb7e] hover:bg-[#243027] dark:bg-lime-300 dark:text-slate-950" onClick={() => void downloadAnswerReceipt(receipt)}><Download className="mr-1.5 h-3.5 w-3.5" />{t("Download receipt", "Tải phiếu")}</Button>
          <Button variant="outline" className="h-10 rounded-xl text-[11px] font-extrabold" disabled={verificationBusy} onClick={() => receiptFileRef.current?.click()}><FileSearch className="mr-1.5 h-3.5 w-3.5" />{verificationBusy ? t("Checking…", "Đang kiểm tra…") : t("Check a file", "Kiểm tra file")}</Button>
          <input ref={receiptFileRef} type="file" accept="application/json,.json" className="hidden" aria-label={t("Choose an Answer Receipt to verify", "Chọn Phiếu kiểm chứng để kiểm tra")} onChange={(event) => void checkFile(event.target.files?.[0])} />
        </div>
        <p className="mt-2 flex items-center justify-center gap-1 text-[9px] text-slate-400"><CheckCircle2 className="h-3 w-3" />{t("Receipt ID", "Mã phiếu")}: {receipt.id.slice(0, 16)}…</p>
      </div>
    </aside>
  );
}
