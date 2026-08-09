import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, UploadCloud, FileText } from "lucide-react";
import type { ShelbyUploadProgress } from "@/hooks/useShelby";
import { useLanguage } from "@/i18n";

interface UploadZoneProps {
  account: any;
  uploading: boolean;
  uploadProgress: ShelbyUploadProgress | null;
  uploadFiles: (files: File[], title?: string) => Promise<void>;
}

export function UploadZone({
  account,
  uploading,
  uploadProgress,
  uploadFiles,
}: UploadZoneProps) {
  const { t } = useLanguage();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const progressPercent = uploadProgress?.totalBytes
    ? Math.min(100, Math.round(uploadProgress.completedBytes / uploadProgress.totalBytes * 100))
    : 0;
  const progressLabel = uploadProgress ? ({
    commitments: t("Preparing and verifying data", "Đang chuẩn bị và kiểm tra dữ liệu"),
    registering: t("Registering the file on Aptos", "Đang đăng ký tệp trên Aptos"),
    confirming: t("Confirming the transaction", "Đang xác nhận giao dịch"),
    uploading: t("Uploading content to Shelby", "Đang tải nội dung lên Shelby"),
    committing: t("Finalizing this blob", "Đang hoàn tất blob này"),
    done: t("Complete", "Hoàn tất"),
  } as const)[uploadProgress.phase] : "";

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (uploading) return;
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (uploading) return;
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setSelectedFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (uploading) return;
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const handleUploadClick = async () => {
    try {
      await uploadFiles(selectedFiles);
      setSelectedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch {
      // already toasted in hook
    }
  };

  return (
    <div className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out">
      <div
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={(event) => {
          if (uploading) return;
          if ((event.target as HTMLElement).closest("button")) return;
          fileInputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (uploading) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={uploading ? -1 : 0}
        aria-disabled={uploading}
        aria-label={t("Choose files to upload to Shelby", "Chọn tệp để tải lên Shelby")}
        className={`drag-drop-zone flex flex-col items-center justify-center rounded-xl border border-dashed p-7 text-center transition-all duration-200 ${dragActive ? 'scale-[1.01] border-lime-500 bg-lime-50 shadow-sm dark:border-lime-300/40 dark:bg-lime-300/[0.05]' : 'border-[#ccd4c9] bg-[#f7f8f4] hover:border-[#8aa782] hover:bg-[#f1f5ed] dark:border-white/10 dark:bg-black/10 dark:hover:border-lime-300/25'}`}
      >
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#e7f4dc] to-[#c5f5a8] text-[#376d3f] shadow-sm dark:from-lime-300/[0.15] dark:to-lime-300/[0.05] dark:text-lime-300 relative glow-border">
          <UploadCloud className="h-6 w-6 relative z-10" />
        </div>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
          {t("Drop documents here or click to choose files", "Kéo thả tài liệu vào đây hoặc nhấp chọn tệp")}
        </p>
        <p className="text-xs text-slate-400 mt-1">{t("Your files are stored on Shelby decentralized storage", "Tệp của bạn được lưu trên mạng lưu trữ phi tập trung Shelby")}</p>
        <input
          type="file"
          multiple
          disabled={uploading}
          onChange={handleFileSelect}
          ref={fileInputRef}
          className="hidden"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 border-[#d8ded5] bg-[#fdfefa] hover:bg-[#edf1ea] dark:border-white/10 dark:bg-white/[0.02] dark:hover:bg-white/[0.06]"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {t("Choose files", "Chọn tệp")}
        </Button>
      </div>

      {selectedFiles.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3.5 dark:border-white/10 dark:bg-slate-950/20">
          <p className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">{t(`Selected files (${selectedFiles.length}):`, `Tệp đã chọn (${selectedFiles.length}):`)}</p>
          <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
            {selectedFiles.map((file, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 p-2 rounded-lg border border-slate-100 dark:border-white/5 group hover-lift">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`h-6 w-6 rounded flex items-center justify-center shrink-0 ${file.type.includes('pdf') ? 'bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400' : 'bg-violet-50 text-violet-500 dark:bg-violet-500/10 dark:text-violet-400'}`}>
                     <FileText className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="truncate font-medium">{file.name}</span>
                    <span className="text-[10px] text-slate-400">{(file.size / 1024).toFixed(1)} KB</span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 w-10 p-0 text-slate-400 opacity-100 transition-opacity hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 rounded-full sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                  onClick={() => setSelectedFiles(prev => prev.filter((_, i) => i !== idx))}
                  disabled={uploading}
                  aria-label={t(`Remove ${file.name}`, `Bỏ chọn ${file.name}`)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-2.5 rounded-lg border border-amber-200/70 bg-amber-50/70 px-2.5 py-2 text-[11px] leading-5 text-amber-900 dark:border-amber-300/10 dark:bg-amber-300/[0.05] dark:text-amber-100">
            {t(
              `Your wallet will ask once to register this batch, then once per new blob to finalize it (${selectedFiles.length + 1} signatures at most).`,
              `Ví sẽ yêu cầu ký 1 lần để đăng ký cả lượt, sau đó 1 lần cho mỗi blob mới để hoàn tất (tối đa ${selectedFiles.length + 1} chữ ký).`,
            )}
          </p>
        </div>
      )}

      <Button
        className="w-full rounded-xl bg-[#172019] py-2.5 font-bold text-[#c5fb7e] shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#263029] dark:bg-lime-300 dark:text-slate-950 dark:hover:bg-lime-200"
        onClick={handleUploadClick}
        disabled={uploading || selectedFiles.length === 0 || !account}
      >
        {uploading ? (
          <><UploadCloud className="mr-2 h-4 w-4" />{t("Uploading files to Shelby…", "Đang tải tệp lên Shelby…")}</>
        ) : (
          <>{t("Upload to Shelby", "Tải lên Shelby")}</>
        )}
      </Button>

      {uploadProgress && (
        <div className="rounded-xl bg-[#eef3e9] p-3 dark:bg-lime-300/[0.045] relative overflow-hidden" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-[11px] font-semibold text-slate-700 dark:text-slate-300 relative z-10">
            <span className="flex truncate items-center gap-1.5"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />{progressLabel}{uploadProgress.fileName ? ` · ${uploadProgress.fileName}` : ""}</span>
            <span className="shrink-0 font-mono">{progressPercent}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10 relative z-10" role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
            <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-lime-400 transition-[width] duration-200 dark:from-emerald-400 dark:to-lime-300 relative" style={{ width: `${progressPercent}%` }}>
              <div className="absolute inset-0 shimmer" />
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
