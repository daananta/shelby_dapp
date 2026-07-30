import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Binary,
  DollarSign,
  Link,
  LockKeyhole,
  Pencil,
  RefreshCw,
  ScanText,
  UploadCloud,
  KeyRound,
  Sparkles,
  Check,
  Gauge,
  BrainCircuit,
  CloudOff
} from "lucide-react";
import { getBlobAccessDecision, isRagSourceEligible } from "@/utils/blobAccess";
import { getShelbyBlobUrl } from "@/utils/shelbyConfig";
import { updateUserDocumentMetadata, type RagSource } from "@/utils/ragOrama";
import { CLOUD_API_KEY_EVENT, getStoredCloudApiKey } from "@/utils/cloudKeyStorage";
import { useGeminiUsage } from "@/hooks/useGeminiUsage";
import { estimateRagGeminiCalls } from "@/utils/ragCallEstimate";
import type { EmbeddingProvider } from "@/utils/embeddingClient";
import { useLanguage } from "@/i18n";
import { getShelbyRefreshErrorCopy, type ShelbyServiceErrorKind } from "@/utils/shelbyErrors";

interface BlobLibraryProps {
  account: any;
  blobs: any[];
  selectedBlobNames: string[];
  setSelectedBlobNames: React.Dispatch<React.SetStateAction<string[]>>;
  ragSources: RagSource[];
  refreshRagStatus: () => Promise<void>;
  indexingAll: boolean;
  loading: boolean;
  loadError: ShelbyServiceErrorKind | null;
  fetchBlobs: () => Promise<any[]>;
  handleIndexBlobs: (targets: any[], options?: { force?: boolean }) => Promise<void>;
  pendingBlobNames: Set<string>;
  mockPurchasedBlobNames: string[];
  isPurchasableAndLocked: (blob: any) => boolean;
  handlePurchaseAccess: (blob: any) => Promise<void>;
  onOpenUpload: () => void;
  fullPdfOcr: boolean;
  ragChunkSize: number;
  effectiveEmbeddingMode: EmbeddingProvider | "off";
}

