import { describe, expect, it, vi } from "vitest";
import { buildHotRagPack, HOT_RAG_PACK_HEADER_BYTES, HotRagRuntime, isHotRagManifest, parseHotRagPackHeader, parseHotRagPackManifest } from "@/utils/hotRag";
import type { PortableRagDocument, PortableRagPackage } from "@/utils/ragTypes";

function document(source: string, keyword: string, index: number): PortableRagDocument {
  const text = `${keyword} là dấu hiệu riêng của tài liệu ${source}. ${"nội dung kiểm thử đọc theo nhu cầu ".repeat(1_300)}`;
  return {
    manifest: {
      originalSourceOwner: "0xhot-source",
      sourceRevision: `revision-${index}`,
      sourceIndexedAt: 1_700_000_000_000 + index,
      source,
      displayName: source,
      mimeType: "text/plain",
      type: "text",
      aliases: [],
      authors: [],
      pageCount: 1,
      chunkCount: 1,
      ocrCoverage: 0,
      textCoverage: 1,
      status: "indexed",
      accessTag: "public",
    },
    pages: [{ source, displayName: source, pageNumber: 1, totalPages: 1, rawText: text, normalizedText: text.toLocaleLowerCase("vi-VN"), extractionMethod: "text_layer" }],
    chunks: [{ source, displayName: source, type: "text", text, normalizedText: text.toLocaleLowerCase("vi-VN"), pageNumber: 1, totalPages: 1 }],
    stories: [],
  };
}

function fixture(): PortableRagPackage {
  return {
    format: "shelby-rag-package",
    version: 2,
    sourceNetwork: "shelbynet",
    exportedAt: 1_700_000_123_456,
    sourceOwner: "0xhot-source",
    inventory: { names: ["alpha.txt", "beta.txt", "orion.txt", "delta.txt"], fetchedAt: 1_700_000_123_000 },
    documents: [document("alpha.txt", "alpha", 0), document("beta.txt", "beta", 1), document("orion.txt", "orion", 2), document("delta.txt", "delta", 3)],
  };
}

