import { isUsefulExtractedText, type ExtractedPage } from "@/utils/textExtractor";
import { getCloudErrorKind, ocrPageWithCloud } from "./aiProvider";
import { localize } from "@/i18n";

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  method: "cloud_vision" | "local_ocr";
}

export interface PdfOcrResult {
  pages: OcrPageResult[];
  coverBlob?: Blob;
  attemptedPages: number;
  cancelled?: boolean;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error(localize("Unable to render the PDF page.", "Không thể render trang PDF."))),
    "image/jpeg",
    0.9,
  ));
}

export async function ocrPdfPages(
  url: string,
  extractedPages: ExtractedPage[],
  deepScan: boolean,
  onProgress?: (message: string) => void,
  shouldCancel?: () => boolean,
  cloudApiKey?: string,
  signal?: AbortSignal,
): Promise<PdfOcrResult> {
  const isCancelled = () => Boolean(shouldCancel?.() || signal?.aborted);
  const targets = extractedPages
    .filter((page) => deepScan || page.pageNumber === 1 || !isUsefulExtractedText(page.text))
    .map((page) => page.pageNumber);
  if (!targets.length) return { pages: [], attemptedPages: 0 };
  if (isCancelled()) return { pages: [], attemptedPages: 0, cancelled: true };

  const [pdfjs, tesseract] = await Promise.all([import("pdfjs-dist"), import("tesseract.js")]);
  signal?.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const loadingTask = pdfjs.getDocument(url);
  let worker: Awaited<ReturnType<typeof tesseract.createWorker>> | null = null;
  let activeRenderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
  const abortWork = () => {
    activeRenderTask?.cancel();
    void worker?.terminate();
    void loadingTask.destroy();
  };
  signal?.addEventListener("abort", abortWork, { once: true });
  let pdf: Awaited<typeof loadingTask.promise>;
  try {
    pdf = await loadingTask.promise;
    signal?.throwIfAborted();
  } catch (error) {
    signal?.removeEventListener("abort", abortWork);
    if (signal?.aborted) throw new DOMException(localize("PDF OCR stopped.", "Đã dừng OCR PDF."), "AbortError");
    throw error;
  }
  const renderPage = async (pageNumber: number) => {
    signal?.throwIfAborted();
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error(localize("The browser could not create an OCR canvas.", "Trình duyệt không tạo được canvas OCR."));
    try {
      activeRenderTask = page.render({ canvas, canvasContext: context, viewport });
      await activeRenderTask.promise;
      signal?.throwIfAborted();
      return await canvasToBlob(canvas);
    } finally {
      activeRenderTask = null;
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
    }
  };
  const results: OcrPageResult[] = [];
  let coverBlob: Blob | undefined;
  let cloudOcrAvailable = Boolean(cloudApiKey);
  let attemptedPages = 0;
  try {
    coverBlob = targets.includes(1) ? await renderPage(1) : undefined;
    for (let index = 0; index < targets.length; index += 1) {
      if (isCancelled()) return { pages: results, coverBlob, attemptedPages, cancelled: true };
      const pageNumber = targets[index];
      attemptedPages += 1;
      const blob = pageNumber === 1 && coverBlob ? coverBlob : await renderPage(pageNumber);

      let text = "";
      let method: OcrPageResult["method"] = "local_ocr";
      if (cloudApiKey && cloudOcrAvailable) {
        onProgress?.(localize(
          `Cloud OCR · page ${pageNumber} (${index + 1}/${targets.length})…`,
          `Cloud OCR trang ${pageNumber} (${index + 1}/${targets.length})…`,
        ));
        try {
          const cloudText = await ocrPageWithCloud(blob, cloudApiKey, signal);
          if (cloudText) {
            text = cloudText;
            method = "cloud_vision";
          }
        } catch (e) {
          if (isCancelled()) return { pages: results, coverBlob, attemptedPages, cancelled: true };
          if (getCloudErrorKind(e) === "rate_limit" || getCloudErrorKind(e) === "invalid_key") cloudOcrAvailable = false;
          console.warn("Cloud OCR failed; switching to on-device OCR.", e);
        }
      }

      if (!text) {
        onProgress?.(localize(
          `On-device OCR · page ${pageNumber} (${index + 1}/${targets.length})…`,
          `OCR trên máy · trang ${pageNumber} (${index + 1}/${targets.length})…`,
        ));
        if (!worker) {
          worker = await tesseract.createWorker(["vie", "eng"], undefined, {
            logger: (message) => {
              if (message.status === "recognizing text") onProgress?.(localize(
                `On-device OCR: ${Math.round((message.progress ?? 0) * 100)}%`,
                `OCR trên máy: ${Math.round((message.progress ?? 0) * 100)}%`,
              ));
            },
          });
        }
        const recognition = await worker.recognize(blob);
        text = recognition.data.text.replace(/\s+/g, " ").trim();
      }

      if (text) results.push({ pageNumber, text, method });
    }
  } catch (error) {
    if (isCancelled()) return { pages: results, coverBlob, attemptedPages, cancelled: true };
    console.warn("OCR worker unavailable; retaining the cover image for optional metadata.", error);
  } finally {
    signal?.removeEventListener("abort", abortWork);
    try { await worker?.terminate(); } catch { /* worker may already be terminated by abort */ }
    await pdf.destroy();
  }
  return { pages: results, coverBlob, attemptedPages };
}
