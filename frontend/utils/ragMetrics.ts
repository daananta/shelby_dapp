import type { RagSource } from "@/utils/ragOrama";

export interface RagMetrics {
  documents: number;
  pages: number;
  chunks: number;
  semanticReady: number;
  textCoverage?: number;
  ocrCoverage?: number;
}

/** Compact, evidence-based health metrics for the RAG workspace. */
export function summarizeRagSources(sources: RagSource[]): RagMetrics {
  const indexed = sources.filter((source) => source.status === "indexed");
  const textSources = indexed.filter((source) => source.type === "text" && source.pageCount);
  const pages = textSources.reduce((total, source) => total + (source.pageCount ?? 0), 0);
  const weightedAverage = (key: "textCoverage" | "ocrCoverage") => {
    const contributing = textSources.filter((source) => source[key] !== undefined);
    const weight = contributing.reduce((total, source) => total + (source.pageCount ?? 0), 0);
    if (!weight) return undefined;
    return contributing.reduce((total, source) => total + (source[key] ?? 0) * (source.pageCount ?? 0), 0) / weight;
  };
  return {
    documents: indexed.length,
    pages,
    chunks: indexed.reduce((total, source) => total + source.chunks, 0),
    semanticReady: indexed.filter((source) => source.embeddingStatus === "ready").length,
    textCoverage: weightedAverage("textCoverage"),
    ocrCoverage: weightedAverage("ocrCoverage"),
  };
}