describe("Shelby Hot RAG snapshots", () => {
  it("packs the searchable catalog and verifiable regions into exactly one Shelby blob", async () => {
    const pack = await buildHotRagPack(fixture(), "rag-hot/fixture/snapshot.shelby-hot-rag.pack", 64 * 1024);
    const retryPack = await buildHotRagPack(fixture(), "rag-hot/fixture/snapshot.shelby-hot-rag.pack", 64 * 1024);
    const header = parseHotRagPackHeader(pack.bytes.slice(0, HOT_RAG_PACK_HEADER_BYTES));
    const manifest = parseHotRagPackManifest(pack.bytes.slice(header.manifestStart, header.payloadStart));

    expect(isHotRagManifest(manifest)).toBe(true);
    expect(manifest.version).toBe(3);
    expect(manifest.sourceNetwork).toBe("shelbynet");
    expect(pack.parts.length).toBeGreaterThan(1);
    expect(manifest.totals.chunks).toBe(4);
    expect(new Set(manifest.shards.map((descriptor) => descriptor.blobName))).toEqual(new Set([pack.blobName]));
    expect(manifest.shards.every((descriptor) => descriptor.contentHash.startsWith("0x"))).toBe(true);
    expect(manifest.shards[0].byteOffset).toBe(0);
    expect(header.payloadStart + manifest.shards.reduce((sum, descriptor) => sum + descriptor.byteLength, 0)).toBe(pack.bytes.byteLength);
    expect(JSON.stringify({ manifest, parts: pack.parts })).not.toMatch(/api.?key|private.?key/i);
    expect(retryPack.bytes).toEqual(pack.bytes);
  });

  it("keeps one large page in one range instead of duplicating it across shards", async () => {
    const large = document("transcript.mp4", "timeline", 0);
    large.chunks = Array.from({ length: 12 }, (_, index) => ({
      ...large.chunks[0],
      text: `${large.chunks[0].text} phần ${index}`,
      normalizedText: `${large.chunks[0].normalizedText} phần ${index}`,
    }));
    large.manifest.chunkCount = large.chunks.length;
    const packageData: PortableRagPackage = {
      ...fixture(),
      inventory: { names: [large.manifest.source], fetchedAt: 1 },
      documents: [large],
    };

    const pack = await buildHotRagPack(packageData, "rag-hot/large-page/snapshot.shelby-hot-rag.pack", 64 * 1024);

    expect(pack.parts).toHaveLength(1);
    expect(pack.parts[0].shard.documents[0].pages).toHaveLength(1);
    expect(pack.parts[0].shard.chunks).toHaveLength(12);
  });

  it("loads only byte ranges relevant to a query and can reconstruct on demand", async () => {
    const pack = await buildHotRagPack(fixture(), "rag-hot/fixture/snapshot.shelby-hot-rag.pack", 64 * 1024);
    const loadedRanges: Array<[number, number]> = [];
    const runtime = new HotRagRuntime({
      manifest: pack.manifest,
      loadShard: async (descriptor) => {
        const start = pack.header.payloadStart + descriptor.byteOffset!;
        const end = start + descriptor.byteLength;
        loadedRanges.push([start, end - 1]);
        return { value: JSON.parse(new TextDecoder().decode(pack.bytes.slice(start, end))), bytesRead: descriptor.byteLength };
      },
    });

    const [result] = await runtime.search("orion", 4);
    expect(result).toMatchObject({ source: "orion.txt", method: "lexical" });
    expect(result.provenance).toMatchObject({ storageMode: "shelby_hot" });
    expect(loadedRanges.length).toBeLessThan(pack.parts.length);
    expect(loadedRanges.reduce((sum, [start, end]) => sum + end - start + 1, 0)).toBeLessThan(pack.bytes.byteLength);

    const restored = await runtime.reconstruct();
    expect(restored).toMatchObject({ version: 2, sourceNetwork: "shelbynet" });
    expect(restored.documents).toHaveLength(4);
    expect(restored.documents.reduce((sum, item) => sum + item.chunks.length, 0)).toBe(4);
  });

  it("returns an exact proof snapshot and distinguishes network reads from cache hits", async () => {
    const pack = await buildHotRagPack(fixture(), "rag-hot/fixture/snapshot.shelby-hot-rag.pack", 64 * 1024);
    const proofs: ReturnType<HotRagRuntime["getLatestProofSnapshot"]>[] = [];
    const runtime = new HotRagRuntime({
      manifest: pack.manifest,
      proofContext: {
        capsuleBytes: pack.bytes.byteLength,
        manifestBytes: pack.header.manifestByteLength,
        bootstrap: {
          headerNetworkBytesRead: HOT_RAG_PACK_HEADER_BYTES,
          manifestNetworkBytesRead: pack.header.manifestByteLength,
          rangeReads: 2,
        },
      },
      onProof: (proof) => proofs.push(proof),
      loadShard: async (descriptor) => {
        const start = pack.header.payloadStart + descriptor.byteOffset!;
        const end = start + descriptor.byteLength;
        return { value: JSON.parse(new TextDecoder().decode(pack.bytes.slice(start, end))), bytesRead: end - start };
      },
    });

    const first = await runtime.searchWithProof("orion", 4);
    const second = await runtime.searchWithProof("orion", 4);

    expect(first.proof.capsule).toMatchObject({
      totalBytes: pack.bytes.byteLength,
      headerBytes: HOT_RAG_PACK_HEADER_BYTES,
      manifestBytes: pack.header.manifestByteLength,
      payloadBytes: pack.parts.reduce((sum, part) => sum + part.descriptor.byteLength, 0),
    });
    expect(first.proof.retrieval).toMatchObject({ cacheHits: 0, cacheMisses: 3, rangeReads: 3, blobReads: 0 });
    expect(first.proof.retrieval.networkBytesRead).toBeGreaterThan(0);
    expect(first.proof.reads.every((read) => read.rangeStart !== null && read.rangeEnd !== null)).toBe(true);
    expect(second.proof.retrieval).toMatchObject({ cacheHits: 3, cacheMisses: 0, rangeReads: 0, networkBytesRead: 0 });
    expect(second.proof.retrieval.cacheBytesReused).toBe(second.proof.retrieval.shardBytesRequested);
    expect(runtime.getLatestProofSnapshot()).toBe(second.proof);
    expect(proofs).toEqual([first.proof, second.proof]);
  });

  it("rejects a modified byte range before using its evidence", async () => {
    const pack = await buildHotRagPack(fixture(), "rag-hot/fixture/snapshot.shelby-hot-rag.pack", 64 * 1024);
    const runtime = new HotRagRuntime({
      manifest: pack.manifest,
      loadShard: async (descriptor) => {
        const part = pack.parts[descriptor.index];
        const value = JSON.parse(part.content);
        value.chunks[0].chunk.text = "đã bị thay đổi";
        return { value, bytesRead: part.descriptor.byteLength };
      },
    });
    await expect(runtime.search("orion", 4)).rejects.toThrow(/integrity/);
  });

  it("skips one unreadable range when another range still answers the query", async () => {
    const pack = await buildHotRagPack(fixture(), "rag-hot/fixture/snapshot.shelby-hot-rag.pack", 64 * 1024);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = new HotRagRuntime({
      manifest: pack.manifest,
      loadShard: async (descriptor) => {
        if (descriptor.index === 0) throw new Error("temporary range failure");
        const start = pack.header.payloadStart + descriptor.byteOffset!;
        const end = start + descriptor.byteLength;
        return { value: JSON.parse(new TextDecoder().decode(pack.bytes.slice(start, end))), bytesRead: descriptor.byteLength };
      },
    });
    try {
      expect((await runtime.search("orion", 4))[0]).toMatchObject({ source: "orion.txt" });
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects a pack manifest whose ranges do not match the registered blob size", async () => {
    const pack = await buildHotRagPack(fixture(), "rag-hot/fixture/snapshot.shelby-hot-rag.pack", 64 * 1024);
    const header = parseHotRagPackHeader(pack.bytes.slice(0, HOT_RAG_PACK_HEADER_BYTES));
    const manifestBytes = pack.bytes.slice(header.manifestStart, header.payloadStart);

    expect(() => parseHotRagPackManifest(manifestBytes, pack.bytes.byteLength + 1)).toThrow(/backup blob size/);
  });
});
