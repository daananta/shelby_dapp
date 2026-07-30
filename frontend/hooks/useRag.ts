import { useState, useEffect, useRef } from "react";
import { useToast } from "@/components/ui/use-toast";
import { getShelbyBlobUrl } from "@/utils/shelbyConfig";
import { getBlobAccessDecision, isRagSourceEligible, downloadBlobForRag } from "@/utils/blobAccess";
import { sniffRagContent, unsupportedContentReason } from "@/utils/contentSniffer";
import { deactivateActiveRagOwner, getVectorDB, getRagSources, replaceDocument, recordSourceSkipped, recordSourceFailure, importPortableRagPackage, flushVectorDB, setActiveRagOwner, type RagSource } from "@/utils/ragOrama";
import { extractPagesFromUrl, inferDocumentMetadata, chunkText, normalizeSearchText, isUsefulExtractedText } from "@/utils/textExtractor";
import { ocrPdfPages } from "@/utils/pdfOcr";
import { embedTexts, type EmbeddingProvider } from "@/utils/embeddingClient";
import { describeImageWithCloud, describeVideoWithCloud, getStoredCloudApiKey } from "@/utils/aiProvider";
import type { ChunkRecord, DocumentManifest, PageRecord, StoryEntry } from "@/utils/ragTypes";
import { extractStoryEntries } from "@/utils/ragOrama";
import { blobPipelineRevision, needsLocalIndex, ragPipelineRevision } from "@/utils/ragLifecycle";
import { sha256Text } from "@/utils/contentIntegrity";
import { getCloudErrorKind } from "@/utils/aiProvider";
import { useGeminiUsage } from "@/hooks/useGeminiUsage";
import { localize } from "@/i18n";
import type { RagIndexLog, RagIndexProgress, RagIndexStage } from "@/utils/ragProgress";

const RAG_OPTIONS_STORAGE_KEY = "shelby-rag-explorer.rag-options-v1";


function loadRagOptions() {
  try {
    const value = JSON.parse(localStorage.getItem(RAG_OPTIONS_STORAGE_KEY) ?? "{}");
    const embeddingMode = ["gemini", "gateway"].includes(value.embeddingMode)
      ? value.embeddingMode as EmbeddingProvider
      : "gemini";
    return {
      fullPdfOcr: typeof value.fullPdfOcr === "boolean" ? value.fullPdfOcr : false,
      embeddingMode,
      ragChunkSize: [800, 1200, 1600].includes(value.ragChunkSize) ? value.ragChunkSize : 1_200,
    };
  } catch {
    return { fullPdfOcr: false, embeddingMode: "gemini" as const, ragChunkSize: 1_200 };
  }
}

