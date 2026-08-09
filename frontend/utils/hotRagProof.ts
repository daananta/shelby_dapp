export interface HotRagProofManifest {
  version: 1 | 2 | 3;
  snapshotId: string;
  shards: Array<{
    index: number;
    blobName: string;
    byteOffset?: number;
    byteLength: number;
  }>;
}

export type HotRagCapsuleBytesSource = "blob_metadata" | "pack_layout";

/** Exact byte layout of the portable RAG artifact, independent of network reads. */
export interface HotRagCapsuleLayout {
  snapshotId: string;
  container: "single_blob_pack" | "multi_blob_snapshot";
  totalBytes: number;
  totalBytesSource: HotRagCapsuleBytesSource;
  headerBytes: number;
  manifestBytes: number;
  payloadBytes: number;
  shardCount: number;
}

/** Bytes already read before the runtime is created (header + manifest). */
export interface HotRagBootstrapProof {
  headerNetworkBytesRead?: number;
  manifestNetworkBytesRead?: number;
  rangeReads?: number;
}

export interface HotRagShardReadProof {
  shardIndex: number;
  blobName: string;
  /** Absolute byte offset in a v2 single-blob pack; null for a separate shard blob. */
  rangeStart: number | null;
  rangeEnd: number | null;
  shardBytes: number;
  /** Null means the loader did not report transferred bytes; it is never estimated. */
  networkBytesRead: number | null;
  cacheHit: boolean;
  readKind: "cache" | "range" | "blob";
  latencyMs: number;
}

export interface HotRagProofSnapshot {
  format: "shelby-hot-rag-read-proof";
  version: 1;
  snapshotId: string;
  measuredAt: number;
  capsule: HotRagCapsuleLayout;
  bootstrap: {
    headerNetworkBytesRead: number | null;
    manifestNetworkBytesRead: number | null;
    networkBytesRead: number | null;
    rangeReads: number | null;
  };
  retrieval: {
    latencyMs: number;
    shardAccesses: number;
    uniqueShards: number;
    cacheHits: number;
    cacheMisses: number;
    rangeReads: number;
    blobReads: number;
    shardBytesRequested: number;
    cacheBytesReused: number;
    /** Null when at least one loader did not report its actual byte count. */
    networkBytesRead: number | null;
    /** Warm-query network share of the whole capsule. Null without measured network bytes. */
    capsuleReadRatio: number | null;
  };
  reads: HotRagShardReadProof[];
}

export interface HotRagProofContext {
  /** Prefer the size from Shelby blob metadata when it is available. */
  capsuleBytes?: number;
  /** Exact bytes parsed from the pack header. */
  manifestBytes?: number;
  bootstrap?: HotRagBootstrapProof;
}

export interface HotRagShardReadObservation {
  descriptor: HotRagProofManifest["shards"][number];
  cacheHit: boolean;
  networkBytesRead?: number;
  latencyMs: number;
}

const encoder = new TextEncoder();

