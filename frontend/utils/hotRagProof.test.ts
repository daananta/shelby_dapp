import { describe, expect, it } from "vitest";
import { createHotRagCapsuleLayout, createHotRagProofSnapshot, type HotRagProofManifest } from "@/utils/hotRagProof";

function manifest(version: 1 | 2 = 2): HotRagProofManifest {
  return {
    version,
    snapshotId: "snapshot-proof",
    shards: [
      { index: 0, blobName: "capsule.pack", byteOffset: version === 2 ? 0 : undefined, byteLength: 400 },
      { index: 1, blobName: version === 2 ? "capsule.pack" : "parts/0001.json", byteOffset: version === 2 ? 400 : undefined, byteLength: 300 },
    ],
  };
}

describe("Hot RAG read proof metrics", () => {
  it("separates capsule layout, bootstrap reads, range reads, and cache reuse", () => {
    const source = manifest();
    const proof = createHotRagProofSnapshot({
      manifest: source,
      context: {
        capsuleBytes: 2_000,
        manifestBytes: 100,
        bootstrap: { headerNetworkBytesRead: 16, manifestNetworkBytesRead: 100, rangeReads: 2 },
      },
      observations: [
        { descriptor: source.shards[0], cacheHit: false, networkBytesRead: 397, latencyMs: 12.5 },
        { descriptor: source.shards[1], cacheHit: true, latencyMs: 0.2 },
      ],
      latencyMs: 24.75,
      measuredAt: 1_700_000_000_000,
    });

    expect(proof.capsule).toEqual({
      snapshotId: "snapshot-proof",
      container: "single_blob_pack",
      totalBytes: 2_000,
      totalBytesSource: "blob_metadata",
      headerBytes: 16,
      manifestBytes: 100,
      payloadBytes: 700,
      shardCount: 2,
    });
    expect(proof.bootstrap).toEqual({ headerNetworkBytesRead: 16, manifestNetworkBytesRead: 100, networkBytesRead: 116, rangeReads: 2 });
    expect(proof.retrieval).toMatchObject({
      latencyMs: 24.75,
      shardAccesses: 2,
      uniqueShards: 2,
      cacheHits: 1,
      cacheMisses: 1,
      rangeReads: 1,
      blobReads: 0,
      shardBytesRequested: 700,
      cacheBytesReused: 300,
      networkBytesRead: 397,
      capsuleReadRatio: 397 / 2_000,
    });
    expect(proof.reads[0]).toMatchObject({ rangeStart: 116, rangeEnd: 515, readKind: "range", networkBytesRead: 397 });
    expect(proof.reads[1]).toMatchObject({ rangeStart: 516, rangeEnd: 815, readKind: "cache", networkBytesRead: 0 });
  });

  it("returns null instead of inventing a network byte count", () => {
    const source = manifest();
    const proof = createHotRagProofSnapshot({
      manifest: source,
      context: { manifestBytes: 100 },
      observations: [{ descriptor: source.shards[0], cacheHit: false, latencyMs: 4 }],
      latencyMs: 8,
    });

    expect(proof.retrieval.networkBytesRead).toBeNull();
    expect(proof.retrieval.capsuleReadRatio).toBeNull();
    expect(proof.reads[0].networkBytesRead).toBeNull();
    expect(proof.bootstrap.networkBytesRead).toBeNull();
  });

  it("reports separate shard blobs as blob reads without fake byte ranges", () => {
    const source = manifest(1);
    const layout = createHotRagCapsuleLayout(source, { manifestBytes: 80 });
    const proof = createHotRagProofSnapshot({
      manifest: source,
      context: { manifestBytes: 80 },
      observations: [{ descriptor: source.shards[1], cacheHit: false, networkBytesRead: 300, latencyMs: 3 }],
      latencyMs: 6,
    });

    expect(layout).toMatchObject({ container: "multi_blob_snapshot", headerBytes: 0, manifestBytes: 80, payloadBytes: 700, totalBytes: 780 });
    expect(proof.retrieval).toMatchObject({ rangeReads: 0, blobReads: 1, networkBytesRead: 300 });
    expect(proof.reads[0]).toMatchObject({ rangeStart: null, rangeEnd: null, readKind: "blob" });
  });
});