export function BlobLibrary({
  account,
  blobs,
  selectedBlobNames,
  setSelectedBlobNames,
  ragSources,
  refreshRagStatus,
  indexingAll,
  loading,
  loadError,
  fetchBlobs,
  handleIndexBlobs,
  pendingBlobNames,
  mockPurchasedBlobNames,
  isPurchasableAndLocked,
  handlePurchaseAccess,
  onOpenUpload,
  fullPdfOcr,
  ragChunkSize,
  effectiveEmbeddingMode,
}: BlobLibraryProps) {
  const { language, t } = useLanguage();
  const { preferences: geminiUsage } = useGeminiUsage();
  const [editingSource, setEditingSource] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [editingAliases, setEditingAliases] = useState("");
  const [hasCloudKey, setHasCloudKey] = useState(() => Boolean(getStoredCloudApiKey()));
  const loadErrorCopy = loadError ? getShelbyRefreshErrorCopy(loadError, language) : null;

  useEffect(() => {
    const refreshCloudKey = () => setHasCloudKey(Boolean(getStoredCloudApiKey()));
    window.addEventListener(CLOUD_API_KEY_EVENT, refreshCloudKey);
    return () => window.removeEventListener(CLOUD_API_KEY_EVENT, refreshCloudKey);
  }, []);

  useEffect(() => {
    setEditingSource("");
    setEditingTitle("");
    setEditingAliases("");
  }, [account?.address?.toString()]);

  const getBlobName = (blob: any) => blob.blobNameSuffix ?? blob.name;

  const getDisplayName = (name: string, blob?: any) => {
    if (blob?.metadata?.displayName) return blob.metadata.displayName;
    const parts = name.split("/");
    return parts.length > 1 ? parts[parts.length - 1] : name;
  };

  const getAccessLabel = (blob: any) => {
    const decision = getBlobAccessDecision(blob, account?.address.toString());
    const policy = blob.accessPolicy;
    if (policy?.type === "unknown" || policy?.type === "custom") return t("Unverified", "Không xác minh");
    const tag = decision.info.tag;
    if (tag === "time_lock" && decision.info.unlockAtMicros) {
      if (decision.needsDecryption) return t("Time lock · decryption required", "Khóa thời gian · cần giải mã");
      return decision.eligible
        ? t("Time lock · unlocked", "Khóa thời gian · đã mở khóa")
        : t("Time lock · locked", "Khóa thời gian · đang khóa");
    }
    return tag === "allowlist"
      ? t("Allowlist", "Danh sách cho phép")
      : tag === "purchasable"
        ? t("Purchasable", "Có thể mua quyền")
        : t("Public", "Công khai");
  };

  const userFacingRagError = (error?: string) => {
    if (!error) return undefined;
    if (/không nhận ra cấu trúc|zip\/office|bộ giải nén an toàn|\bbinary\b/i.test(error)) {
      return t(
        "This file type is not supported yet. The original data remains on Shelby.",
        "Chưa hỗ trợ loại tệp này. Dữ liệu gốc vẫn ở Shelby.",
      );
    }
    return error;
  };

  const startEditing = (source: RagSource) => {
    setEditingSource(source.source);
    setEditingTitle(source.title ?? "");
    setEditingAliases(source.aliases.join(", "));
  };

  const saveMetadata = async () => {
    if (!editingSource || !editingTitle.trim()) return;
    await updateUserDocumentMetadata(editingSource, editingTitle, editingAliases.split(","));
    setEditingSource("");
    await refreshRagStatus();
  };

  const renderRagStatus = (source?: RagSource, needsDecryption = false, decryptionReason?: string) => {
    if (needsDecryption) return <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" title={decryptionReason}><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{t("needs decryption", "cần giải mã")}</span>;
    if (!source) return <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-white/5 dark:text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-500" />{t("not indexed", "chưa nạp")}</span>;
    if (source.status === "indexed") {
      const statusTitle = source.type === "image"
        ? t(
          "Images use one descriptor chunk; this is expected.",
          "Ảnh dùng một descriptor chunk; đây là trạng thái bình thường.",
        )
        : source.type === "video"
          ? t(
            "The video was converted into a searchable timeline, transcript, and visual description.",
            "Video đã được chuyển thành dòng thời gian, lời nói và mô tả để tìm kiếm.",
          )
          : t(
            `${source.chunks} chunks from ${source.pageCount ?? 1} pages. Long or scanned documents often produce close to one chunk per page.`,
            `${source.chunks} chunks từ ${source.pageCount ?? 1} trang. Tài liệu dài/scan thường có gần một chunk mỗi trang.`,
          );
      return <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400" title={statusTitle}><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{source.type === "image" ? t("RAG ready · image", "Đã có RAG · ảnh") : t(`RAG ready · ${source.chunks} chunks`, `Đã có RAG · ${source.chunks} chunks`)}</span>;
    }
    if (source.status === "skipped") return <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-white/5 dark:text-slate-400" title={userFacingRagError(source.error)}><span className="h-1.5 w-1.5 rounded-full bg-slate-400" />{t("not supported", "chưa hỗ trợ")}</span>;
    if (source.status === "upgrade_required") return <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400" title={userFacingRagError(source.error)}><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />{t("rebuild needed", "cần nạp lại")}</span>;
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-400" title={userFacingRagError(source.error)}><span className="h-1.5 w-1.5 rounded-full bg-rose-500" />{t("indexing failed", "lỗi nạp")}</span>;
  };

  const statusBySource = new Map(ragSources.map((source) => [source.source, source]));
  const ragEligibleBlobs = blobs.filter((blob) => {
    const name = getBlobName(blob);
    const modifiedBlob = mockPurchasedBlobNames.includes(name)
      ? { ...blob, accessPolicy: { ...blob.accessPolicy, canAccess: true } }
      : blob;
    return isRagSourceEligible(modifiedBlob, account?.address.toString());
  });

  const pendingEligibleBlobs = ragEligibleBlobs.filter((blob) => pendingBlobNames.has(getBlobName(blob)));
  const pendingSelectedBlobs = pendingEligibleBlobs.filter((blob) => selectedBlobNames.includes(getBlobName(blob)));
  const callEstimate = estimateRagGeminiCalls(pendingSelectedBlobs.map((blob) => {
    const name = getBlobName(blob);
    const existing = statusBySource.get(name);
    return { name, size: Number(blob.size ?? 0), existing };
  }), {
    contentAnalysis: geminiUsage.contentAnalysis,
    semanticSearch: geminiUsage.semanticSearch && effectiveEmbeddingMode === "gemini",
    fullPdfOcr,
    chunkSize: ragChunkSize,
  });
  const selectedNeedsGeminiKey = callEstimate.contentCallsMinimum > 0 || (geminiUsage.semanticSearch && effectiveEmbeddingMode === "gemini" && callEstimate.semanticCallsApproximate > 0);
  const allPendingSelected = pendingEligibleBlobs.length > 0 && pendingEligibleBlobs.every((blob) => selectedBlobNames.includes(getBlobName(blob)));
  const indexedBlobCount = blobs.filter((blob) => statusBySource.get(getBlobName(blob))?.status === "indexed" && !pendingBlobNames.has(getBlobName(blob))).length;
  const sortedBlobs = blobs.map((blob, originalIndex) => ({ blob, originalIndex })).sort((left, right) => {
    const priority = ({ blob }: { blob: any }) => {
      const name = getBlobName(blob);
      const source = statusBySource.get(name);
      if (pendingBlobNames.has(name) && !source) return 0;
      if (pendingBlobNames.has(name)) return 1;
      if (source?.status === "indexed") return 2;
      if (isRagSourceEligible(blob, account?.address.toString())) return 3;
      return 4;
    };
    return priority(left) - priority(right) || left.originalIndex - right.originalIndex;
  }).map(({ blob }) => blob);

  const toggleBlobSelection = (blob: any) => {
    if (!isRagSourceEligible(blob, account?.address.toString())) return;
    const name = getBlobName(blob);
    if (!pendingBlobNames.has(name)) return;
    setSelectedBlobNames((previous) => previous.includes(name) ? previous.filter((item) => item !== name) : [...previous, name]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-visible animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out xl:overflow-hidden">
      <div className="flex flex-wrap items-center gap-2">
        {blobs.length > 0 && (
          <Button
            onClick={() => void handleIndexBlobs(pendingSelectedBlobs)}
            disabled={indexingAll || !account || pendingSelectedBlobs.length === 0}
            variant="default"
            className="rounded-lg bg-[#172019] text-[#c5fb7e] shadow-sm hover:-translate-y-0.5 hover:bg-[#263029] dark:bg-lime-300 dark:text-slate-950 dark:hover:bg-lime-200"
            size="sm"
          >
            {indexingAll ? (
              <><ScanText className="mr-2 h-4 w-4" />{t("Processing…", "Đang xử lý…")}</>
            ) : (
              <><ScanText className="mr-2 h-4 w-4" />{pendingSelectedBlobs.length
                ? t(`Build local RAG (${pendingSelectedBlobs.length})`, `Tạo RAG local (${pendingSelectedBlobs.length})`)
                : t("Local RAG is up to date", "RAG local đã cập nhật")}</>
            )}
          </Button>
        )}
        <Button
          onClick={fetchBlobs}
          disabled={loading || !account}
          variant="outline"
          className="rounded-lg border-[#d9ded6] bg-transparent text-slate-600 hover:bg-black/[0.035] dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/[0.06]"
          size="sm"
        >
          {loading ? <><RefreshCw className="mr-1.5 h-4 w-4" />{t("Loading…", "Đang tải…")}</> : t("Refresh", "Làm mới")}
        </Button>
      </div>

      {pendingSelectedBlobs.length > 0 && (
        <div className="rounded-xl border border-emerald-200/80 bg-gradient-to-r from-emerald-50/80 to-lime-50/45 p-3 dark:border-emerald-300/10 dark:from-emerald-300/[0.05] dark:to-lime-300/[0.025]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-emerald-700 dark:text-lime-300" /><p className="text-xs font-extrabold text-emerald-950 dark:text-emerald-100">{t("Estimate before building RAG", "Ước tính trước khi tạo RAG")}</p></div>
            <button type="button" onClick={() => window.dispatchEvent(new Event("shelby:open-rag-config"))} className="text-[10px] font-extrabold text-emerald-700 hover:underline dark:text-lime-300">{t("Adjust in Settings →", "Điều chỉnh trong Cấu hình →")}</button>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-white/80 bg-white/70 px-3 py-2 dark:border-white/[0.06] dark:bg-black/15">
              <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{t("Read content with Gemini", "Đọc nội dung bằng Gemini")}</span>
              <strong className="mt-0.5 block text-sm text-slate-900 dark:text-white">{geminiUsage.contentAnalysis ? t(`${callEstimate.contentCallsUncertain ? "≥" : ""}${callEstimate.contentCallsMinimum} calls`, `${callEstimate.contentCallsUncertain ? "≥" : ""}${callEstimate.contentCallsMinimum} lượt`) : t("0 · off", "0 · đang tắt")}</strong>
            </div>
            <div className="rounded-lg border border-white/80 bg-white/70 px-3 py-2 dark:border-white/[0.06] dark:bg-black/15">
              <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400"><BrainCircuit className="h-3 w-3" />{t("Semantic search", "Tìm theo ý nghĩa")}</span>
              <strong className="mt-0.5 block text-sm text-slate-900 dark:text-white">{!geminiUsage.semanticSearch ? t("0 · off", "0 · đang tắt") : effectiveEmbeddingMode === "gateway" ? t("Via server", "Qua máy chủ") : t(`~${callEstimate.semanticCallsApproximate} calls`, `~${callEstimate.semanticCallsApproximate} lượt`)}</strong>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{callEstimate.contentCallsUncertain ? t("The exact number of PDF pages requiring OCR is known only after reading the file structure. ", "PDF mới chỉ biết chính xác số trang cần OCR sau khi đọc cấu trúc tệp. ") : ""}{t("Chat is not included in this estimate; it is used only when you send a question.", "Chat không nằm trong con số này; chỉ phát sinh khi bạn gửi câu hỏi.")}</p>
        </div>
      )}

      {!hasCloudKey && pendingSelectedBlobs.length > 0 && (selectedNeedsGeminiKey || callEstimate.hasVideo) && (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/80 p-3 dark:border-amber-300/15 dark:bg-amber-300/[0.045] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-2.5">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
            <div>
              <p className="text-xs font-bold text-amber-900 dark:text-amber-100">{t("The current setup requires a Gemini API key", "Thiết lập hiện tại cần Gemini API key")}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-amber-800/80 dark:text-amber-200/70">{callEstimate.hasVideo && !geminiUsage.contentAnalysis
                ? t("Your selection includes a video. Enter a key and enable “Read images, PDFs, and videos” in Settings.", "Có video trong danh sách. Hãy nhập key và bật “Đọc ảnh, PDF và video” trong Cấu hình.")
                : t("A Gemini-powered step is enabled. Enter a key before building so it can run; the key is never uploaded to Shelby.", "Bạn đã cho phép một bước dùng Gemini. Nhập key trước khi tạo để bước đó hoạt động; key không được tải lên Shelby.")}</p>
            </div>
          </div>
          <Button size="sm" variant="outline" className="h-8 shrink-0 border-amber-300 bg-white px-3 text-[11px] font-bold text-amber-800 hover:bg-amber-100 dark:border-amber-300/20 dark:bg-transparent dark:text-amber-200" onClick={() => window.dispatchEvent(new Event("shelby:open-ai-settings"))}>
            <KeyRound className="mr-1.5 h-3.5 w-3.5" />{t("Enter API key", "Nhập API key")}
          </Button>
        </div>
      )}

      <div data-testid="blob-list" className="flex min-h-[16rem] flex-1 flex-col overflow-hidden rounded-xl border border-[#dfe4dc] bg-[#fdfefa] dark:border-white/[0.075] dark:bg-black/10 xl:min-h-0">
        <div className="flex items-center justify-between gap-3 border-b border-[#e4e8e1] bg-[#f3f5f0] px-3.5 py-2.5 text-[11px] text-slate-500 dark:border-white/[0.065] dark:bg-white/[0.025] dark:text-slate-400">
          <label className="flex cursor-pointer items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={allPendingSelected}
              disabled={pendingEligibleBlobs.length === 0}
              onChange={(event) => {
                const visibleNames = new Set(pendingEligibleBlobs.map((blob) => getBlobName(blob)));
                setSelectedBlobNames((previous) => event.target.checked
                  ? [...new Set([...previous, ...visibleNames])]
                  : previous.filter((name) => !visibleNames.has(name)));
              }}
              className="h-3.5 w-3.5 rounded accent-emerald-600 disabled:opacity-40 dark:accent-lime-400"
            />
            <span>{pendingEligibleBlobs.length === 0
              ? t("No files need processing", "Không có tệp cần xử lý")
              : allPendingSelected
                ? t("Deselect files needing processing", "Bỏ chọn tệp cần xử lý")
                : t(`Select ${pendingEligibleBlobs.length} files needing processing`, `Chọn ${pendingEligibleBlobs.length} tệp cần xử lý`)}</span>
          </label>
          <div className="flex items-center gap-2"><strong className="text-amber-700 dark:text-amber-300">{t(`${pendingEligibleBlobs.length} to process`, `${pendingEligibleBlobs.length} cần xử lý`)}</strong><span>·</span><span>{t(`${indexedBlobCount} RAG ready`, `${indexedBlobCount} đã có RAG`)}</span></div>
        </div>

        {loading && blobs.length === 0 ? (
          <div className="space-y-3 p-4" role="status" aria-label={t("Loading blob list", "Đang tải danh sách blob")}>
            {[0, 1, 2, 3].map((item) => <div key={item} className="flex items-center gap-3"><span className="h-8 w-8 rounded-lg bg-slate-200/75 dark:bg-white/10" /><span className="h-3 flex-1 rounded bg-slate-200/75 dark:bg-white/10" /><span className="h-3 w-14 rounded bg-slate-100 dark:bg-white/5" /></div>)}
          </div>
        ) : loadErrorCopy && blobs.length === 0 ? (
          <div data-testid="shelby-load-error" className="m-4 flex flex-1 flex-col items-center justify-center rounded-xl border border-amber-200/80 bg-amber-50/45 p-10 text-center dark:border-amber-300/10 dark:bg-amber-300/[0.035]">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-300/10 dark:text-amber-200">
              <CloudOff className="h-6 w-6" />
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-100">{loadErrorCopy.title}</p>
            <p className="mt-1.5 max-w-md text-xs leading-5 text-slate-500 dark:text-slate-400">{loadErrorCopy.description}</p>
            <Button size="sm" variant="outline" className="mt-5 rounded-xl px-5 font-bold" onClick={() => void fetchBlobs()}>
              <RefreshCw className="mr-2 h-4 w-4" />{t("Try again", "Thử lại")}
            </Button>
          </div>
        ) : blobs.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center p-10 text-center drag-drop-zone border border-dashed rounded-xl m-4 bg-[#fdfefa] dark:bg-white/[0.02]">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#e7f4dc] to-[#c5f5a8] text-[#376d3f] shadow-sm dark:from-lime-300/[0.15] dark:to-lime-300/[0.05] dark:text-lime-300 relative glow-border">
              <Binary className="h-6 w-6 relative z-10" />
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-800 dark:text-slate-200">{t("No blobs registered yet", "Chưa có blob nào được đăng ký")}</p>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{t("Open Upload to register the file and send its data to Shelby.", "Mở tab Tải lên để đăng ký tệp và gửi dữ liệu lên Shelby.")}</p>
            <Button size="sm" className="mt-5 rounded-xl bg-[#172019] px-5 py-4 font-bold text-[#c5fb7e] hover:-translate-y-0.5 transition-all shadow-sm hover:bg-[#263029] dark:bg-lime-300 dark:text-slate-950" onClick={onOpenUpload}>
              <UploadCloud className="mr-2 h-4 w-4" />{t("Open Upload", "Mở tab Tải lên")}
            </Button>
          </div>
        ) : (
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain divide-y divide-[#edf0eb] dark:divide-white/[0.04]">
            {sortedBlobs.map((b) => {
              const ownerAddress = account?.address.toString() ?? "";
              const decision = getBlobAccessDecision(b, ownerAddress);
              const isEligible = isRagSourceEligible(b, ownerAddress);
              const tag = decision.info.tag;
              const isLocked = !isEligible;
              const blobName = getBlobName(b);
              const ragSource = statusBySource.get(blobName);
              const isEditing = editingSource === blobName;
              const isPending = pendingBlobNames.has(blobName);
              const pendingLabel = !ragSource
                ? t("NEW", "MỚI")
                : ragSource.status === "indexed"
                  ? t("CHANGED", "ĐÃ THAY ĐỔI")
                  : ragSource.status === "upgrade_required"
                    ? t("UPDATE NEEDED", "CẦN CẬP NHẬT")
                    : t("RETRY NEEDED", "CẦN THỬ LẠI");

              return (
                <div
                  key={blobName}
                  className={`transition-all duration-200 hover:bg-lime-50/45 dark:hover:bg-lime-300/[0.025] group hover-lift ${isEditing ? "p-3.5 flex flex-col gap-3" : "min-h-[58px] px-3.5 py-2.5 flex items-center justify-between gap-3"} ${isPending ? "bg-lime-50/55 dark:bg-lime-300/[0.035]" : isLocked ? "bg-slate-500/[0.012]" : ""}`}
                >
                  {isEditing ? (
                    <div className="grid gap-2.5 p-3.5 bg-white/60 dark:bg-slate-900/40 rounded-xl border border-slate-200/60 dark:border-white/10 w-full backdrop-blur-md shadow-sm">
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate flex items-center gap-2"><Pencil className="h-3.5 w-3.5" /> {t("Edit details:", "Sửa thông tin:")} {getDisplayName(blobName, b)}</p>
                      <Input value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} placeholder={t("Display name", "Tên tài liệu hiển thị")} className="h-9 text-xs border-slate-200 bg-white/80 dark:border-white/10 dark:bg-slate-950/50 focus-visible:ring-lime-500" />
                      <Input value={editingAliases} onChange={(event) => setEditingAliases(event.target.value)} placeholder={t("Aliases (comma-separated)", "Tên gọi khác (cách nhau bằng dấu phẩy)")} className="h-9 text-xs border-slate-200 bg-white/80 dark:border-white/10 dark:bg-slate-950/50 focus-visible:ring-lime-500" />
                      <div className="flex gap-2 justify-end mt-1">
                        <Button size="sm" variant="outline" className="h-8 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10" onClick={() => setEditingSource("")}>{t("Cancel", "Huỷ")}</Button>
                        <Button size="sm" className="h-8 text-xs bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:text-white" onClick={() => void saveMetadata()}>{t("Save changes", "Lưu thay đổi")}</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5 overflow-hidden flex-1 min-w-0">
                        {isEligible && isPending ? (
                          <input
                            aria-label={t(`Select ${getDisplayName(blobName, b)}`, `Chọn ${getDisplayName(blobName, b)}`)}
                            type="checkbox"
                            checked={selectedBlobNames.includes(blobName)}
                            onChange={() => toggleBlobSelection(b)}
                            className="h-3.5 w-3.5 rounded accent-emerald-600 dark:accent-lime-400"
                          />
                        ) : ragSource?.status === "indexed" && !isPending ? (
                          <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-300/10 dark:text-lime-300" title={t("This file already has the latest RAG.", "Tệp này đã có RAG mới nhất.")}>
                            <Check className="h-3 w-3" strokeWidth={3} />
                          </div>
                        ) : (
                          <div className="flex h-3.5 w-3.5 shrink-0 cursor-not-allowed items-center justify-center" title={decision.reason ?? t("Not eligible.", "Không đủ điều kiện.")}>
                            <span className="h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                          </div>
                        )}

                        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${isLocked ? "bg-[#ecefea] text-slate-400 dark:bg-white/[0.045]" : "bg-[#e9f5de] text-[#376d3f] dark:bg-lime-300/[0.08] dark:text-lime-300"}`}>
                          {isLocked ? <LockKeyhole className="h-3.5 w-3.5" /> : <Binary className="h-3.5 w-3.5" />}
                        </div>

                        <div className="min-w-0 flex-1 leading-normal">
                          <div className="flex items-center gap-1.5">
                            <span
                              className="max-w-[230px] truncate text-xs font-semibold text-[#27302a] dark:text-slate-100"
                              title={getDisplayName(blobName, b)}
                            >
                              {getDisplayName(blobName, b)}
                            </span>
                            {statusBySource.get(blobName)?.status === "indexed" && (
                              <button
                                aria-label={t("Edit metadata", "Sửa metadata")}
                                onClick={() => startEditing(statusBySource.get(blobName)!)}
                                className="p-0.5 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5 dark:hover:text-slate-200 shrink-0"
                              >
                                <Pencil className="h-2.5 w-2.5" />
                              </button>
                            )}
                          </div>

                          {statusBySource.get(blobName)?.title && (
                            <p className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 truncate max-w-[220px] mt-0.5">
                              {statusBySource.get(blobName)?.title}
                            </p>
                          )}

                          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] leading-4 text-slate-400 dark:text-slate-500">
                            <span>{(b.size / 1024).toFixed(1)} KB</span>
                            <span>•</span>
                            <span>{getAccessLabel(b)}</span>
                            <span>•</span>
                            {renderRagStatus(ragSource, decision.needsDecryption, decision.reason)}
                          </div>
                          {decision.needsDecryption
                            ? <p className="mt-1 line-clamp-1 max-w-[320px] text-[10px] leading-4 text-amber-700/80 dark:text-amber-300/75" title={decision.reason}>{decision.reason}</p>
                            : ragSource?.error && ragSource.status !== "indexed" && <p className="mt-1 line-clamp-1 max-w-[320px] text-[10px] leading-4 text-rose-600/80 dark:text-rose-300/70" title={userFacingRagError(ragSource.error)}>{userFacingRagError(ragSource.error)}</p>}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isPending && <span className={`rounded-full px-2 py-1 text-[9px] font-extrabold tracking-wide ${!ragSource ? "bg-lime-200/80 text-[#315f3e] dark:bg-lime-300/15 dark:text-lime-200" : "bg-amber-100 text-amber-800 dark:bg-amber-300/10 dark:text-amber-200"}`}>{pendingLabel}</span>}
                        {ragSource && ragSource.status !== "indexed" && isEligible && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-slate-400 hover:bg-lime-50 hover:text-[#315f3e] dark:hover:bg-lime-300/[0.05] dark:hover:text-lime-300" onClick={() => void handleIndexBlobs([b], { force: true })} disabled={indexingAll} title={t("Retry indexing", "Thử nạp lại")}>
                            <RefreshCw className="h-3.5 w-3.5" />
                            <span className="sr-only">{t(`Retry indexing ${getDisplayName(blobName, b)}`, `Thử nạp lại ${getDisplayName(blobName, b)}`)}</span>
                          </Button>
                        )}
                        {isPurchasableAndLocked(b) && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 border-[#cfd8cc] bg-transparent px-2 text-[10px] font-bold text-[#315f3e] hover:bg-lime-50 dark:border-lime-300/15 dark:text-lime-200 transition-colors"
                            onClick={() => void handlePurchaseAccess(b)}
                            disabled={indexingAll}
                          >
                            <DollarSign className="w-3 h-3 mr-0.5" />
                            {t("Buy access", "Mua quyền")}
                          </Button>
                        )}

                        {isEligible && tag === "public" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors opacity-100 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                            onClick={() => {
                              window.open(getShelbyBlobUrl(account!.address.toString(), blobName), "_blank", "noopener,noreferrer");
                            }}
                            title={t("Open direct link", "Mở liên kết trực tiếp")}
                            aria-label={t(`Open ${getDisplayName(blobName, b)} on Shelby`, `Mở ${getDisplayName(blobName, b)} trên Shelby`)}
                          >
                            <Link className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