function nonNegativeInteger(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function measured(value: number | undefined): number | null {
  return nonNegativeInteger(value) ? value : null;
}

/**
 * Derives byte layout only from serialized data and optional Shelby metadata.
 * It deliberately does not infer transferred bytes from requested ranges.
 */
export function createHotRagCapsuleLayout(
  manifest: HotRagProofManifest,
  context: Pick<HotRagProofContext, "capsuleBytes" | "manifestBytes"> = {},
): HotRagCapsuleLayout {
  const isPacked = manifest.shards.every((shard) => shard.byteOffset !== undefined);
  const container = isPacked ? "single_blob_pack" : "multi_blob_snapshot";
  const headerBytes = isPacked ? 16 : 0;
  const manifestBytes = nonNegativeInteger(context.manifestBytes)
    ? context.manifestBytes
    : encoder.encode(JSON.stringify(manifest)).byteLength;
  const payloadBytes = manifest.shards.reduce((sum, shard) => sum + shard.byteLength, 0);
  const layoutBytes = headerBytes + manifestBytes + payloadBytes;
  const hasMetadataSize = nonNegativeInteger(context.capsuleBytes);

  return {
    snapshotId: manifest.snapshotId,
    container,
    totalBytes: hasMetadataSize ? context.capsuleBytes! : layoutBytes,
    totalBytesSource: hasMetadataSize ? "blob_metadata" : "pack_layout",
    headerBytes,
    manifestBytes,
    payloadBytes,
    shardCount: manifest.shards.length,
  };
}

export function createHotRagProofSnapshot(params: {
  manifest: HotRagProofManifest;
  context?: HotRagProofContext;
  observations: HotRagShardReadObservation[];
  latencyMs: number;
  measuredAt?: number;
}): HotRagProofSnapshot {
  const capsule = createHotRagCapsuleLayout(params.manifest, params.context);
  const reads: HotRagShardReadProof[] = params.observations.map((observation) => {
    const { descriptor } = observation;
    const rangeStart = descriptor.byteOffset === undefined
      ? null
      : capsule.headerBytes + capsule.manifestBytes + descriptor.byteOffset;
    return {
      shardIndex: descriptor.index,
      blobName: descriptor.blobName,
      rangeStart,
      rangeEnd: rangeStart === null ? null : rangeStart + descriptor.byteLength - 1,
      shardBytes: descriptor.byteLength,
      networkBytesRead: observation.cacheHit ? 0 : measured(observation.networkBytesRead),
      cacheHit: observation.cacheHit,
      readKind: observation.cacheHit ? "cache" : descriptor.byteOffset === undefined ? "blob" : "range",
      latencyMs: Math.max(0, observation.latencyMs),
    };
  });

  const misses = reads.filter((read) => !read.cacheHit);
  const hasCompleteNetworkMeasurement = misses.every((read) => read.networkBytesRead !== null);
  const networkBytesRead = hasCompleteNetworkMeasurement
    ? misses.reduce((sum, read) => sum + (read.networkBytesRead ?? 0), 0)
    : null;
  const headerNetworkBytesRead = measured(params.context?.bootstrap?.headerNetworkBytesRead);
  const manifestNetworkBytesRead = measured(params.context?.bootstrap?.manifestNetworkBytesRead);
  const bootstrapNetworkBytesRead = headerNetworkBytesRead === null || manifestNetworkBytesRead === null
    ? null
    : headerNetworkBytesRead + manifestNetworkBytesRead;

  return {
    format: "shelby-hot-rag-read-proof",
    version: 1,
    snapshotId: params.manifest.snapshotId,
    measuredAt: params.measuredAt ?? Date.now(),
    capsule,
    bootstrap: {
      headerNetworkBytesRead,
      manifestNetworkBytesRead,
      networkBytesRead: bootstrapNetworkBytesRead,
      rangeReads: measured(params.context?.bootstrap?.rangeReads),
    },
    retrieval: {
      latencyMs: Math.max(0, params.latencyMs),
      shardAccesses: reads.length,
      uniqueShards: new Set(reads.map((read) => `${read.blobName}:${read.shardIndex}`)).size,
      cacheHits: reads.filter((read) => read.cacheHit).length,
      cacheMisses: misses.length,
      rangeReads: reads.filter((read) => read.readKind === "range").length,
      blobReads: reads.filter((read) => read.readKind === "blob").length,
      shardBytesRequested: reads.reduce((sum, read) => sum + read.shardBytes, 0),
      cacheBytesReused: reads.filter((read) => read.cacheHit).reduce((sum, read) => sum + read.shardBytes, 0),
      networkBytesRead,
      capsuleReadRatio: networkBytesRead === null || capsule.totalBytes === 0
        ? null
        : Math.min(1, networkBytesRead / capsule.totalBytes),
    },
    reads,
  };
}
