import { Archive, Check, Cloud, Download, Fingerprint, HardDrive, RefreshCw, ScanText, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RagMetrics } from "@/utils/ragMetrics";
import { useLanguage } from "@/i18n";

interface MemoryCapsulePanelProps {
  hasLocalRag: boolean;
  hasRemoteRag: boolean;
  remoteStatus: "idle" | "loading" | "ready" | "error";
  remoteError?: string;
  remoteFresh: boolean;
  needsRemoteUpload: boolean;
  pendingCount: number;
  remoteDeltaCount: number;
  remoteBlobName?: string;
  remoteCreatedAtMicros?: number;
  remoteMerkleRoot?: string;
  uploadBlobName: string;
  remotePartCount?: number;
  remoteTotalBytes?: number;
  metrics: RagMetrics;
  localRagBytes: number;
  localRagLarge: boolean;
  syncing: boolean;
  indexing: boolean;
  onRestore: () => void;
  onIndexChanges: () => void;
  onSync: () => void;
  onDownload: () => void;
  onRelease: () => void;
}

function shortHash(value: string | undefined, missingLabel: string) {
  if (!value) return missingLabel;
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function formatBytes(value: number) {
  return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function MemoryCapsulePanel(props: MemoryCapsulePanelProps) {
  const { language, t } = useLanguage();
  const localReady = props.hasLocalRag;
  const capsuleReady = props.hasRemoteRag && props.remoteStatus === "ready";
  const state = props.remoteStatus === "loading" ? t("Checking the Shelby backup", "Đang kiểm tra bản sao trên Shelby")
    : props.remoteStatus === "error" ? t("Unable to read the backup", "Không đọc được bản sao")
      : !localReady && capsuleReady ? t("Ready to chat from Shelby", "Sẵn sàng chat từ Shelby")
        : props.pendingCount ? t(`${props.pendingCount} blobs need updating`, `${props.pendingCount} blob cần cập nhật`)
          : props.needsRemoteUpload ? t("Ready to save to Shelby", "Sẵn sàng lưu lên Shelby")
            : props.remoteFresh ? t("Backup is up to date", "Bản sao đã cập nhật") : t("No backup yet", "Chưa có bản sao");
  const estimatedRegions = Math.max(1, Math.ceil(props.localRagBytes / (384 * 1024)));
  const snapshotFolder = props.uploadBlobName.slice(0, props.uploadBlobName.lastIndexOf("/"));
  const packFileName = props.uploadBlobName.slice(props.uploadBlobName.lastIndexOf("/") + 1);

  return (
    <div data-testid="memory-capsule" className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <section className="relative overflow-hidden rounded-2xl border border-[#dbe3d7] bg-gradient-to-br from-[#f8fbf3] via-white to-[#eff7e7] p-4 dark:border-lime-300/10 dark:from-lime-300/[0.06] dark:via-white/[0.025] dark:to-transparent">
        <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-lime-300/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#172019] text-[#c5fb7e] shadow-sm dark:bg-lime-300 dark:text-slate-950"><Archive className="h-5 w-5" /></div>
            <div>
              <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-extrabold tracking-[-0.02em] text-slate-950 dark:text-white">{t("Knowledge base backup", "Bản sao kho tri thức")}</h3><span className="rounded-full bg-lime-200/70 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-[#315f3e] dark:bg-lime-300/10 dark:text-lime-300">{t("Backup & restore", "Sao lưu & khôi phục")}</span></div>
              <p className="mt-1 max-w-md text-[11px] leading-5 text-slate-500 dark:text-slate-400">{t("Save the processed knowledge base for use on another device. During chat, the app reads only relevant parts from Shelby instead of downloading the entire backup.", "Lưu kho đã xử lý để dùng lại trên thiết bị khác. Khi chat, ứng dụng chỉ đọc những phần liên quan từ Shelby thay vì tải cả kho về máy.")}</p>
            </div>
          </div>
          {props.remoteStatus === "loading" ? <Cloud className="h-4 w-4 shrink-0 text-emerald-600" /> : <ShieldCheck className={`h-5 w-5 shrink-0 ${props.remoteFresh ? "text-emerald-600" : "text-slate-300 dark:text-slate-600"}`} />}
        </div>

        <div className="relative mt-4 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 text-center">
          {[
            { icon: HardDrive, label: t("On device", "Trên máy"), ready: localReady },
            { icon: Fingerprint, label: t("Backup", "Bản sao"), ready: localReady },
            { icon: Cloud, label: t("On Shelby", "Trên Shelby"), ready: capsuleReady },
          ].map(({ icon: Icon, label, ready }, index) => (
            <div key={label} className="contents">
              <div className={`rounded-xl border px-2 py-2 ${ready ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-300/10 dark:bg-emerald-300/[0.045] dark:text-emerald-200" : "border-slate-200 bg-white/70 text-slate-400 dark:border-white/[0.07] dark:bg-white/[0.02]"}`}>
                <div className="mx-auto flex h-6 w-6 items-center justify-center rounded-lg bg-white/80 shadow-sm dark:bg-black/20">{ready ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}</div>
                <span className="mt-1 block text-[10px] font-bold">{label}</span>
              </div>
              {index < 2 && <span className="text-slate-300 dark:text-slate-700">→</span>}
            </div>
          ))}
        </div>
      </section>

      {props.localRagLarge && (
        <section className="rounded-xl border border-amber-200 bg-amber-50/80 p-3.5 dark:border-amber-300/10 dark:bg-amber-300/[0.045]">
          <p className="text-xs font-extrabold text-amber-950 dark:text-amber-100">{t(`The on-device knowledge base uses about ${formatBytes(props.localRagBytes)}`, `Kho trên máy đang dùng khoảng ${formatBytes(props.localRagBytes)}`)}</p>
          <p className="mt-1 text-[10px] leading-4 text-amber-800/80 dark:text-amber-200/70">{t("Above 8 MB, browser search may use more memory. Save it to Shelby; once the backup is current, you can remove the on-device copy and chat will still load relevant parts on demand.", "Từ 8 MB, trình duyệt có thể tốn thêm RAM khi tìm kiếm. Hãy lưu lên Shelby; sau khi trạng thái cập nhật, bạn có thể xóa bản trên máy và chat vẫn tra cứu những phần cần thiết theo nhu cầu.")}</p>
        </section>
      )}

      <section className={`rounded-xl border p-3.5 ${props.remoteFresh ? "border-emerald-200 bg-emerald-50/45 dark:border-emerald-300/10 dark:bg-emerald-300/[0.025]" : "border-slate-200 bg-white/70 dark:border-white/[0.07] dark:bg-white/[0.02]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-xs font-extrabold text-slate-900 dark:text-white">{state}</p><p className="mt-1 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{props.remoteStatus === "error"
            ? t("The app could not read the Shelby backup. Refresh the page or try again later.", "Ứng dụng chưa đọc được bản sao trên Shelby. Hãy làm mới trang hoặc thử lại sau.")
            : props.pendingCount
              ? t(`The current backup is missing ${Math.max(props.pendingCount, props.remoteDeltaCount)} new or changed blobs.`, `Bản sao hiện tại còn thiếu ${Math.max(props.pendingCount, props.remoteDeltaCount)} blob mới hoặc đã thay đổi.`)
              : props.remoteFresh
                ? t("The on-device knowledge base matches the latest Shelby backup.", "Kho trên máy khớp với bản sao mới nhất trên Shelby.")
                : props.needsRemoteUpload
                  ? t("The on-device knowledge base is ready. Save a backup to Shelby for use on another device.", "Kho trên máy đã sẵn sàng. Lưu một bản sao lên Shelby để dùng lại trên thiết bị khác.")
                  : t("Build RAG on this device, then save a backup to Shelby.", "Tạo RAG trên máy trước, sau đó lưu một bản sao lên Shelby.")}</p>{props.remoteStatus === "error" && props.remoteError && <details className="mt-2 text-[9px] text-slate-400"><summary className="cursor-pointer font-bold">{t("Technical details", "Chi tiết kỹ thuật")}</summary><p className="mt-1 break-words font-mono leading-4">{props.remoteError}</p></details>}</div>
          <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${props.remoteFresh ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.12)]" : props.needsRemoteUpload ? "bg-amber-500" : "bg-slate-300 dark:bg-slate-600"}`} />
        </div>
        {props.remoteBlobName && (
          <div className="mt-3 grid gap-2 rounded-lg bg-black/[0.025] p-2.5 text-[10px] text-slate-500 dark:bg-black/20 dark:text-slate-400">
            <div className="flex justify-between gap-3"><span>{t("Shelby backup", "Bản sao trên Shelby")}</span><strong className="truncate text-slate-700 dark:text-slate-200" title={props.remoteBlobName}>{props.remoteBlobName}</strong></div>
            <div className="flex justify-between gap-3"><span>{t("Registered", "Đăng ký lúc")}</span><strong className="text-slate-700 dark:text-slate-200">{props.remoteCreatedAtMicros ? new Date(props.remoteCreatedAtMicros / 1_000).toLocaleString(language === "vi" ? "vi-VN" : "en-US") : t("Unknown", "Không rõ")}</strong></div>
            <div className="flex justify-between gap-3"><span>{t("Verification code", "Mã xác minh")}</span><strong className="font-mono text-slate-700 dark:text-slate-200" title={props.remoteMerkleRoot}>{shortHash(props.remoteMerkleRoot, t("Unavailable", "Chưa có"))}</strong></div>
            {props.remotePartCount !== undefined && <div className="flex justify-between gap-3"><span>{t("Read method", "Cách đọc")}</span><strong className="text-emerald-700 dark:text-emerald-300">{t(`1 blob · ${props.remotePartCount} regions${props.remoteTotalBytes ? ` · ${formatBytes(props.remoteTotalBytes)}` : ""} · range reads`, `1 blob · ${props.remotePartCount} vùng${props.remoteTotalBytes ? ` · ${formatBytes(props.remoteTotalBytes)}` : ""} · đọc từng đoạn`)}</strong></div>}
          </div>
        )}
      </section>

      <section className="grid grid-cols-4 gap-2">
        {[[t("Documents", "Tài liệu"), props.metrics.documents], [t("Pages", "Trang"), props.metrics.pages], ["Chunks", props.metrics.chunks], [t("Coverage", "Độ phủ"), props.metrics.textCoverage === undefined ? "—" : `${Math.round(props.metrics.textCoverage * 100)}%`]].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-slate-200 bg-white/70 p-2.5 text-center dark:border-white/[0.07] dark:bg-white/[0.02]"><strong className="block text-sm text-slate-900 dark:text-white">{value}</strong><span className="mt-0.5 block text-[9px] font-semibold text-slate-400">{label}</span></div>
        ))}
      </section>

      <section className="grid gap-2">
        {!localReady && capsuleReady && <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-[10px] leading-4 text-emerald-900 dark:border-emerald-300/10 dark:bg-emerald-300/[0.04] dark:text-emerald-100"><strong className="block text-xs">{t("Direct lookup from Shelby is enabled", "Đã bật tra cứu trực tiếp từ Shelby")}</strong><span>{t("Each question downloads only a few relevant parts and keeps them briefly in memory. Save the full knowledge base to this device only when you need offline access or editing.", "Mỗi câu hỏi chỉ tải vài phần phù hợp và giữ tạm trong bộ nhớ. Bạn chỉ cần lưu cả kho về máy khi muốn dùng offline hoặc chỉnh sửa.")}</span></div>}
        {!localReady && capsuleReady && <Button variant="outline" className="h-10 rounded-xl text-xs font-extrabold" disabled={props.indexing} onClick={props.onRestore}><Download className="mr-2 h-4 w-4" />{props.indexing ? t("Saving to this device…", "Đang lưu về máy…") : t("Save a copy to this device (optional)", "Lưu một bản về máy (tuỳ chọn)")}</Button>}
        {props.pendingCount > 0 && <Button className="h-10 rounded-xl bg-[#172019] text-xs font-extrabold text-[#c5fb7e] hover:bg-[#263029] dark:bg-lime-300 dark:text-slate-950" disabled={props.indexing} onClick={props.onIndexChanges}><RefreshCw className="mr-2 h-4 w-4" />{props.indexing ? t("Updating…", "Đang cập nhật…") : t(`Update ${props.pendingCount} changed blobs`, `Cập nhật ${props.pendingCount} blob thay đổi`)}</Button>}
        {props.needsRemoteUpload && <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-3 text-[10px] leading-4 text-sky-900 dark:border-sky-300/10 dark:bg-sky-300/[0.04] dark:text-sky-100"><p>{t("The app will save exactly ", "Ứng dụng sẽ lưu đúng ")}<strong>{t("1 backup blob", "1 blob bản sao")}</strong>{t(" to Shelby:", " lên Shelby:")}</p><code data-testid="backup-folder-name" className="mt-1.5 block break-all rounded-lg bg-white/80 px-2 py-1.5 font-mono font-bold text-slate-700 dark:bg-black/20 dark:text-sky-200">{snapshotFolder}/</code><div className="mt-2 grid gap-1 rounded-lg border border-sky-100 bg-white/55 p-2 font-mono text-[9px] dark:border-white/[0.06] dark:bg-black/15"><span>└─ <strong data-testid="backup-blob-name">{packFileName}</strong></span><span className="pl-4 font-sans text-sky-700 dark:text-sky-200">{t(`↳ directory + about ${estimatedRegions} independently readable regions`, `↳ mục lục + khoảng ${estimatedRegions} vùng có thể đọc riêng`)}</span></div><p className="mt-1.5 text-sky-700/80 dark:text-sky-200/60">{t("During chat, the app reads the small directory first, then asks Shelby for only the relevant byte range. The entire blob is not downloaded, and original documents are unchanged.", "Khi chat, ứng dụng đọc mục lục nhỏ trước rồi yêu cầu Shelby trả đúng vùng byte liên quan. Không cần tải cả blob. Tài liệu gốc không bị sửa.")}</p></div>}
        {props.needsRemoteUpload && <Button className="h-10 rounded-xl bg-gradient-to-r from-lime-400 to-emerald-400 text-xs font-extrabold text-slate-950 shadow-sm hover:from-lime-300 hover:to-emerald-300" disabled={props.syncing} onClick={props.onSync}><Upload className="mr-2 h-4 w-4" />{props.syncing ? t("Saving to Shelby…", "Đang lưu lên Shelby…") : t("Save knowledge base to Shelby", "Lưu kho lên Shelby")}</Button>}
        {!localReady && !capsuleReady && !props.pendingCount && <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center dark:border-white/10"><ScanText className="mx-auto h-5 w-5 text-slate-300" /><p className="mt-2 text-xs font-bold text-slate-600 dark:text-slate-300">{t("Nothing to back up yet", "Chưa có dữ liệu để đóng gói")}</p><p className="mt-1 text-[10px] text-slate-400">{t("Select documents and build RAG first.", "Chọn tài liệu và tạo RAG trước.")}</p></div>}
        {props.remoteFresh && props.pendingCount === 0 && <Button className="h-10 rounded-xl bg-emerald-100 text-xs font-extrabold text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-300/10 dark:text-emerald-200" disabled><ShieldCheck className="mr-2 h-4 w-4" />{t("Backup is up to date", "Bản sao đã cập nhật")}</Button>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="h-9 rounded-xl text-[11px]" disabled={!localReady} onClick={props.onDownload}><Download className="mr-1.5 h-3.5 w-3.5" />{t("Download backup", "Tải bản sao về máy")}</Button>
          <Button variant="ghost" className="h-9 rounded-xl text-[11px] text-slate-500 hover:bg-rose-50 hover:text-rose-700 dark:text-slate-400 dark:hover:bg-rose-500/10" disabled={!localReady} onClick={props.onRelease}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t("Remove on-device RAG", "Xóa RAG trên máy")}</Button>
        </div>
      </section>

      <p className="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-[10px] leading-4 text-slate-500 dark:bg-white/[0.025] dark:text-slate-400"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />{t("The backup does not contain your Gemini API key, wallet key, or chat history. It contains only processed content, source information, and search data.", "Bản sao không chứa Gemini API key, khóa ví hay lịch sử chat. Nó chỉ chứa nội dung đã xử lý, thông tin nguồn và dữ liệu phục vụ tìm kiếm.")}</p>
    </div>
  );
}