export function useRag(account: any, signMessage: any) {
  const { toast } = useToast();
  const { preferences: geminiUsage } = useGeminiUsage();
  const [ragSources, setRagSources] = useState<RagSource[]>([]);
  const [indexingAll, setIndexingAll] = useState(false);
  const [indexProgress, setIndexProgress] = useState<RagIndexProgress | null>(null);
  const [indexLogs, setIndexLogs] = useState<RagIndexLog[]>([]);

  const options = loadRagOptions();
  const [fullPdfOcr, setFullPdfOcr] = useState(options.fullPdfOcr);
  const [embeddingMode, setEmbeddingMode] = useState<EmbeddingProvider>(options.embeddingMode);
  const [ragChunkSize, setRagChunkSize] = useState(options.ragChunkSize);

  const cancelIndexRef = useRef(false);
  const indexControllerRef = useRef<AbortController | null>(null);
  const indexGenerationRef = useRef(0);
  const semanticUnavailableRef = useRef(false);
  const ownerKey = account?.address?.toString().toLowerCase() ?? "";
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const MAX_INDEX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_CHUNKS_PER_FILE = 3_000;

  const effectiveEmbeddingMode: EmbeddingProvider | "off" = geminiUsage.semanticSearch ? embeddingMode : "off";
  const activePipelineRevision = ragPipelineRevision({ fullPdfOcr, cloudContentAnalysis: geminiUsage.contentAnalysis, embeddingMode: effectiveEmbeddingMode, ragChunkSize });

  useEffect(() => {
    try {
      localStorage.setItem(RAG_OPTIONS_STORAGE_KEY, JSON.stringify({ fullPdfOcr, embeddingMode, ragChunkSize }));
    } catch {
      // Configuration remains active in-memory when persistence is unavailable.
    }
  }, [fullPdfOcr, embeddingMode, ragChunkSize]);

  useEffect(() => {
    const refresh = () => { void refreshRagStatus(); };
    window.addEventListener("shelby:rag-state", refresh);
    return () => window.removeEventListener("shelby:rag-state", refresh);
  }, [ownerKey]);

  const refreshRagStatus = async (expectedOwner = ownerKeyRef.current) => {
    await getVectorDB();
    if (!expectedOwner || ownerKeyRef.current !== expectedOwner) return;
    setRagSources(getRagSources());
  };

  const getBlobName = (blob: any) => blob.blobNameSuffix ?? blob.name;
  const getDisplayName = (name: string, blob?: any) => {
    if (blob?.metadata?.displayName) return blob.metadata.displayName;
    const parts = name.split("/");
    return parts.length > 1 ? parts[parts.length - 1] : name;
  };
  const isImage = (name: string) => /\.(jpg|jpeg|png|gif|webp)$/i.test(name);
  const isVideo = (name: string) => /\.(mp4|m4v|mov)$/i.test(name);
  const sourceType = (name: string): DocumentManifest["type"] => isImage(name) ? "image" : isVideo(name) ? "video" : "text";
  const blobMerkleRoot = (blob: any): string | undefined => {
    const value = blob?.blobMerkleRoot;
    if (typeof value === "string") return value.startsWith("0x") ? value : `0x${value}`;
    if (value instanceof Uint8Array || Array.isArray(value)) return `0x${Array.from(value as ArrayLike<number>, (byte) => Number(byte).toString(16).padStart(2, "0")).join("")}`;
    return undefined;
  };
  const blobProof = (blob: any) => ({
    blobId: blob?.blobId ? String(blob.blobId) : undefined,
    blobMerkleRoot: blobMerkleRoot(blob),
    blobSize: Number.isFinite(Number(blob?.size)) ? Number(blob.size) : undefined,
    blobCreatedAtMicros: Number.isFinite(Number(blob?.creationMicros)) ? Number(blob.creationMicros) : undefined,
  });

  const addSemanticEmbeddings = async (
    chunkRecords: ChunkRecord[],
    setStage: (detail: string, stage: RagIndexStage) => void,
    signal?: AbortSignal,
  ) => {
    let embeddingStatus: DocumentManifest["embeddingStatus"] = "unavailable";
    const resolvedEmbeddingProvider: EmbeddingProvider | null = effectiveEmbeddingMode === "off" ? null : effectiveEmbeddingMode;
    if (!resolvedEmbeddingProvider) return { embeddingStatus, embeddingProvider: null as EmbeddingProvider | null };
    if (semanticUnavailableRef.current) return { embeddingStatus: "failed" as const, embeddingProvider: resolvedEmbeddingProvider };
    const cloudKey = getStoredCloudApiKey();
    if (resolvedEmbeddingProvider === "gemini" && !cloudKey) return { embeddingStatus, embeddingProvider: resolvedEmbeddingProvider };
    embeddingStatus = "ready";
    try {
      setStage(localize("Creating semantic search data", "Tạo dữ liệu tìm kiếm theo ý nghĩa"), "embed");
      const embeddings = await embedTexts(
        chunkRecords.map((chunk) => chunk.text),
        "passage",
        (detail) => setStage(detail, "embed"),
        resolvedEmbeddingProvider,
        cloudKey,
        signal,
      );
      signal?.throwIfAborted();
      embeddings.forEach((embedding, index) => {
        if (!chunkRecords[index]) return;
        chunkRecords[index].embedding = embedding;
        chunkRecords[index].embeddingProvider = resolvedEmbeddingProvider;
      });
      if (embeddings.length !== chunkRecords.length) embeddingStatus = "failed";
    } catch (embeddingError) {
      embeddingStatus = "failed";
      if (resolvedEmbeddingProvider === "gateway" || getCloudErrorKind(embeddingError) === "rate_limit" || getCloudErrorKind(embeddingError) === "invalid_key") semanticUnavailableRef.current = true;
      console.warn("Cloud embeddings unavailable; keyword search remains available.", embeddingError);
    }
    return { embeddingStatus, embeddingProvider: resolvedEmbeddingProvider };
  };

  const handleIndexBlobs = async (targetBlobs: any[], options: { force?: boolean } = {}) => {
    if (!account || !ownerKey) return;
    const runOwner = ownerKey;
    const eligibleTargets = targetBlobs.filter((blob) => isRagSourceEligible(blob, runOwner));
    if (!eligibleTargets.length) {
      toast({
        title: localize("No eligible blobs to process", "Không có blob phù hợp để tạo RAG"),
        description: localize(
          "Only public blobs and unlocked time-locked blobs can be added.",
          "Chỉ blob public và time lock đã mở khóa mới được đưa vào hàng đợi.",
        ),
      });
      return;
    }

    indexControllerRef.current?.abort();
    const controller = new AbortController();
    indexControllerRef.current = controller;
    const runGeneration = ++indexGenerationRef.current;
    const isCurrentRun = () => indexGenerationRef.current === runGeneration && ownerKeyRef.current === runOwner;
    const throwIfStale = () => {
      controller.signal.throwIfAborted();
      if (!isCurrentRun()) throw new DOMException(localize("The wallet changed; the previous RAG run was stopped.", "Ví đã thay đổi; dừng tạo RAG cũ."), "AbortError");
    };

    try {
      setIndexingAll(true);
      cancelIndexRef.current = false;
      semanticUnavailableRef.current = false;
      let cloudContentKey = geminiUsage.contentAnalysis ? getStoredCloudApiKey() : "";
      setIndexLogs([{
        at: Date.now(),
        text: localize(
          `Preparing ${eligibleTargets.length} eligible public or unlocked blobs.`,
          `Bắt đầu tạo RAG từ ${eligibleTargets.length} blob public/time lock đủ điều kiện.`,
        ),
        stage: "prepare",
      }]);
      setIndexProgress({
        done: 0,
        total: eligibleTargets.length,
        currentName: "",
        stage: "prepare",
        detail: localize("Preparing", "Chuẩn bị"),
      });
      toast({ title: localize(`Building RAG from ${eligibleTargets.length} files…`, `Tạo RAG từ ${eligibleTargets.length} tệp…`) });

      let failed = 0;
      let skipped = 0;
      let cancelled = false;

      for (let i = 0; i < eligibleTargets.length; i++) {
        if (cancelIndexRef.current || controller.signal.aborted || !isCurrentRun()) {
          cancelled = true;
          break;
        }
        const b = eligibleTargets[i];
        const blobName = getBlobName(b);
        const ownerAddress = runOwner;
        const publicUrl = getShelbyBlobUrl(ownerAddress, blobName);
        const displayName = getDisplayName(blobName, b);

        const setStage = (detail: string, stage: RagIndexStage) => {
          if (!isCurrentRun() || controller.signal.aborted) return;
          setIndexProgress({ done: i, total: eligibleTargets.length, currentName: displayName, stage, detail });
          setIndexLogs((previous) => [...previous, { at: Date.now(), text: `${displayName}: ${detail}`, detail, stage }].slice(-7));
        };

        setStage(localize("Checking access", "Kiểm tra quyền truy cập"), "access");

        try {
          const access = getBlobAccessDecision(b, ownerAddress);
          const revision = blobPipelineRevision(b, access.info.tag, activePipelineRevision);
          if (!isRagSourceEligible(b, ownerAddress)) {
            await recordSourceSkipped(
              { source: blobName, displayName, blobUrl: access.info.tag === "public" ? publicUrl : undefined, type: sourceType(blobName), revision },
              access.reason ?? localize("This blob is not eligible for RAG.", "Blob không đủ điều kiện để tạo RAG."),
              runOwner,
            );
            setIndexLogs((previous) => [...previous, {
              at: Date.now(),
              text: localize(`${displayName}: skipped — ${access.reason ?? "not eligible"}`, `${displayName}: bỏ qua — ${access.reason ?? "không đủ điều kiện"}`),
              stage: "complete" as const,
            }].slice(-7));
            setIndexProgress({ done: i + 1, total: eligibleTargets.length, currentName: displayName, stage: "complete", detail: localize("Skipped", "Bỏ qua") });
            continue;
          }

          if (Number(b.size ?? 0) > MAX_INDEX_FILE_BYTES) {
            await recordSourceSkipped(
              { source: blobName, displayName, blobUrl: access.info.tag === "public" ? publicUrl : undefined, type: sourceType(blobName), revision },
              localize("Exceeds the safe 25 MB per-file limit.", "Vượt giới hạn an toàn 25 MB/tệp."),
              runOwner,
            );
            skipped += 1;
            setIndexProgress({ done: i + 1, total: eligibleTargets.length, currentName: displayName, stage: "complete", detail: localize("Skipped", "Bỏ qua") });
            continue;
          }

          const owner = runOwner;
          const documentId = `${owner}:${blobName}`;
          const existing = ragSources.find((source) => source.source === blobName);

          if (!options.force && !needsLocalIndex(existing, revision)) {
            setStage(localize("Unchanged · keeping the current index", "Không thay đổi · giữ index hiện tại"), "complete");
            setIndexProgress({ done: i + 1, total: eligibleTargets.length, currentName: displayName, stage: "complete", detail: localize("Up to date", "Đã cập nhật") });
            continue;
          }

          if (b.isDemoBlob) {
            setStage(localize("Loading sample RAG", "Đang nạp demo RAG"), "extract");
            const rawText = b.demoText;
            const manifest: DocumentManifest = {
              id: documentId, owner, source: blobName, displayName, revision, blobUrl: "", accessTag: access.info.tag, ...blobProof(b), mimeType: "text/plain", type: "text", aliases: [], authors: [], pageCount: 1, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: Date.now()
            };
            const normalizedText = normalizeSearchText(rawText);
            const pageRecord: PageRecord = {
              id: `${documentId}:page:1`, owner, documentId, source: blobName, displayName, pageNumber: 1, totalPages: 1, rawText, normalizedText, contentHash: await sha256Text(normalizedText), extractionMethod: "text_layer"
            };
            const chunkRecord: ChunkRecord = {
              id: `${documentId}:chunk:0`, owner, documentId, source: blobName, displayName, type: "text", text: rawText, normalizedText, contentHash: await sha256Text(normalizedText), pageNumber: 1, totalPages: 1
            };
            throwIfStale();
            await replaceDocument({ manifest, pages: [pageRecord], chunks: [chunkRecord], stories: [] });
            setIndexProgress({ done: i + 1, total: eligibleTargets.length, currentName: displayName, stage: "complete", detail: localize("Complete", "Hoàn tất") });
            continue;
          }

          setStage(
            access.needsBroker
              ? localize("Verifying wallet and downloading blob", "Xác thực ví và tải blob")
              : localize("Downloading blob", "Tải blob"),
            "download",
          );
          const downloaded = await downloadBlobForRag({ owner: ownerAddress, blobName, blob: b, walletAddress: ownerAddress, signMessage, signal: controller.signal });
          throwIfStale();
          const url = downloaded.url;

          try {
            setStage(localize("Identifying file content", "Nhận diện nội dung từ bytes"), "detect");
            const detected = await sniffRagContent(downloaded.content);
            throwIfStale();
            if (detected.kind === "unsupported") {
              const reason = unsupportedContentReason(detected);
              await recordSourceSkipped({ source: blobName, displayName, blobUrl: downloaded.blobUrl, type: "text", revision }, reason, runOwner);
              skipped += 1;
              setIndexLogs((previous) => [...previous, {
                at: Date.now(),
                text: localize(`${displayName}: skipped — ${detected.format}`, `${displayName}: bỏ qua — ${detected.format}`),
                stage: "complete" as const,
              }].slice(-7));
              setIndexProgress({ done: i + 1, total: eligibleTargets.length, currentName: displayName, stage: "complete", detail: localize("Skipped", "Bỏ qua") });
              continue;
            }

            const inputKind = detected.kind;
            if (inputKind === "package") {
              setStage(localize("Importing the RAG backup", "Nhập gói RAG portable"), "extract");
              const packageData = JSON.parse(await downloaded.content.text());
              throwIfStale();
              const imported = await importPortableRagPackage(packageData, runOwner, controller.signal);
              throwIfStale();
              toast({ title: localize(`Imported ${imported} documents from the RAG backup.`, `Đã nhập ${imported} tài liệu từ gói RAG.`) });
            } else if (inputKind === "image") {
              setStage(localize("Reading image", "Phân tích ảnh"), "extract");
              let description: string | null = null;
              if (cloudContentKey) {
                try {
                  description = await describeImageWithCloud(url, displayName, cloudContentKey, controller.signal, detected.mimeType);
                  throwIfStale();
                } catch (visionError) {
                  if (controller.signal.aborted || !isCurrentRun() || (visionError instanceof DOMException && visionError.name === "AbortError")) throw visionError;
                  if (getCloudErrorKind(visionError) === "rate_limit" || getCloudErrorKind(visionError) === "invalid_key") cloudContentKey = "";
                  console.warn("Cloud image analysis unavailable; keeping a local image descriptor.", visionError);
                  setIndexLogs((previous) => [...previous, {
                    at: Date.now(),
                    text: localize(
                      `${displayName}: preview indexed; AI can inspect the image again when needed.`,
                      `${displayName}: đã index preview; AI có thể xem lại ảnh khi cần.`,
                    ),
                    stage: "extract" as const,
                  }].slice(-7));
                }
              }
              const text = description
                ? `[Image]\nFile name: ${displayName}\n\nAI description: ${description}`
                : `[Image]\nFile name: ${displayName}\nDescription unavailable.`;
              const manifest: DocumentManifest = { id: documentId, owner, source: blobName, displayName, revision, blobUrl: downloaded.blobUrl, accessTag: access.info.tag, ...blobProof(b), mimeType: detected.mimeType, type: "image", aliases: [], authors: [], pageCount: 0, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: Date.now() };
              const normalizedText = normalizeSearchText(text);
              const chunk: ChunkRecord = { id: `${documentId}:chunk:0`, owner, documentId, source: blobName, displayName, type: "image", text, normalizedText, contentHash: await sha256Text(normalizedText), pageNumber: 0, totalPages: 0, imageUrl: downloaded.blobUrl };
              throwIfStale();
              await replaceDocument({ manifest, pages: [], chunks: [chunk], stories: [] });
            } else if (inputKind === "video") {
              if (!geminiUsage.contentAnalysis) throw new Error(localize(
                "Video reading is turned off. Enable “Read images, PDFs, and videos” in Settings, then try again.",
                "Tính năng đọc video đang tắt. Hãy bật “Đọc ảnh, PDF và video” trong Cấu hình rồi thử lại.",
              ));
              if (!cloudContentKey) throw new Error(localize(
                "An active Gemini API key is required to understand video content and speech.",
                "Video cần Gemini API key đang hoạt động để nhận dạng nội dung và lời nói.",
              ));
              setStage(localize("Reading video with Gemini", "Phân tích video với Gemini"), "extract");
              const videoText = await describeVideoWithCloud(downloaded.content, displayName, cloudContentKey, controller.signal);
              throwIfStale();
              const normalizedPageText = normalizeSearchText(videoText);
              const page: PageRecord = {
                id: `${documentId}:page:0`, owner, documentId, source: blobName, displayName,
                pageNumber: 0, totalPages: 0, rawText: videoText, normalizedText: normalizedPageText,
                contentHash: await sha256Text(normalizedPageText), extractionMethod: "cloud_video",
              };
              const chunkRecords: ChunkRecord[] = [];
              for (const text of chunkText(videoText, ragChunkSize)) {
                const normalizedText = normalizeSearchText(text);
                chunkRecords.push({
                  id: `${documentId}:chunk:${chunkRecords.length}`, owner, documentId, source: blobName, displayName,
                  type: "video", text, normalizedText, contentHash: await sha256Text(normalizedText), pageNumber: 0, totalPages: 0,
                });
              }
              if (!chunkRecords.length) throw new Error(localize("No searchable content could be created from this video.", "Không tạo được nội dung tìm kiếm từ video."));
              const semantic = await addSemanticEmbeddings(chunkRecords, setStage, controller.signal);
              throwIfStale();
              setStage(localize("Saving search index", "Lưu chỉ mục tìm kiếm"), "save");
              const manifest: DocumentManifest = {
                id: documentId, owner, source: blobName, displayName, revision, blobUrl: downloaded.blobUrl,
                accessTag: access.info.tag, ...blobProof(b), mimeType: detected.mimeType, type: "video",
                title: { value: displayName, confidence: 1, provenance: "filename", userLocked: false }, aliases: [], authors: [],
                pageCount: 0, chunkCount: chunkRecords.length, ocrCoverage: 0, textCoverage: 1,
                embeddingStatus: semantic.embeddingStatus, embeddingProvider: semantic.embeddingProvider ?? undefined,
                status: "indexed", indexedAt: Date.now(),
              };
              throwIfStale();
              await replaceDocument({ manifest, pages: [page], chunks: chunkRecords, stories: [] });
            } else {
              setStage(
                detected.mimeType === "application/pdf"
                  ? localize("Reading PDF text", "Đọc text PDF")
                  : localize(`Reading ${detected.format}`, `Đọc ${detected.format}`),
                "extract",
              );
              const extractedPages = await extractPagesFromUrl(
                url,
                blobName,
                500,
                (detail) => setStage(detail, "extract"),
                detected.mimeType,
                controller.signal,
              );
              throwIfStale();
              let ocrResult: Awaited<ReturnType<typeof ocrPdfPages>> = { pages: [], attemptedPages: 0 };

              if (detected.mimeType === "application/pdf") {
                try {
                  setStage(localize("Reading pages with little text", "OCR trang ít chữ"), "ocr");
                  ocrResult = await ocrPdfPages(
                    url,
                    extractedPages,
                    fullPdfOcr,
                    (detail) => setStage(detail, "ocr"),
                    () => cancelIndexRef.current,
                    cloudContentKey,
                    controller.signal,
                  );
                } catch (ocrError) {
                  console.warn("OCR unavailable; continuing with the document text layer.", ocrError);
                }
              }
              if (ocrResult.cancelled || cancelIndexRef.current || controller.signal.aborted || !isCurrentRun()) { cancelled = true; break; }

              const ocrByPage = new Map(ocrResult.pages.map((page) => [page.pageNumber, page]));
              const pageRecords: PageRecord[] = await Promise.all(extractedPages.map(async (page) => {
                const ocrPage = ocrByPage.get(page.pageNumber);
                const ocrText = ocrPage?.text ?? "";
                const useOcr = isUsefulExtractedText(ocrText) && (
                  !isUsefulExtractedText(page.text)
                  || (fullPdfOcr && ocrText.length > page.text.length * 1.15)
                );
                const rawText = useOcr ? ocrText : page.text;
                const normalizedText = normalizeSearchText(rawText);
                return { id: `${documentId}:page:${page.pageNumber}`, owner, documentId, source: blobName, displayName, pageNumber: page.pageNumber, totalPages: page.totalPages, rawText, normalizedText, contentHash: await sha256Text(normalizedText), extractionMethod: useOcr ? ocrPage!.method : "text_layer" };
              }));

              const inferred = inferDocumentMetadata(extractedPages, displayName, ocrByPage.get(1)?.text ?? "", undefined, existing?.titleMetadata);
              const chunkRecords: ChunkRecord[] = [];
              const stories: StoryEntry[] = [];

              for (const page of pageRecords) {
                if (cancelIndexRef.current) break;
                for (const story of extractStoryEntries(blobName, page.pageNumber, page.rawText)) if (!stories.some((item) => item.number === story.number)) stories.push(story);
                for (const text of chunkText(page.rawText, ragChunkSize)) {
                  if (chunkRecords.length >= MAX_CHUNKS_PER_FILE) throw new Error(localize(
                    `Exceeds the safe limit of ${MAX_CHUNKS_PER_FILE} chunks per file.`,
                    `Vượt giới hạn an toàn ${MAX_CHUNKS_PER_FILE} chunks/tệp.`,
                  ));
                  const normalizedText = normalizeSearchText(text);
                  chunkRecords.push({ id: `${documentId}:chunk:${chunkRecords.length}`, owner, documentId, source: blobName, displayName, type: "text", text, normalizedText, contentHash: await sha256Text(normalizedText), pageNumber: page.pageNumber, totalPages: page.totalPages });
                }
              }
              if (cancelIndexRef.current) { cancelled = true; break; }
              if (!chunkRecords.length) {
                throw new Error(localize(
                  "No text could be extracted. If this is a scanned PDF, enable OCR for every page and try again.",
                  "Không trích xuất được văn bản để tạo chunk. Nếu đây là PDF scan, hãy bật OCR toàn bộ rồi thử lại.",
                ));
              }

              const semantic = await addSemanticEmbeddings(chunkRecords, setStage, controller.signal);
              throwIfStale();

              setStage(localize("Saving search index", "Lưu chỉ mục tìm kiếm"), "save");
              const nonEmptyPages = pageRecords.filter((page) => page.rawText.trim().length >= 30).length;
              const appliedOcrPages = pageRecords.filter((page) => page.extractionMethod !== "text_layer").length;
              const manifest: DocumentManifest = { id: documentId, owner, source: blobName, displayName, revision, blobUrl: downloaded.blobUrl, accessTag: access.info.tag, ...blobProof(b), mimeType: detected.mimeType, type: "text", title: inferred.title, aliases: [...new Set([...(existing?.aliases ?? []), ...inferred.aliases])], authors: inferred.authors, pageCount: pageRecords.length, chunkCount: chunkRecords.length, ocrCoverage: pageRecords.length ? appliedOcrPages / pageRecords.length : 0, textCoverage: pageRecords.length ? nonEmptyPages / pageRecords.length : 0, embeddingStatus: semantic.embeddingStatus, embeddingProvider: semantic.embeddingProvider ?? undefined, status: "indexed", indexedAt: Date.now() };
              throwIfStale();
              await replaceDocument({ manifest, pages: pageRecords, chunks: chunkRecords, stories });
            }
          } finally {
            downloaded.dispose();
          }

          if (cancelIndexRef.current) {
            cancelled = true;
            break;
          }
        } catch (err) {
          if (controller.signal.aborted || !isCurrentRun() || (err instanceof DOMException && err.name === "AbortError")) {
            cancelled = true;
            break;
          }
          failed += 1;
          const failedAccess = getBlobAccessDecision(b, ownerAddress);
          await recordSourceFailure({ source: blobName, displayName, blobUrl: failedAccess.info.tag === "public" ? publicUrl : undefined, type: sourceType(blobName), revision: blobPipelineRevision(b, failedAccess.info.tag, activePipelineRevision) }, err, runOwner);
          toast({
            title: localize(`Could not process ${displayName}`, `Không thể nạp ${displayName}`),
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        }

        setIndexProgress({ done: i + 1, total: eligibleTargets.length, currentName: displayName, stage: "complete", detail: localize("Complete", "Hoàn tất") });
      }

      if (isCurrentRun()) {
        await flushVectorDB();
        await refreshRagStatus(runOwner);
      }
      if (isCurrentRun()) {
        toast({
          title: cancelled
            ? localize("RAG build stopped", "Đã dừng tạo RAG")
            : failed || skipped
              ? localize(`RAG complete · ${failed} failed · ${skipped} skipped`, `RAG hoàn tất · ${failed} lỗi · ${skipped} bỏ qua`)
              : localize("On-device RAG is ready", "RAG local đã sẵn sàng"),
          description: failed
            ? localize("Open each blob's status to see the cause and try again.", "Mở trạng thái từng blob để xem nguyên nhân và thử nạp lại.")
            : skipped
              ? localize("Unsupported files were preserved and not misread.", "Các định dạng chưa hỗ trợ được giữ nguyên và không bị đọc nhầm.")
              : localize("The knowledge base is ready for chat.", "Kho tri thức đã sẵn sàng cho chat."),
        });
      }
    } catch (error: any) {
      if (isCurrentRun() && !controller.signal.aborted) toast({ title: localize("Error", "Lỗi"), description: error.message, variant: "destructive" });
    } finally {
      if (isCurrentRun()) {
        setIndexingAll(false);
        setIndexProgress(null);
        if (indexControllerRef.current === controller) indexControllerRef.current = null;
      }
    }
  };

  const cancelIndexing = () => {
    cancelIndexRef.current = true;
    indexControllerRef.current?.abort(new DOMException(localize("The user stopped the RAG build.", "Người dùng đã dừng tạo RAG."), "AbortError"));
  };

  useEffect(() => {
    let cancelled = false;
    const effectOwner = ownerKey;
    indexGenerationRef.current += 1;
    cancelIndexRef.current = true;
    indexControllerRef.current?.abort(new DOMException(localize("The wallet changed.", "Ví đã thay đổi."), "AbortError"));
    indexControllerRef.current = null;
    setIndexingAll(false);
    setIndexProgress(null);
    setRagSources([]);
    if (!account || !ownerKey) {
      return () => { cancelled = true; };
    }

    void (async () => {
      await setActiveRagOwner(ownerKey);
      if (!cancelled && ownerKeyRef.current === ownerKey) await refreshRagStatus(ownerKey);
    })();

    return () => {
      cancelled = true;
      indexControllerRef.current?.abort(new DOMException(localize("The wallet changed.", "Ví đã thay đổi."), "AbortError"));
      if (effectOwner) void deactivateActiveRagOwner(effectOwner);
    };
  }, [ownerKey]);

  return {
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
    cancelIndexRef,
    cancelIndexing,
    refreshRagStatus,
    handleIndexBlobs,
  };
}
