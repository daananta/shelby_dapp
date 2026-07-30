export interface RagEstimateSource {
  chunks?: number;
  pageCount?: number;
  textCoverage?: number;
}

export interface RagEstimateItem {
  name: string;
  size?: number;
  existing?: RagEstimateSource;
}

export interface RagCallEstimate {
  contentCallsMinimum: number;
  contentCallsUncertain: boolean;
  semanticCallsApproximate: number;
  hasVideo: boolean;
}

const isImage = (name: string) => /\.(?:jpe?g|png|gif|webp)$/i.test(name);
const isVideo = (name: string) => /\.(?:mp4|m4v|mov)$/i.test(name);
const isPdf = (name: string) => /\.pdf$/i.test(name);

export function estimateRagGeminiCalls(
  items: RagEstimateItem[],
  options: { contentAnalysis: boolean; semanticSearch: boolean; fullPdfOcr: boolean; chunkSize: number },
): RagCallEstimate {
  let contentCallsMinimum = 0;
  let contentCallsUncertain = false;
  let semanticCallsApproximate = 0;
  let hasVideo = false;

  for (const item of items) {
    const { name, existing } = item;
    const image = isImage(name);
    const video = isVideo(name);
    const pdf = isPdf(name);
    hasVideo ||= video;

    if (options.contentAnalysis) {
      if (image || video) contentCallsMinimum += 1;
      if (pdf) {
        if (existing?.pageCount) {
          const missingTextPages = Math.ceil(existing.pageCount * (1 - Math.min(1, Math.max(0, existing.textCoverage ?? 0.85))));
          contentCallsMinimum += options.fullPdfOcr ? existing.pageCount : Math.max(1, missingTextPages);
        } else {
          // Smart OCR always inspects at least the cover. A new PDF must be
          // parsed before the browser can know how many additional pages need OCR.
          contentCallsMinimum += 1;
          contentCallsUncertain = true;
        }
      }
    }

    if (!options.semanticSearch || image) continue;
    const existingChunks = existing?.chunks;
    const approximateChunks = existingChunks && existingChunks > 0
      ? existingChunks
      : video
        ? 1
        : Math.max(1, Math.ceil(Math.max(1, item.size ?? options.chunkSize) / Math.max(1, options.chunkSize * 3)));
    semanticCallsApproximate += Math.ceil(Math.min(3_000, approximateChunks) / 20);
  }

  return { contentCallsMinimum, contentCallsUncertain, semanticCallsApproximate, hasVideo };
}
