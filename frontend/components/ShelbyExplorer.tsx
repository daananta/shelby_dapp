import { useEffect, useMemo, useRef, useState } from "react";
import { useShelby } from "@/hooks/useShelby";
import { useRag } from "@/hooks/useRag";
import { BlobLibrary } from "./explorer/BlobLibrary";
import { UploadZone } from "./explorer/UploadZone";
import { RagConfigPanel } from "./explorer/RagConfigPanel";
import { IndexingStepper } from "./explorer/IndexingStepper";
import { MemoryCapsulePanel } from "./explorer/MemoryCapsulePanel";
import {
  Archive,
  BookOpen,
  Settings,
  UploadCloud,
  Cloud,
  HardDrive,
  ScanText,
  Upload,
  Trash2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { getBlobAccessDecision, isRagSourceEligible } from "@/utils/blobAccess";
import { embedTexts } from "@/utils/embeddingClient";
import { buildHotRagPack, HOT_RAG_PACK_HEADER_BYTES, HotRagRuntime, hotRagManifestToPortableCatalog, isHotRagManifest, isHotRagManifestName, isHotRagPackName, isRagArtifactName, parseHotRagPackHeader, parseHotRagPackManifest, type HotRagManifest, type HotRagShardDescriptor } from "@/utils/hotRag";
import { summarizeRagSources } from "@/utils/ragMetrics";
import { clearActiveRagWorkspace, estimateActiveRagStorageBytes, exportPortableRagPackage, importPortableRagPackage, isPortableRagPackage, primeRemoteRagPackage, setRemoteRagProvider } from "@/utils/ragOrama";
import type { PortableRagPackage } from "@/utils/ragTypes";
import { assessRemoteSnapshot, blobContentIdentity, blobPipelineRevision, needsLocalIndex } from "@/utils/ragLifecycle";
import { rpcClient } from "@/utils/shelbyConfig";
import { getGeminiUsagePreferences } from "@/utils/geminiUsage";
import { localize, useLanguage } from "@/i18n";
import type { RegisterBlobInventoryRefresh } from "@/utils/agentCapabilities";
import { getShelbyRefreshErrorCopy } from "@/utils/shelbyErrors";

const isPortableRagBlobName = (name: string) => /\.shelby-rag\.json$/i.test(name);
const LOCAL_RAG_RECOMMEND_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_RAG_BYTES = 96 * 1024 * 1024;
const MAX_HOT_RAG_PART_BYTES = 2 * 1024 * 1024;
const formatStorage = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const merkleRootHex = (value: unknown) => {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (Array.isArray(value) && value.every((byte) => typeof byte === "number")) return `0x${value.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return undefined;
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

interface ShelbyExplorerProps {
  registerBlobInventoryRefresh: RegisterBlobInventoryRefresh;
}

export function ShelbyExplorer({ registerBlobInventoryRefresh }: ShelbyExplorerProps) {
  const { language, t } = useLanguage();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"library" | "upload" | "capsule" | "config">("library");
  const [remoteSnapshot, setRemoteSnapshot] = useState<{ status: "idle" | "loading" | "ready" | "error"; packageData?: PortableRagPackage; hotManifest?: HotRagManifest; hotRuntime?: HotRagRuntime; error?: string }>({ status: "idle" });
  const [syncingRag, setSyncingRag] = useState(false);
  const [restoringRag, setRestoringRag] = useState(false);
  const [localRagBytes, setLocalRagBytes] = useState(0);

  const {
    account,
    signMessage,
    blobs,
    loading,
    uploading,
    uploadProgress,
    selectedBlobNames,
    setSelectedBlobNames,
    loadError,
    mockPurchasedBlobNames,
    getBlobName,
    getModifiedBlobForRag,
    isPurchasableAndLocked,
    handlePurchaseAccess,
    fetchBlobs,
    refreshBlobInventory,
    uploadFiles,
  } = useShelby();
  const refreshBlobInventoryRef = useRef(refreshBlobInventory);
  refreshBlobInventoryRef.current = refreshBlobInventory;

  useEffect(() => registerBlobInventoryRefresh(
    (detail, signal) => refreshBlobInventoryRef.current(detail, signal),
  ), [registerBlobInventoryRefresh]);

  const {
    ragSources,
    indexingAll,
    indexProgress,
    indexLogs,
    fullPdfOcr,
    setFullPdfOcr,
    embeddingMode,
    setEmbeddingMode,
    effectiveEmbeddingMode,
    activePipelineRevision,
    ragChunkSize,
    setRagChunkSize,
    cancelIndexing,
    refreshRagStatus,
    handleIndexBlobs,
  } = useRag(account, signMessage);
  const activeOwnerRef = useRef(account?.address?.toString().toLowerCase() ?? "");
  activeOwnerRef.current = account?.address?.toString().toLowerCase() ?? "";

  const statusBySource = new Map(ragSources.map((source) => [source.source, source]));
  const ragEligibleBlobs = blobs.filter((blob) => {
    const name = getBlobName(blob);
    const modifiedBlob = mockPurchasedBlobNames.includes(name)
      ? { ...blob, accessPolicy: { ...blob.accessPolicy, canAccess: true } }
      : blob;
    return isRagSourceEligible(modifiedBlob, account?.address?.toString());
  });

  const ragMetrics = summarizeRagSources(ragSources);
  const loadErrorCopy = loadError ? getShelbyRefreshErrorCopy(loadError, language) : null;
  const indexedSources = ragSources.filter((source) => source.status === "indexed");
  const remoteRagBlobs = blobs.filter((blob) => {
    const name = getBlobName(blob);
    return !blob.isDemoBlob && (isPortableRagBlobName(name) || isHotRagManifestName(name) || isHotRagPackName(name)) && isRagSourceEligible(getModifiedBlobForRag(blob), account?.address?.toString());
  });
  const newestRemoteRagBlob = remoteRagBlobs.slice().sort((left, right) => Number(right.creationMicros ?? 0) - Number(left.creationMicros ?? 0))[0];
  const latestLocalIndexAt = indexedSources.reduce((latest, source) => Math.max(latest, source.indexedAt), 0);
  const backupBlobName = useMemo(() => {
    const timestamp = new Date(latestLocalIndexAt || 0).toISOString().replace(/[:.]/g, "-");
    return `rag-hot/${timestamp}/snapshot.shelby-hot-rag.pack`;
  }, [latestLocalIndexAt]);
  const hasLocalRag = indexedSources.length > 0;
  const localRagLarge = localRagBytes >= LOCAL_RAG_RECOMMEND_BYTES;
  const hasRemoteRag = remoteRagBlobs.length > 0;
  // Snapshot manifests and parts are managed in the Backup tab; hiding them
  // here keeps internal storage objects out of the user's document library.
  const libraryBlobs = blobs.filter((blob) => !isRagArtifactName(getBlobName(blob)));
  const dataBlobs = blobs.filter((blob) => !blob.isDemoBlob && !isRagArtifactName(getBlobName(blob)) && blob.isDeleted !== true);
  const eligibleInventoryBlobs = ragEligibleBlobs.filter((blob) => !isRagArtifactName(getBlobName(blob)) && blob.isDeleted !== true);
  // Demo blobs remain indexable in the explicit local QA workspace, but never
  // participate in the real Shelby inventory/freshness comparison above.
  const localIndexCandidates = ragEligibleBlobs.filter((blob) => !isRagArtifactName(getBlobName(blob)));
  const pendingLocalBlobs = localIndexCandidates.filter((blob) => {
    const source = statusBySource.get(getBlobName(blob));
    const access = getBlobAccessDecision(getModifiedBlobForRag(blob), account?.address?.toString());
    return needsLocalIndex(source, blobPipelineRevision(blob, access.info.tag, activePipelineRevision));
  });
  const pendingBlobNames = new Set(pendingLocalBlobs.map((blob) => getBlobName(blob)));
  const localComplete = hasLocalRag && pendingLocalBlobs.length === 0;

  const remoteAssessment = assessRemoteSnapshot({
    packageData: remoteSnapshot.packageData,
    currentInventoryNames: eligibleInventoryBlobs.map((blob) => getBlobName(blob)),
    currentSources: eligibleInventoryBlobs.flatMap((blob) => {
      const source = statusBySource.get(getBlobName(blob));
      if (source?.status !== "indexed") return [];
      const access = getBlobAccessDecision(getModifiedBlobForRag(blob), account?.address?.toString());
      return [{ name: getBlobName(blob), contentIdentity: blobContentIdentity(blob, access.info.tag) }];
    }),
  });
  const remoteFresh = remoteSnapshot.status === "ready" && remoteAssessment.fresh && (remoteSnapshot.packageData?.exportedAt ?? 0) >= latestLocalIndexAt;
  const needsRemoteUpload = localComplete && !remoteFresh;
  const remoteDeltaCount = new Set([...remoteAssessment.missingInventoryNames, ...remoteAssessment.extraInventoryNames, ...remoteAssessment.staleSources]).size;

  const remoteBlobName = newestRemoteRagBlob ? getBlobName(newestRemoteRagBlob) : "";
  const remoteBlobCreation = Number(newestRemoteRagBlob?.creationMicros ?? 0);
  const accountAddress = account?.address?.toString() ?? "";
  const localRagFingerprint = indexedSources.map((source) => `${source.source}:${source.indexedAt}:${source.chunks}`).join("|");
  const remoteArtifactsFingerprint = blobs.filter((blob) => isRagArtifactName(getBlobName(blob))).map((blob) => `${getBlobName(blob)}:${blob.creationMicros ?? 0}:${blob.isWritten ?? false}`).sort().join("|");

  useEffect(() => {
    const openConfig = () => setActiveTab("config");
    window.addEventListener("shelby:open-rag-config", openConfig);
    return () => window.removeEventListener("shelby:open-rag-config", openConfig);
  }, []);

  useEffect(() => {
    const availableKnowledgeSources = Math.max(indexedSources.length, remoteSnapshot.status === "ready" ? remoteSnapshot.packageData?.documents.length ?? 0 : 0);
    const publishTourReadiness = () => window.dispatchEvent(new CustomEvent("shelby:tour-readiness", { detail: { blobCount: dataBlobs.length, indexedBlobCount: availableKnowledgeSources } }));
    publishTourReadiness();
    window.addEventListener("shelby:tour-readiness-request", publishTourReadiness);
    return () => window.removeEventListener("shelby:tour-readiness-request", publishTourReadiness);
  }, [dataBlobs.length, indexedSources.length, remoteSnapshot.status, remoteSnapshot.packageData?.documents.length]);

  useEffect(() => {
    const navigate = (event: Event) => {
      const target = (event as CustomEvent<"library" | "backup">).detail;
      if (target === "library") setActiveTab("library");
      if (target === "backup") setActiveTab("capsule");
    };
    window.addEventListener("shelby:tour-navigate", navigate);
    return () => window.removeEventListener("shelby:tour-navigate", navigate);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!hasLocalRag) {
      setLocalRagBytes(0);
      return () => { cancelled = true; };
    }
    void estimateActiveRagStorageBytes().then((bytes) => { if (!cancelled) setLocalRagBytes(bytes); });
    return () => { cancelled = true; };
  }, [accountAddress, hasLocalRag, localRagFingerprint]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (!accountAddress || !newestRemoteRagBlob || !remoteBlobName) {
      setRemoteSnapshot({ status: "idle" });
      setRemoteRagProvider(null);
      return () => { cancelled = true; controller.abort(); };
    }
    const providerId = `${accountAddress.toLowerCase()}:${remoteBlobName}:${remoteBlobCreation}`;
    setRemoteSnapshot({ status: "loading" });

    const loadBlobBytes = async (blobName: string, maxBytes: number, signal?: AbortSignal, range?: { start: number; end: number }): Promise<{ bytes: Uint8Array; bytesRead: number }> => {
      signal?.throwIfAborted();
      const metadata = blobs.find((blob) => getBlobName(blob) === blobName);
      if (typeof metadata?.mockBase64 === "string") {
        const allBytes = base64ToBytes(metadata.mockBase64);
        const bytes = range ? allBytes.slice(range.start, range.end + 1) : allBytes;
        if (bytes.byteLength > maxBytes) throw new Error(localize(`File “${blobName}” exceeds the safe read limit.`, `Tệp “${blobName}” vượt giới hạn đọc an toàn.`));
        return { bytes, bytesRead: bytes.byteLength };
      }
      if (typeof metadata?.mockContent === "string") {
        const allBytes = new TextEncoder().encode(metadata.mockContent);
        const bytes = range ? allBytes.slice(range.start, range.end + 1) : allBytes;
        if (bytes.byteLength > maxBytes) throw new Error(localize(`File “${blobName}” exceeds the safe read limit.`, `Tệp “${blobName}” vượt giới hạn đọc an toàn.`));
        return { bytes, bytesRead: bytes.byteLength };
      }
      const response = await rpcClient.getBlob({ account: accountAddress, blobName, range });
      if (response.contentLength > maxBytes) throw new Error(localize(`File “${blobName}” exceeds the safe read limit.`, `Tệp “${blobName}” vượt giới hạn đọc an toàn.`));
      const reader = response.readable.getReader();
      const chunks: Uint8Array[] = [];
      let bytesRead = 0;
      const abortReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
      signal?.addEventListener("abort", abortReader, { once: true });
      try {
        let streamFinished = false;
        while (!streamFinished) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          streamFinished = done;
          if (streamFinished) continue;
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
          bytesRead += bytes.byteLength;
          if (bytesRead > maxBytes) throw new Error(localize(`File “${blobName}” exceeds the safe read limit.`, `Tệp “${blobName}” vượt giới hạn đọc an toàn.`));
          chunks.push(bytes);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortReader);
      }
      signal?.throwIfAborted();
      const output = new Uint8Array(bytesRead);
      let offset = 0;
      chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.byteLength; });
      return { bytes: output, bytesRead };
    };

    const loadJsonArtifact = async (blobName: string, maxBytes: number, signal?: AbortSignal, range?: { start: number; end: number }): Promise<{ value: unknown; bytesRead: number }> => {
      const loaded = await loadBlobBytes(blobName, maxBytes, signal, range);
      return { value: JSON.parse(new TextDecoder().decode(loaded.bytes)), bytesRead: loaded.bytesRead };
    };

    void (async () => {
      try {
        let first: { value: unknown; bytesRead: number };
        let packedPayloadStart: number | undefined;
        let proofManifestBytes: number | undefined;
        let proofHeaderBytesRead = 0;
        let proofManifestBytesRead: number | undefined;
        let proofBootstrapRangeReads = 0;
        if (isHotRagPackName(remoteBlobName)) {
          const headerBytes = await loadBlobBytes(remoteBlobName, HOT_RAG_PACK_HEADER_BYTES, controller.signal, { start: 0, end: HOT_RAG_PACK_HEADER_BYTES - 1 });
          const header = parseHotRagPackHeader(headerBytes.bytes);
          if (header.manifestByteLength > MAX_HOT_RAG_PART_BYTES) throw new Error(localize("The Shelby backup directory exceeds the safe read limit.", "Mục lục bản sao trên Shelby vượt giới hạn đọc an toàn."));
          const manifestBytes = await loadBlobBytes(remoteBlobName, MAX_HOT_RAG_PART_BYTES, controller.signal, { start: header.manifestStart, end: header.payloadStart - 1 });
          const packByteLength = Number(newestRemoteRagBlob.size);
          first = { value: parseHotRagPackManifest(manifestBytes.bytes, Number.isSafeInteger(packByteLength) ? packByteLength : undefined), bytesRead: headerBytes.bytesRead + manifestBytes.bytesRead };
          packedPayloadStart = header.payloadStart;
          proofManifestBytes = header.manifestByteLength;
          proofHeaderBytesRead = headerBytes.bytesRead;
          proofManifestBytesRead = manifestBytes.bytesRead;
          proofBootstrapRangeReads = 2;
        } else {
          first = await loadJsonArtifact(remoteBlobName, isHotRagManifestName(remoteBlobName) ? MAX_HOT_RAG_PART_BYTES : MAX_REMOTE_RAG_BYTES, controller.signal);
          proofManifestBytes = first.bytesRead;
          proofManifestBytesRead = first.bytesRead;
        }
        if (cancelled) return;
        if (isHotRagManifest(first.value)) {
          const manifest = first.value;
          const runtime = new HotRagRuntime({
            manifest,
            loadShard: (descriptor: HotRagShardDescriptor, signal) => {
              if (packedPayloadStart !== undefined) {
                if (descriptor.byteOffset === undefined) throw new Error(localize("The backup directory does not specify this data region.", "Mục lục bản sao không có vị trí vùng dữ liệu."));
                const start = packedPayloadStart + descriptor.byteOffset;
                return loadJsonArtifact(remoteBlobName, descriptor.byteLength, signal, { start, end: start + descriptor.byteLength - 1 });
              }
              return loadJsonArtifact(descriptor.blobName, Math.max(MAX_HOT_RAG_PART_BYTES, descriptor.byteLength + 64 * 1024), signal);
            },
            embedQuery: async (query, provider, signal) => {
              signal?.throwIfAborted();
              if (!getGeminiUsagePreferences().semanticSearch) throw new Error(localize("Semantic search is turned off in Settings.", "Tìm theo ý nghĩa đang tắt trong Cấu hình."));
              const [embedding] = await embedTexts([query], "query", undefined, provider, undefined, signal);
              signal?.throwIfAborted();
              if (!embedding) throw new Error(localize("Could not create a vector for the question.", "Không tạo được vector cho câu hỏi."));
              return embedding;
            },
            proofContext: {
              // A v2 pack is one Shelby blob, so its metadata is the truthful
              // denominator for the range-read ratio. A v1 snapshot spans
              // several blobs and is measured from its serialized layout.
              capsuleBytes: manifest.version === 2 && Number.isSafeInteger(Number(newestRemoteRagBlob.size))
                ? Number(newestRemoteRagBlob.size)
                : undefined,
              manifestBytes: proofManifestBytes,
              bootstrap: {
                headerNetworkBytesRead: proofHeaderBytesRead,
                manifestNetworkBytesRead: proofManifestBytesRead,
                rangeReads: proofBootstrapRangeReads,
              },
            },
          });
          const packageData = hotRagManifestToPortableCatalog(manifest);
          setRemoteRagProvider({
            id: providerId,
            mode: "hot",
            search: (query, limit, signal, excludeSources) => runtime.search(query, limit, signal, excludeSources),
            lookupExactQuote: (quote, signal) => runtime.lookupExactQuote(quote, signal),
            getPageRecord: (documentId, pageNumber) => runtime.getPageRecord(documentId, pageNumber),
          });
          setRemoteSnapshot({ status: "ready", packageData, hotManifest: manifest, hotRuntime: runtime });
          return;
        }
        if (!isPortableRagPackage(first.value)) throw new Error(localize("The Shelby backup has an unsupported format.", "Bản sao trên Shelby không đúng định dạng."));
        const packageData = first.value;
        const loadRemotePackage = async (signal?: AbortSignal) => {
          signal?.throwIfAborted();
          const loaded = await loadJsonArtifact(remoteBlobName, MAX_REMOTE_RAG_BYTES, signal);
          if (!isPortableRagPackage(loaded.value)) throw new Error(localize("The backup is not a valid Shelby RAG package.", "Bản sao không phải gói Shelby RAG hợp lệ."));
          return loaded.value;
        };
        setRemoteRagProvider({ id: providerId, mode: "legacy", load: loadRemotePackage, cacheTtlMs: 60_000 });
        primeRemoteRagPackage(providerId, packageData);
        setRemoteSnapshot({ status: "ready", packageData });
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setRemoteSnapshot({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; controller.abort(); setRemoteRagProvider(null); };
  }, [accountAddress, remoteBlobName, remoteBlobCreation, remoteArtifactsFingerprint]);

  const handleUploadRagSnapshot = async () => {
    if (!account || !localComplete || syncingRag) return;
    try {
      setSyncingRag(true);
      // Keep the exact bytes stable for a given local revision. If Aptos
      // registration succeeds but putBlob is interrupted, retrying the same
      // name must regenerate the same Merkle root.
      const exportTimestamp = latestLocalIndexAt;
      let packageData = await exportPortableRagPackage({ includeEmbeddings: true, exportedAt: exportTimestamp });
      let snapshot = await buildHotRagPack(packageData, backupBlobName);
      let totalBytes = snapshot.bytes.byteLength;
      if (totalBytes > MAX_REMOTE_RAG_BYTES) {
        packageData = await exportPortableRagPackage({ exportedAt: exportTimestamp });
        snapshot = await buildHotRagPack(packageData, backupBlobName);
        totalBytes = snapshot.bytes.byteLength;
      }
      if (totalBytes > MAX_REMOTE_RAG_BYTES) throw new Error(t("The backup still exceeds 96 MB after optimization. Split the knowledge base into smaller document sets.", "Bản sao vượt 96 MB kể cả sau khi tối ưu. Hãy chia kho thành nhiều bộ tài liệu."));
      const fileBytes = snapshot.bytes.slice();
      const file = new File([fileBytes.buffer as ArrayBuffer], backupBlobName, { type: "application/octet-stream" });
      await uploadFiles(
        [file],
        t(
          `Saved 1 backup blob to Shelby; ${snapshot.parts.length} internal regions can be read independently.`,
          `Đã lưu 1 blob bản sao lên Shelby; ${snapshot.parts.length} vùng bên trong có thể được đọc riêng.`,
        ),
      );
    } catch (error) {
      toast({ title: t("Could not sync RAG", "Không thể đồng bộ RAG"), description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setSyncingRag(false);
    }
  };

  const handleDownloadRagCapsule = async () => {
    try {
      const packageData = await exportPortableRagPackage();
      const blob = new Blob([JSON.stringify(packageData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `shelby-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.shelby-rag.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast({ title: t("Knowledge base backup downloaded", "Đã tải bản sao kho tri thức về máy") });
    } catch (error) {
      toast({ title: t("Could not download the backup", "Không thể tải bản sao"), description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    }
  };

  const handleRestoreRemoteRag = async () => {
    if (!newestRemoteRagBlob) return;
    if (!remoteSnapshot.hotRuntime) {
      await handleIndexBlobs([newestRemoteRagBlob], { force: true });
      return;
    }
    const restoreOwner = account?.address?.toString().toLowerCase() ?? "";
    if (!restoreOwner) return;
    try {
      setRestoringRag(true);
      const packageData = await remoteSnapshot.hotRuntime.reconstruct();
      if (activeOwnerRef.current !== restoreOwner) throw new DOMException(t("The wallet changed, so saving RAG to this device was stopped.", "Ví đã thay đổi; dừng lưu RAG về máy."), "AbortError");
      const imported = await importPortableRagPackage(packageData, restoreOwner);
      await refreshRagStatus();
      toast({ title: t("Knowledge base saved from Shelby", "Đã lưu kho từ Shelby về máy"), description: t(`${imported} documents are ready for offline use.`, `${imported} tài liệu đã sẵn sàng để dùng offline.`) });
    } catch (error) {
      toast({ title: t("Could not save the knowledge base to this device", "Không thể lưu kho về máy"), description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setRestoringRag(false);
    }
  };

  const handleReleaseLocalRag = async () => {
    if (!hasLocalRag || !window.confirm(t("Remove all RAG data from this device? Original blobs and the Shelby backup will not be deleted.", "Giải phóng toàn bộ RAG trên thiết bị này? Blob gốc và bản sao trên Shelby không bị xoá."))) return;
    const releaseOwner = accountAddress.toLowerCase();
    const cleared = await clearActiveRagWorkspace(releaseOwner);
    if (!cleared || activeOwnerRef.current !== releaseOwner) return;
    if (accountAddress) {
      try { localStorage.removeItem(`shelby-rag-explorer.chat-v1:${accountAddress.toLowerCase()}`); } catch { /* local cleanup is best-effort */ }
    }
    window.dispatchEvent(new Event("shelby:clear-chat"));
    await refreshRagStatus();
    toast({ title: t("On-device RAG removed", "Đã giải phóng RAG trên thiết bị"), description: t("Original blobs and the Shelby RAG backup are unchanged.", "Blob gốc và bản sao RAG trên Shelby vẫn được giữ nguyên.") });
  };

  const lifecycleTitle = loadErrorCopy
    ? loadErrorCopy.title
    : remoteSnapshot.status === "loading"
      ? t("Checking the Shelby knowledge base…", "Đang kiểm tra kho tri thức trên Shelby…")
    : !hasLocalRag && hasRemoteRag
      ? remoteSnapshot.status === "ready" && !remoteAssessment.fresh
        ? t("The Shelby knowledge base needs new data", "Kho trên Shelby cần bổ sung dữ liệu mới")
        : t("The Shelby knowledge base is ready for chat", "Kho trên Shelby sẵn sàng để chat")
      : pendingLocalBlobs.length
        ? t(`${pendingLocalBlobs.length} new or changed blobs need processing`, `${pendingLocalBlobs.length} blob mới hoặc thay đổi cần xử lý`)
        : needsRemoteUpload
          ? localRagLarge
            ? t("The on-device knowledge base is large · save it to Shelby", "Kho trên máy đã lớn · nên lưu lên Shelby")
            : t("On-device RAG is ready", "RAG trên máy đã sẵn sàng")
          : remoteFresh && localRagLarge
            ? t("Saved on Shelby · you can remove the on-device copy", "Đã lưu trên Shelby · có thể giải phóng bản trên máy")
            : remoteFresh
              ? t("The device and Shelby are in sync", "Bản trên máy và Shelby đã đồng bộ")
              : t("No knowledge base on this device yet", "Chưa có kho tri thức trên thiết bị");

  const pendingPreview = pendingLocalBlobs.slice(0, 3).map((blob) => getBlobName(blob)).join(", ");
  const lifecycleDescription = loadErrorCopy
    ? loadErrorCopy.description
    : remoteSnapshot.status === "error"
      ? t("The Shelby backup could not be read. Refresh the page or try again later.", "Không đọc được bản sao trên Shelby. Hãy làm mới trang hoặc thử lại sau.")
    : !hasLocalRag && hasRemoteRag
      ? remoteSnapshot.status === "ready" && !remoteAssessment.fresh
        ? t(
          `The Shelby backup is missing ${remoteDeltaCount} new or changed blobs. You can still chat with the older data; build the missing parts and save again.`,
          `Bản trên Shelby chưa có ${remoteDeltaCount} blob mới/thay đổi. Bạn vẫn chat được dữ liệu cũ; hãy tạo phần còn thiếu rồi lưu lại.`,
        )
        : t(
          `${remoteSnapshot.packageData?.documents.length ?? "?"} documents can be searched directly from Shelby. Save them to this device only for offline use or editing.`,
          `${remoteSnapshot.packageData?.documents.length ?? "?"} tài liệu có thể được tra cứu trực tiếp từ Shelby. Chỉ tải về máy nếu muốn dùng offline hoặc chỉnh sửa.`,
        )
      : pendingLocalBlobs.length
        ? t(
          `Needs processing: ${pendingPreview}${pendingLocalBlobs.length > 3 ? ` and ${pendingLocalBlobs.length - 3} more files` : ""}. These files are at the top of the list.`,
          `Cần xử lý: ${pendingPreview}${pendingLocalBlobs.length > 3 ? ` và ${pendingLocalBlobs.length - 3} tệp khác` : ""}. Các tệp này đã được đưa lên đầu danh sách.`,
        )
        : needsRemoteUpload
          ? t(
            `${ragMetrics.documents} documents · ${ragMetrics.chunks} chunks · ${formatStorage(localRagBytes)} on device. ${localRagLarge ? "Save it to Shelby to keep browser storage from growing." : "Next: save a backup to Shelby."}`,
            `${ragMetrics.documents} tài liệu · ${ragMetrics.chunks} chunks · ${formatStorage(localRagBytes)} trên máy. ${localRagLarge ? "Nên lưu lên Shelby để tránh kho trình duyệt tiếp tục phình to." : "Bước tiếp theo: lưu bản sao lên Shelby."}`,
          )
          : remoteFresh && localRagLarge
            ? t(
              `Chat can load relevant parts from Shelby on demand. Remove ${formatStorage(localRagBytes)} from this device to free up space.`,
              `Chat có thể đọc bản trên Shelby theo nhu cầu. Bạn có thể xóa ${formatStorage(localRagBytes)} trên máy để giải phóng dung lượng.`,
            )
            : remoteFresh
              ? t(
                `${ragMetrics.documents} documents on this device have the latest Shelby backup.`,
                `${ragMetrics.documents} tài liệu trên thiết bị đã có bản sao mới nhất trên Shelby.`,
              )
              : t(
                "Select eligible blobs and build RAG; you can still chat about general knowledge.",
                "Chọn blob đủ điều kiện rồi tạo RAG; bạn vẫn có thể chat kiến thức chung.",
              );

  return (
    <section className="section-surface flex h-full min-h-0 flex-col overflow-y-auto rounded-[20px] xl:overflow-hidden">
      <div className="flex min-h-full flex-col gap-2.5 p-3 sm:p-3.5 xl:h-full xl:min-h-0">
        {/* Header Section */}
        <div className="flex min-h-10 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[#172019] text-[#c5fb7e] dark:bg-[#c2f779] dark:text-[#101713]">
              <BookOpen className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-extrabold tracking-[-0.025em] text-[#101512] dark:text-white">{t("Shelby data library", "Kho dữ liệu Shelby")}</h2>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {loadErrorCopy
                  ? t(`Shelby unavailable · ${indexedSources.length} on-device documents`, `Shelby chưa khả dụng · ${indexedSources.length} tài liệu trên máy`)
                  : t(`${blobs.length} blobs · ${indexedSources.length} on-device documents`, `${blobs.length} blobs · ${indexedSources.length} tài liệu trên máy`)}{hasLocalRag ? ` · ${formatStorage(localRagBytes)}` : ""}
              </p>
            </div>
          </div>

        </div>

        {/* Indexing Stepper & Lifecycle status */}
        {indexingAll ? (
          <IndexingStepper indexingAll={indexingAll} indexProgress={indexProgress} indexLogs={indexLogs} onCancel={cancelIndexing} />
        ) : (
          <div data-testid="rag-lifecycle" className={`rounded-xl px-3.5 py-3 relative overflow-hidden transition-all duration-300 ${needsRemoteUpload ? "bg-gradient-to-r from-lime-100/90 to-lime-50/50 dark:from-lime-300/[0.1] dark:to-lime-300/[0.02] border border-lime-200/50 dark:border-lime-300/10" : remoteFresh ? "bg-gradient-to-r from-emerald-50/90 to-transparent dark:from-emerald-400/[0.05] dark:to-transparent border border-emerald-100/50 dark:border-emerald-300/10" : "bg-gradient-to-r from-[#f0f2ed] to-transparent dark:from-white/[0.035] dark:to-transparent border border-transparent dark:border-white/[0.02]"}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between relative z-10">
              <div className="flex min-w-0 items-center gap-3.5">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm ${needsRemoteUpload ? "bg-gradient-to-br from-[#c2f779] to-[#9ede47] text-[#101713] glow-border" : remoteFresh ? "bg-gradient-to-br from-[#1b7151] to-[#26946b] text-white" : "bg-[#dde2da] text-[#69736c] dark:bg-white/10 dark:text-slate-300"}`}>
                  {remoteSnapshot.status === "loading" ? <Cloud className="h-4 w-4" /> : needsRemoteUpload ? <Upload className="h-4 w-4" /> : remoteFresh ? <Cloud className="h-4 w-4" /> : hasLocalRag ? <HardDrive className="h-4 w-4" /> : <ScanText className="h-4 w-4" />}
                </div>
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-slate-900 dark:text-white">
                    {lifecycleTitle}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                    {lifecycleDescription}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                {!hasLocalRag && hasRemoteRag && <Button size="sm" disabled={indexingAll || restoringRag || remoteSnapshot.status === "loading"} className="h-8 rounded-lg bg-slate-950 px-3.5 text-[11px] font-extrabold text-white shadow-sm hover:bg-slate-800 transition-all hover:-translate-y-0.5 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200" onClick={() => void handleRestoreRemoteRag()}><Cloud className="mr-1.5 h-3.5 w-3.5" />{restoringRag ? t("Saving to device…", "Đang lưu về máy…") : t("Save to device (optional)", "Lưu về máy (tuỳ chọn)")}</Button>}
                {pendingLocalBlobs.length > 0 && <Button size="sm" className="h-8 rounded-lg bg-[#172019] px-3.5 text-[11px] font-bold text-[#c5fb7e] shadow-sm hover:-translate-y-0.5 transition-all hover:bg-[#263029] dark:bg-lime-300 dark:text-slate-950" onClick={() => void handleIndexBlobs(pendingLocalBlobs)}><ScanText className="mr-1.5 h-3.5 w-3.5" />{t("Build RAG", "Tạo RAG")}</Button>}
                <Button size="sm" disabled={!needsRemoteUpload || syncingRag || uploading} className="h-8 rounded-lg bg-[#172019] px-3.5 text-[11px] font-bold text-[#c5fb7e] shadow-sm hover:-translate-y-0.5 transition-all hover:bg-[#263029] disabled:bg-transparent disabled:text-slate-400 disabled:hover:translate-y-0 dark:bg-lime-300 dark:text-slate-950 dark:disabled:bg-transparent dark:disabled:text-slate-600" onClick={() => void handleUploadRagSnapshot()}><Upload className="mr-1.5 h-3.5 w-3.5" />{syncingRag || uploading ? t("Saving…", "Đang lưu…") : !hasLocalRag || pendingLocalBlobs.length ? t("Sync", "Đồng bộ") : remoteFresh ? t("Synced", "Đã đồng bộ") : t("Save backup to Shelby", "Lưu bản sao lên Shelby")}</Button>
                {hasLocalRag && <Button size="sm" variant="ghost" className="h-8 rounded-lg px-2.5 text-[11px] font-semibold text-slate-500 hover:bg-rose-50 hover:text-rose-700 transition-colors dark:text-slate-400 dark:hover:bg-rose-500/10 dark:hover:text-rose-300" onClick={() => void handleReleaseLocalRag()}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{t("Remove on-device RAG", "Xóa RAG trên máy")}</Button>}
              </div>
            </div>
          </div>
        )}

        {/* Tab switcher */}
        <div className="grid grid-cols-4 rounded-xl bg-[#ecefe9] p-1 dark:bg-black/20" role="tablist" aria-label={t("Knowledge base sections", "Các khu vực kho dữ liệu")}>
          <button
            role="tab"
            aria-selected={activeTab === "library"}
            onClick={() => setActiveTab("library")}
            className={`tab-bar-item flex-1 ${activeTab === "library" ? "tab-bar-item-active" : "tab-bar-item-inactive"}`}
          >
            <BookOpen className="w-3.5 h-3.5 mr-1" />
            {t("Documents", "Tài liệu")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "upload"}
            onClick={() => setActiveTab("upload")}
            className={`tab-bar-item flex-1 ${activeTab === "upload" ? "tab-bar-item-active" : "tab-bar-item-inactive"}`}
          >
            <UploadCloud className="w-3.5 h-3.5 mr-1" />
            {t("Upload", "Tải lên")}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "capsule"}
            onClick={() => setActiveTab("capsule")}
            className={`tab-bar-item relative flex-1 ${activeTab === "capsule" ? "tab-bar-item-active" : "tab-bar-item-inactive"}`}
          >
            <Archive className="mr-1 h-3.5 w-3.5" />
            {t("Backup", "Sao lưu")}
            {(needsRemoteUpload || (!hasLocalRag && hasRemoteRag)) && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-amber-500" aria-label={t("Backup needs attention", "Bản sao cần cập nhật")} />}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "config"}
            onClick={() => setActiveTab("config")}
            className={`tab-bar-item flex-1 ${activeTab === "config" ? "tab-bar-item-active" : "tab-bar-item-inactive"}`}
          >
            <Settings className="w-3.5 h-3.5 mr-1" />
            {t("Settings", "Cấu hình")}
          </button>
        </div>

        {/* TAB 1: LIBRARY */}
        {activeTab === "library" && (
          <BlobLibrary
            account={account}
            blobs={libraryBlobs}
            selectedBlobNames={selectedBlobNames}
            setSelectedBlobNames={setSelectedBlobNames}
            ragSources={ragSources}
            refreshRagStatus={refreshRagStatus}
            indexingAll={indexingAll}
            loading={loading}
            loadError={loadError}
            fetchBlobs={fetchBlobs}
            handleIndexBlobs={handleIndexBlobs}
            pendingBlobNames={pendingBlobNames}
            mockPurchasedBlobNames={mockPurchasedBlobNames}
            isPurchasableAndLocked={isPurchasableAndLocked}
            handlePurchaseAccess={handlePurchaseAccess}
            onOpenUpload={() => setActiveTab("upload")}
            fullPdfOcr={fullPdfOcr}
            ragChunkSize={ragChunkSize}
            effectiveEmbeddingMode={effectiveEmbeddingMode}
          />
        )}

        {/* TAB 2: UPLOAD */}
        {activeTab === "upload" && (
          <UploadZone
            account={account}
            uploading={uploading}
            uploadProgress={uploadProgress}
            uploadFiles={uploadFiles}
          />
        )}

        {/* TAB 3: MEMORY CAPSULE */}
        {activeTab === "capsule" && (
          <MemoryCapsulePanel
            hasLocalRag={hasLocalRag}
            hasRemoteRag={hasRemoteRag}
            remoteStatus={remoteSnapshot.status}
            remoteError={remoteSnapshot.error}
            remoteFresh={remoteFresh}
            needsRemoteUpload={needsRemoteUpload}
            pendingCount={pendingLocalBlobs.length}
            remoteDeltaCount={remoteDeltaCount}
            remoteBlobName={remoteBlobName}
            remoteCreatedAtMicros={remoteBlobCreation}
            remoteMerkleRoot={merkleRootHex(newestRemoteRagBlob?.blobMerkleRoot)}
            uploadBlobName={backupBlobName}
            remotePartCount={remoteSnapshot.hotManifest?.shards.length}
            remoteTotalBytes={remoteSnapshot.hotManifest?.totals.bytes}
            metrics={ragMetrics}
            localRagBytes={localRagBytes}
            localRagLarge={localRagLarge}
            syncing={syncingRag || uploading}
            indexing={indexingAll || restoringRag}
            onRestore={() => void handleRestoreRemoteRag()}
            onIndexChanges={() => void handleIndexBlobs(pendingLocalBlobs)}
            onSync={() => void handleUploadRagSnapshot()}
            onDownload={() => void handleDownloadRagCapsule()}
            onRelease={() => void handleReleaseLocalRag()}
          />
        )}

        {/* TAB 4: CONFIG */}
        {activeTab === "config" && (
          <RagConfigPanel
            fullPdfOcr={fullPdfOcr}
            setFullPdfOcr={setFullPdfOcr}
            embeddingMode={embeddingMode}
            setEmbeddingMode={setEmbeddingMode}
            ragChunkSize={ragChunkSize}
            setRagChunkSize={setRagChunkSize}
            ragSources={ragSources}
          />
        )}
      </div>
    </section>
  );
}
