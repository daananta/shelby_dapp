import type { MetadataValue } from "@/utils/ragTypes";
import { localize } from "@/i18n";

export interface ExtractedPage {
  pageNumber: number;
  totalPages: number;
  text: string;
}

export interface InferredDocumentMetadata {
  title?: MetadataValue;
  aliases: string[];
  authors: string[];
}

export function normalizeSearchText(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("vi-VN").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

/** Detects text layers that are long enough but mostly PDF encoding noise. */
export function extractedTextQuality(text: string): number {
  const cleaned = text.replace(/https?:\/\/\S+/g, " ").replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 24) return 0;
  const readable = cleaned.match(/[\p{L}\p{N}.,;:!?()'"-]/gu)?.length ?? 0;
  const tokens = cleaned.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const uniqueTokens = new Set(tokens.map((token) => token.toLocaleLowerCase("vi-VN"))).size;
  const readableRatio = readable / cleaned.length;
  const diversity = Math.min(1, uniqueTokens / Math.max(8, tokens.length * 0.35));
  const lengthConfidence = Math.min(1, cleaned.length / 120);
  return readableRatio * 0.55 + diversity * 0.25 + lengthConfidence * 0.2;
}

export function isUsefulExtractedText(text: string): boolean {
  const tokens = text.match(/[\p{L}\p{N}]{2,}/gu)?.length ?? 0;
  return tokens >= 5 && extractedTextQuality(text) >= 0.68;
}

function titleCaseVietnamese(value: string): string {
  return value.toLocaleLowerCase("vi-VN").replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase("vi-VN"));
}

export function inferDocumentMetadata(
  _pages: ExtractedPage[],
  fileName: string,
  localOcrCover = "",
  cloud?: { title?: string; aliases?: string[]; authors?: string[] },
  existingTitle?: MetadataValue,
): InferredDocumentMetadata {
  if (existingTitle?.userLocked) {
    return { title: existingTitle, aliases: cloud?.aliases ?? [], authors: cloud?.authors ?? [] };
  }
  const cloudTitle = cloud?.title?.trim();
  if (cloudTitle) {
    return {
      title: { value: cloudTitle, confidence: 0.95, provenance: "cloud_vision", userLocked: false },
      aliases: [...new Set(cloud?.aliases ?? [])],
      authors: [...new Set(cloud?.authors ?? [])],
    };
  }
  const ocrCandidates = localOcrCover.split(/\n|\s{2,}/).map((value) => value.trim()).filter((value) => value.length >= 5 && value.length <= 80 && !/https?|nhà xuất bản/i.test(value));
  const ocrTitle = ocrCandidates.find((value) => value.split(/\s+/).length >= 2 && /\p{L}/u.test(value));
  if (ocrTitle) {
    return {
      title: { value: titleCaseVietnamese(ocrTitle), confidence: 0.58, provenance: "local_ocr", userLocked: false },
      aliases: [],
      authors: [],
    };
  }
  const fallback = fileName.split("/").pop()?.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  if (fallback && !/^(sach|book|document|scan)$/i.test(fallback)) {
    return { title: { value: titleCaseVietnamese(fallback), confidence: 0.35, provenance: "filename", userLocked: false }, aliases: [], authors: [] };
  }
  return { aliases: [], authors: [] };
}

/** Backwards-compatible helper; unlike the old implementation it never promotes an inner heading to title. */
export function inferDocumentTitle(pages: ExtractedPage[], fileName: string): string | undefined {
  return inferDocumentMetadata(pages, fileName).title?.value;
}

export function extractSourceMapText(rawText: string, fileName: string): string {
  if (!/\.map$/i.test(fileName)) return rawText;
  try {
    const value = JSON.parse(rawText) as { version?: unknown; file?: unknown; sourceRoot?: unknown; sources?: unknown; sourcesContent?: unknown };
    if (value.version !== 3 || !Array.isArray(value.sources)) return rawText;
    const sources = value.sources.filter((item): item is string => typeof item === "string");
    const contents = Array.isArray(value.sourcesContent) ? value.sourcesContent : [];
    const sections = sources.flatMap((source, index) => {
      const content = contents[index];
      return typeof content === "string" && content.trim()
        ? [`--- Source: ${source} ---\n${content.trim()}`]
        : [];
    });
    const header = [
      `Source map: ${typeof value.file === "string" ? value.file : fileName}`,
      typeof value.sourceRoot === "string" && value.sourceRoot ? `Source directory: ${value.sourceRoot}` : "",
      sources.length ? `Source files (${sources.length}):\n${sources.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    // Deliberately omit `mappings` and `names`: they are compact machine data
    // that create noisy chunks without helping natural-language retrieval.
    return [header, ...sections].filter(Boolean).join("\n\n") || rawText;
  } catch {
    return rawText;
  }
}

export async function extractPagesFromUrl(
  url: string,
  fileName: string,
  maxPdfPages = 500,
  onProgress?: (message: string) => void,
  detectedMimeType?: string,
  signal?: AbortSignal,
  requestHeaders?: Record<string, string>,
): Promise<ExtractedPage[]> {
  signal?.throwIfAborted();
  const isPdf = detectedMimeType === "application/pdf" || (!detectedMimeType && fileName.toLowerCase().endsWith(".pdf"));
  if (!isPdf) {
    const response = await fetch(url, { headers: requestHeaders, signal });
    if (!response.ok) throw new Error(localize(`Unable to download the file (${response.status}).`, `Không thể tải tệp (${response.status}).`));
    const text = await response.text();
    if (text.length > 5_000_000) throw new Error(localize(
      "The text file exceeds the 5-million-character browser safety limit.",
      "Tệp văn bản vượt giới hạn 5 triệu ký tự để bảo vệ bộ nhớ tab.",
    ));
    return [{ pageNumber: 1, totalPages: 1, text: extractSourceMapText(text, fileName) }];
  }
  // PDF.js owns the parsing worker. Running PDF.js inside our own Worker makes
  // its browser build access `window` and breaks in Chromium. Keep page
  // orchestration light on the UI thread while PDF parsing stays off-thread.
  const pdfjs = await import("pdfjs-dist");
  signal?.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const loadingTask = pdfjs.getDocument(requestHeaders ? { url, httpHeaders: requestHeaders } : url);
  const abortLoading = () => { void loadingTask.destroy(); };
  signal?.addEventListener("abort", abortLoading, { once: true });
  let pdf: Awaited<typeof loadingTask.promise>;
  try {
    pdf = await loadingTask.promise;
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw new DOMException(localize("PDF reading stopped.", "Đã dừng đọc PDF."), "AbortError");
    throw error;
  }
  if (pdf.numPages > maxPdfPages) {
    signal?.removeEventListener("abort", abortLoading);
    await pdf.destroy();
    throw new Error(localize(
      `This PDF has ${pdf.numPages} pages and exceeds the safe ${maxPdfPages}-page limit.`,
      `PDF có ${pdf.numPages} trang, vượt giới hạn an toàn ${maxPdfPages} trang.`,
    ));
  }
  const pages: ExtractedPage[] = new Array(pdf.numPages);
  try {
    let nextPage = 1;
    let completed = 0;
    const readPage = async () => {
      while (nextPage <= pdf.numPages) {
        signal?.throwIfAborted();
        const pageNumber = nextPage++;
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        signal?.throwIfAborted();
        const text = content.items.map((item: any) => item.str).join(" ").replace(/\s+/g, " ").trim();
        pages[pageNumber - 1] = { pageNumber, totalPages: pdf.numPages, text };
        page.cleanup();
        completed += 1;
        if (completed === 1 || completed % 10 === 0 || completed === pdf.numPages) onProgress?.(localize(
          `Reading PDF text ${completed}/${pdf.numPages} pages…`,
          `Đọc text PDF ${completed}/${pdf.numPages} trang…`,
        ));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pdf.numPages) }, () => readPage()));
    return pages;
  } finally {
    signal?.removeEventListener("abort", abortLoading);
    await pdf.destroy();
  }
}

/** Re-extracts one page for an Answer Receipt without loading every PDF page. */
export async function extractSinglePageFromUrl(
  url: string,
  fileName: string,
  pageNumber: number,
  detectedMimeType?: string,
  signal?: AbortSignal,
  requestHeaders?: Record<string, string>,
): Promise<ExtractedPage> {
  const isPdf = detectedMimeType === "application/pdf" || (!detectedMimeType && fileName.toLowerCase().endsWith(".pdf"));
  if (!isPdf) {
    const [page] = await extractPagesFromUrl(url, fileName, 1, undefined, detectedMimeType, signal, requestHeaders);
    return page;
  }
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  signal?.throwIfAborted();
  const loadingTask = pdfjs.getDocument(requestHeaders ? { url, httpHeaders: requestHeaders } : url);
  const abortLoading = () => { void loadingTask.destroy(); };
  signal?.addEventListener("abort", abortLoading, { once: true });
  let pdf: Awaited<typeof loadingTask.promise>;
  try {
    pdf = await loadingTask.promise;
    signal?.throwIfAborted();
  } catch (error) {
    signal?.removeEventListener("abort", abortLoading);
    await loadingTask.destroy();
    if (signal?.aborted) throw new DOMException(localize("PDF reading stopped.", "Đã dừng đọc PDF."), "AbortError");
    throw error;
  }
  try {
    if (pageNumber < 1 || pageNumber > pdf.numPages) throw new Error(localize(
      `Page ${pageNumber} does not exist in this PDF.`,
      `Trang ${pageNumber} không tồn tại trong PDF.`,
    ));
    const page = await pdf.getPage(pageNumber);
    try {
      const content = await page.getTextContent();
      signal?.throwIfAborted();
      const text = content.items.map((item: any) => item.str).join(" ").replace(/\s+/g, " ").trim();
      return { pageNumber, totalPages: pdf.numPages, text };
    } finally {
      page.cleanup();
    }
  } finally {
    signal?.removeEventListener("abort", abortLoading);
    await pdf.destroy();
  }
}

export function chunkText(text: string, maxChunkSize = 1_200, overlap = 180): string[] {
  const limit = Math.max(1, Math.floor(maxChunkSize));
  const overlapSize = Math.min(Math.max(0, overlap), Math.floor(limit / 2));
  const splitLongFragment = (fragment: string): string[] => {
    if (fragment.length <= limit) return [fragment];
    const output: string[] = [];
    let remaining = fragment.trim();
    while (remaining.length > limit) {
      // Prefer a word boundary near the end of the window; a scanned PDF can
      // still contain a single enormous token, so fall back to a hard split.
      const boundary = remaining.lastIndexOf(" ", limit);
      const cut = boundary >= Math.floor(limit * 0.55) ? boundary : limit;
      output.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(Math.max(1, cut - overlapSize)).trim();
    }
    if (remaining) output.push(remaining);
    return output;
  };
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\s*\n|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean).flatMap(splitLongFragment);
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > limit) {
      chunks.push(current);
      const carry = current.slice(-overlapSize);
      // A carry-over can only make a new chunk exceed its limit when the
      // fragment is already at the limit. In that case keep the hard-boundary
      // fragment intact rather than violating the model input bound.
      current = carry.length + paragraph.length + 1 <= limit ? `${carry} ${paragraph}`.trim() : paragraph;
    } else current = `${current} ${paragraph}`.trim();
  }
  if (current) chunks.push(current);
  return chunks;
}
