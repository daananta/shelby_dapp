import type { RagSource } from "@/utils/ragOrama";
import type { PortableRagPackage } from "@/utils/ragTypes";

export function ragPipelineRevision(options: { fullPdfOcr: boolean; cloudContentAnalysis: boolean; embeddingMode: string; ragChunkSize: number }) {
  return `v11:content-sniffer-v2:quota-controls:quality-ocr-${options.fullPdfOcr ? "all" : "smart"}:cloud-read-${options.cloudContentAnalysis ? "on" : "off"}:embedding-${options.embeddingMode}:chunk-${options.ragChunkSize}`;
}

export function blobContentIdentity(blob: any, accessTag: string) {
  return `${blob.size ?? 0}:${blob.creationMicros ?? blob.expirationMicros ?? "unknown"}:${accessTag}`;
}

export function blobPipelineRevision(blob: any, accessTag: string, pipelineRevision: string) {
  return `${blobContentIdentity(blob, accessTag)}:${pipelineRevision}`;
}

export function sourceContentIdentity(revision?: string) {
  if (!revision) return "";
  const parts = revision.split(":");
  return parts.length >= 3 ? parts.slice(0, 3).join(":") : "";
}

export function needsLocalIndex(source: RagSource | undefined, expectedRevision: string) {
  if (!source) return true;
  if (source.status === "skipped") {
    if (source.revision === expectedRevision) return false;
    const currentPipeline = source.revision?.split(":").slice(3).join(":") ?? "";
    const expectedPipeline = expectedRevision.split(":").slice(3).join(":");
    const upgradedPipeline = currentPipeline.replace(
      /^v10:quota-controls:/,
      "v11:content-sniffer-v2:quota-controls:",
    );
    const retryableBySaferDetection = /\.(?:pdf|png|jpe?g|gif|webp|mp4|txt|md|markdown|json|jsonl|map|html?|xml|csv|tsv|ya?ml|toml|tsx?|jsx?|css|scss|move)$/i.test(source.source);
    if (
      sourceContentIdentity(source.revision) === sourceContentIdentity(expectedRevision)
      && upgradedPipeline === expectedPipeline
      && !retryableBySaferDetection
    ) {
      return false;
    }
    return true;
  }
  if (source.status !== "indexed") return true;
  if (source.revision === expectedRevision) return false;
  if (sourceContentIdentity(source.revision) !== sourceContentIdentity(expectedRevision)) return true;

  const pipeline = (revision: string) => revision.split(":").slice(3).join(":");
  const expectedPipeline = pipeline(expectedRevision);
  let currentPipeline = pipeline(source.revision);

  // v9 used "auto" and had no explicit cloud-read permission. Treat its
  // existing index as a compatible superset when the new safe defaults are
  // selected, so changing a permission does not pointlessly rebuild every blob.
  if (currentPipeline.startsWith("v9:mp4-hot-rag:")) {
    currentPipeline = currentPipeline
      .replace(/^v9:mp4-hot-rag:/, "v10:quota-controls:")
      .replace(":embedding-", ":cloud-read-off:embedding-");
  }
  // v11 only asks previously skipped blobs to pass through the safer content
  // detector once more. Existing indexed content remains valid and is not
  // rebuilt solely because the detector changed.
  if (currentPipeline.startsWith("v10:quota-controls:")) {
    currentPipeline = currentPipeline.replace(
      /^v10:quota-controls:/,
      "v11:content-sniffer-v2:quota-controls:",
    );
  }
  if (currentPipeline.includes(":embedding-auto:")) {
    const expectedProvider = expectedPipeline.match(/:embedding-(gemini|gateway):/)?.[1];
    const compatibleProvider = source.embeddingStatus === "ready" && source.embeddingProvider === expectedProvider ? expectedProvider : "auto";
    currentPipeline = currentPipeline.replace(":embedding-auto:", `:embedding-${compatibleProvider}:`);
  }

  // Turning a permission off only blocks future calls; it does not invalidate
  // useful OCR text or vectors already stored in the local RAG.
  if (expectedPipeline.includes(":cloud-read-off:")) currentPipeline = currentPipeline.replace(":cloud-read-on:", ":cloud-read-off:");
  if (expectedPipeline.includes(":embedding-off:")) currentPipeline = currentPipeline.replace(/:embedding-(?:auto|gemini|gateway):/, ":embedding-off:");
  return currentPipeline !== expectedPipeline;
}

export function assessRemoteSnapshot(params: {
  packageData?: PortableRagPackage;
  currentInventoryNames: string[];
  currentSources: Array<{ name: string; contentIdentity: string }>;
}) {
  if (!params.packageData) return { fresh: false, missingInventoryNames: params.currentInventoryNames, extraInventoryNames: [], staleSources: params.currentSources.map((source) => source.name) };
  const remoteInventory = new Set(params.packageData.inventory?.names ?? params.packageData.documents.map((document) => document.manifest.source));
  const currentInventory = new Set(params.currentInventoryNames);
  const remoteRevisions = new Map(params.packageData.documents.map((document) => [document.manifest.source, sourceContentIdentity(document.manifest.sourceRevision)]));
  const missingInventoryNames = params.currentInventoryNames.filter((name) => !remoteInventory.has(name));
  const extraInventoryNames = [...remoteInventory].filter((name) => !currentInventory.has(name));
  const staleSources = params.currentSources.filter((source) => remoteRevisions.get(source.name) !== source.contentIdentity).map((source) => source.name);
  return { fresh: missingInventoryNames.length === 0 && extraInventoryNames.length === 0 && staleSources.length === 0, missingInventoryNames, extraInventoryNames, staleSources };
}
