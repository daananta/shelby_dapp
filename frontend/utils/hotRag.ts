import { sha256Text } from "@/utils/contentIntegrity";
import type { EmbeddingProvider } from "@/utils/embeddingClient";
import { createHotRagProofSnapshot, type HotRagProofContext, type HotRagProofSnapshot, type HotRagShardReadObservation } from "@/utils/hotRagProof";
import { normalizeSearchText } from "@/utils/textExtractor";
import { getShelbyBlobUrl } from "@/utils/shelbyConfig";
import type { PageRecord, PortableRagDocument, PortableRagPackage, RetrievalResult } from "@/utils/ragTypes";
import { localize } from "@/i18n";

export const HOT_RAG_MANIFEST_SUFFIX = ".shelby-hot-rag.json";
export const HOT_RAG_SHARD_SUFFIX = ".shelby-hot-rag-part.json";
export const HOT_RAG_PACK_SUFFIX = ".shelby-hot-rag.pack";
export const HOT_RAG_PACK_HEADER_BYTES = 16;
export const DEFAULT_HOT_RAG_SHARD_BYTES = 384 * 1024;

const HOT_RAG_PACK_MAGIC = "SHRAGPK1";
const HOT_RAG_PACK_VERSION = 1;
const MAX_HOT_RAG_SHARDS = 4_096;
const MAX_HOT_RAG_SHARD_BYTES = 8 * 1024 * 1024;
const SHA256_HEX = /^0x[0-9a-f]{64}$/i;
const parsedManifestByteLengths = new WeakMap<object, number>();

type PortableManifest = PortableRagDocument["manifest"];
type PortablePage = PortableRagDocument["pages"][number];
type PortableChunk = PortableRagDocument["chunks"][number];

export interface QuantizedCentroid {
  provider: EmbeddingProvider;
  dimensions: number;
  scale: number;
  values: string;
}

export interface HotRagShardDescriptor {
  index: number;
  blobName: string;
  /** Byte offset relative to the payload area in a single-blob pack. */
  byteOffset?: number;
  byteLength: number;
  chunkCount: number;
  sources: string[];
  keywords: string[];
  centroid?: QuantizedCentroid;
  contentHash: string;
}

export interface HotRagManifest {
  format: "shelby-hot-rag-manifest";
  version: 1 | 2;
  snapshotId: string;
  exportedAt: number;
  sourceOwner: string;
  inventory?: PortableRagPackage["inventory"];
  documents: PortableManifest[];
  stories: PortableRagDocument["stories"];
  shards: HotRagShardDescriptor[];
  totals: { documents: number; pages: number; chunks: number; bytes: number };
}

export interface HotRagPackHeader {
  version: number;
  manifestByteLength: number;
  manifestStart: number;
  payloadStart: number;
}

export interface HotRagPack {
  blobName: string;
  manifest: HotRagManifest;
  manifestContent: string;
  parts: HotRagUploadPart[];
  bytes: Uint8Array;
  header: HotRagPackHeader;
}

export interface HotRagShardDocument {
  manifest: PortableManifest;
  pages: PortablePage[];
  stories: PortableRagDocument["stories"];
}

export interface HotRagShard {
  format: "shelby-hot-rag-shard";
  version: 1;
  snapshotId: string;
  index: number;
  documents: HotRagShardDocument[];
  chunks: Array<{ source: string; chunkIndex: number; chunk: PortableChunk }>;
}

export interface HotRagUploadPart {
  descriptor: HotRagShardDescriptor;
  shard: HotRagShard;
  content: string;
}

export interface HotRagSnapshot {
  manifest: HotRagManifest;
  manifestContent: string;
  parts: HotRagUploadPart[];
}

export interface LoadedHotRagShard {
  value: unknown;
  bytesRead?: number;
}

export type HotRagShardLoader = (descriptor: HotRagShardDescriptor, signal?: AbortSignal) => Promise<LoadedHotRagShard>;

export interface HotRagRuntimeOptions {
  manifest: HotRagManifest;
  loadShard: HotRagShardLoader;
  embedQuery?: (query: string, provider: EmbeddingProvider, signal?: AbortSignal) => Promise<number[]>;
  maxCachedShards?: number;
  cacheTtlMs?: number;
  /** Optional exact blob/bootstrap bytes supplied by the Shelby integration. */
  proofContext?: HotRagProofContext;
  onProof?: (proof: HotRagProofSnapshot) => void;
}

export interface HotRagSearchWithProof {
  results: RetrievalResult[];
  proof: HotRagProofSnapshot;
}

interface LoadedRuntimeShard {
  shard: HotRagShard;
  observation: HotRagShardReadObservation;
}

const textEncoder = new TextEncoder();
const STOP_WORDS = new Set([
  "và", "là", "của", "cho", "trong", "một", "những", "các", "được", "về", "này", "đó", "với", "the", "and", "for", "with", "from", "that", "this",
]);

function tokens(value: string): string[] {
  return normalizeSearchText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function tokenCoverage(queryTokens: string[], value: string): number {
  if (!queryTokens.length) return 0;
  const haystack = new Set(tokens(value));
  return queryTokens.filter((token) => haystack.has(token)).length / queryTokens.length;
}

function tokenJaccard(left: string, right: string): number {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / (a.size + b.size - intersection);
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    a += left[index] ** 2;
    b += right[index] ** 2;
  }
  return dot / (Math.sqrt(a) * Math.sqrt(b) || 1);
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function decodeCentroid(value: QuantizedCentroid): number[] {
  const binary = atob(value.values);
  return Array.from(binary, (character) => (character.charCodeAt(0) - 128) * value.scale);
}

function quantizeCentroid(chunks: PortableChunk[]): QuantizedCentroid | undefined {
  const groups = new Map<string, { provider: EmbeddingProvider; dimensions: number; vectors: number[][] }>();
  for (const chunk of chunks) {
    if (!chunk.embedding?.length) continue;
    const provider = chunk.embeddingProvider ?? "gemini";
    const key = `${provider}:${chunk.embedding.length}`;
    const group = groups.get(key) ?? { provider, dimensions: chunk.embedding.length, vectors: [] };
    group.vectors.push(chunk.embedding);
    groups.set(key, group);
  }
  const group = [...groups.values()].sort((left, right) => right.vectors.length - left.vectors.length)[0];
  if (!group) return undefined;
  const centroid = Array.from({ length: group.dimensions }, (_, dimension) => group.vectors.reduce((sum, vector) => sum + vector[dimension], 0) / group.vectors.length);
  const magnitude = Math.sqrt(centroid.reduce((sum, item) => sum + item * item, 0)) || 1;
  const normalized = centroid.map((item) => item / magnitude);
  const maxAbsolute = Math.max(...normalized.map(Math.abs), 0.000_001);
  const scale = maxAbsolute / 127;
  const quantized = Uint8Array.from(normalized, (item) => Math.max(1, Math.min(255, Math.round(item / scale) + 128)));
  return { provider: group.provider, dimensions: group.dimensions, scale, values: encodeBytes(quantized) };
}

function shardKeywords(shard: HotRagShard): string[] {
  const counts = new Map<string, number>();
  const add = (value: string, boost = 1) => tokens(value).forEach((token) => counts.set(token, (counts.get(token) ?? 0) + boost));
  shard.documents.forEach((document) => {
    add(document.manifest.source, 5);
    add(document.manifest.displayName, 5);
    add(document.manifest.title?.value ?? "", 4);
    document.manifest.aliases.forEach((alias) => add(alias, 3));
  });
  shard.chunks.forEach(({ chunk }) => add(`${chunk.heading ?? ""} ${chunk.text}`));
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 96).map(([token]) => token);
}

function createShard(snapshotId: string, index: number, entries: Array<{ document: PortableRagDocument; chunk: PortableChunk; chunkIndex: number }>): HotRagShard {
  const bySource = new Map<string, HotRagShardDocument>();
  for (const { document, chunk } of entries) {
    const source = document.manifest.source;
    const current = bySource.get(source) ?? { manifest: document.manifest, pages: [], stories: document.stories ?? [] };
    const page = document.pages.find((candidate) => candidate.pageNumber === chunk.pageNumber);
    if (page && !current.pages.some((candidate) => candidate.pageNumber === page.pageNumber)) current.pages.push(page);
    bySource.set(source, current);
  }
  return {
    format: "shelby-hot-rag-shard",
    version: 1,
    snapshotId,
    index,
    documents: [...bySource.values()],
    chunks: entries.map(({ document, chunk, chunkIndex }) => ({ source: document.manifest.source, chunkIndex, chunk })),
  };
}

export function isHotRagManifest(value: unknown): value is HotRagManifest {
  const candidate = value as Partial<HotRagManifest> | null;
  if (!candidate || candidate.format !== "shelby-hot-rag-manifest" || (candidate.version !== 1 && candidate.version !== 2) || typeof candidate.snapshotId !== "string" || !candidate.snapshotId || typeof candidate.sourceOwner !== "string" || !candidate.sourceOwner || !Array.isArray(candidate.shards) || !Array.isArray(candidate.documents) || !candidate.totals || typeof candidate.totals !== "object") return false;
  if (!candidate.shards.length || candidate.shards.length > MAX_HOT_RAG_SHARDS) return false;
  return candidate.shards.every((descriptor, index) => (
    descriptor?.index === index
    && typeof descriptor.blobName === "string"
    && descriptor.blobName.length > 0
    && Number.isSafeInteger(descriptor.byteLength)
    && descriptor.byteLength > 0
    && descriptor.byteLength <= MAX_HOT_RAG_SHARD_BYTES
    && Number.isSafeInteger(descriptor.chunkCount)
    && descriptor.chunkCount >= 0
    && Array.isArray(descriptor.sources)
    && descriptor.sources.every((source) => typeof source === "string")
    && Array.isArray(descriptor.keywords)
    && descriptor.keywords.every((keyword) => typeof keyword === "string")
    && typeof descriptor.contentHash === "string"
    && SHA256_HEX.test(descriptor.contentHash)
  ));
}

export function isHotRagShard(value: unknown): value is HotRagShard {
  const candidate = value as Partial<HotRagShard> | null;
  return Boolean(candidate && candidate.format === "shelby-hot-rag-shard" && candidate.version === 1 && candidate.snapshotId && Array.isArray(candidate.documents) && Array.isArray(candidate.chunks));
}

export function isHotRagManifestName(name: string): boolean {
  return name.toLowerCase().endsWith(HOT_RAG_MANIFEST_SUFFIX);
}

export function isHotRagShardName(name: string): boolean {
  return name.toLowerCase().endsWith(HOT_RAG_SHARD_SUFFIX);
}

export function isHotRagPackName(name: string): boolean {
  return name.toLowerCase().endsWith(HOT_RAG_PACK_SUFFIX);
}

export function isRagArtifactName(name: string): boolean {
  return /\.shelby-rag\.json$/i.test(name) || isHotRagManifestName(name) || isHotRagShardName(name) || isHotRagPackName(name);
}

export function parseHotRagPackHeader(bytes: Uint8Array): HotRagPackHeader {
  if (bytes.byteLength < HOT_RAG_PACK_HEADER_BYTES) throw new Error(localize("The Shelby backup is incomplete or still downloading.", "Bản sao Shelby chưa đầy đủ hoặc chưa tải xong."));
  const magic = new TextDecoder().decode(bytes.subarray(0, HOT_RAG_PACK_MAGIC.length));
  if (magic !== HOT_RAG_PACK_MAGIC) throw new Error(localize("The Shelby backup has an unsupported format.", "Bản sao Shelby không đúng định dạng được hỗ trợ."));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, false);
  const manifestByteLength = view.getUint32(12, false);
  if (version !== HOT_RAG_PACK_VERSION) throw new Error(localize(`Backup version ${version} is not supported.`, `Phiên bản bản sao ${version} chưa được hỗ trợ.`));
  if (!manifestByteLength) throw new Error(localize("The Shelby backup has no directory.", "Bản sao Shelby không có mục lục."));
  return {
    version,
    manifestByteLength,
    manifestStart: HOT_RAG_PACK_HEADER_BYTES,
    payloadStart: HOT_RAG_PACK_HEADER_BYTES + manifestByteLength,
  };
}

export function parseHotRagPackManifest(bytes: Uint8Array, packByteLength?: number): HotRagManifest {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!isHotRagManifest(value) || value.version !== 2) throw new Error(localize("The Shelby backup directory is invalid.", "Mục lục trong bản sao Shelby không hợp lệ."));
  if (value.shards.some((descriptor) => !Number.isSafeInteger(descriptor.byteOffset) || descriptor.byteOffset! < 0 || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength <= 0)) {
    throw new Error(localize("The Shelby backup directory contains an invalid data region.", "Mục lục trong bản sao Shelby chứa vùng dữ liệu không hợp lệ."));
  }
  let previousEnd = 0;
  for (const [index, descriptor] of value.shards.entries()) {
    const rangeEnd = descriptor.byteOffset! + descriptor.byteLength;
    if (descriptor.index !== index || descriptor.byteOffset !== previousEnd || !Number.isSafeInteger(rangeEnd)) {
      throw new Error(localize("The Shelby backup directory contains overlapping or out-of-order regions.", "Mục lục trong bản sao Shelby có vùng dữ liệu chồng lấn hoặc sai thứ tự."));
    }
    previousEnd = rangeEnd;
  }
  const declaredBytes = value.shards.reduce((sum, descriptor) => sum + descriptor.byteLength, 0);
  if (!Number.isSafeInteger(value.totals.bytes) || value.totals.bytes !== declaredBytes) throw new Error(localize("The directory's data size does not match its regions.", "Tổng dung lượng vùng dữ liệu trong mục lục không khớp."));
  if (packByteLength !== undefined) {
    const expectedPackBytes = HOT_RAG_PACK_HEADER_BYTES + bytes.byteLength + previousEnd;
    if (!Number.isSafeInteger(packByteLength) || packByteLength !== expectedPackBytes) throw new Error(localize("The backup blob size does not match its directory.", "Kích thước blob bản sao không khớp mục lục."));
  }
  parsedManifestByteLengths.set(value, bytes.byteLength);
  return value;
}

/**
 * Shelby has a flat blob namespace, but `/` prefixes are treated as folders by
 * the Explorer, CLI and S3 gateway. Keep every snapshot under one prefix.
 */
export function hotRagPartBlobName(manifestBlobName: string, index: number): string {
  const slashIndex = manifestBlobName.lastIndexOf("/");
  const snapshotFolder = slashIndex >= 0
    ? manifestBlobName.slice(0, slashIndex)
    : manifestBlobName.replace(/\.shelby-hot-rag\.json$/i, "");
  return `${snapshotFolder}/parts/${String(index).padStart(4, "0")}${HOT_RAG_SHARD_SUFFIX}`;
}

export async function buildHotRagSnapshot(packageData: PortableRagPackage, baseName: string, targetShardBytes = DEFAULT_HOT_RAG_SHARD_BYTES): Promise<HotRagSnapshot> {
  if (!packageData.documents.length) throw new Error(localize("There are no documents to back up yet.", "Kho tri thức chưa có tài liệu để lưu."));
  const safeTarget = Math.max(64 * 1024, targetShardBytes);
  const snapshotId = `${packageData.sourceOwner.toLowerCase()}:${packageData.exportedAt}`;
  const entries = packageData.documents.flatMap((document) => document.chunks.map((chunk, chunkIndex) => ({ document, chunk, chunkIndex })));
  if (!entries.length) throw new Error(localize("There are no searchable chunks to back up yet.", "Kho tri thức chưa có chunks để lưu."));

  // Keep every page and its chunks in one range. Splitting a large page across
  // ranges would duplicate the full page text in each shard and could inflate a
  // pack many times over (especially for long video transcripts).
  const entriesByPage = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = `${entry.document.manifest.source}:${entry.chunk.pageNumber}`;
    const pageEntries = entriesByPage.get(key) ?? [];
    pageEntries.push(entry);
    entriesByPage.set(key, pageEntries);
  }
  const groups: typeof entries[] = [];
  let current: typeof entries = [];
  let estimatedBytes = 0;
  for (const pageEntries of entriesByPage.values()) {
    // A standalone serialized page group is a conservative estimate when page
    // groups are combined because document metadata can then be de-duplicated.
    const pageGroupBytes = textEncoder.encode(JSON.stringify(createShard(snapshotId, 0, pageEntries))).byteLength;
    if (current.length && estimatedBytes + pageGroupBytes > safeTarget) {
      groups.push(current);
      current = [];
      estimatedBytes = 0;
    }
    current.push(...pageEntries);
    estimatedBytes += pageGroupBytes;
  }
  if (current.length) groups.push(current);

  const parts: HotRagUploadPart[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const shard = createShard(snapshotId, index, groups[index]);
    const content = JSON.stringify(shard);
    const contentBytes = textEncoder.encode(content).byteLength;
    if (contentBytes > MAX_HOT_RAG_SHARD_BYTES) throw new Error(localize(
      "One page produced a RAG region larger than 8 MB. Reduce or split the document before saving to Shelby.",
      "Một trang tạo ra vùng RAG lớn hơn 8 MB. Hãy giảm kích thước tài liệu hoặc chia nội dung trước khi lưu lên Shelby.",
    ));
    const blobName = hotRagPartBlobName(baseName, index);
    parts.push({
      shard,
      content,
      descriptor: {
        index,
        blobName,
        byteLength: contentBytes,
        chunkCount: shard.chunks.length,
        sources: shard.documents.map((document) => document.manifest.source),
        keywords: shardKeywords(shard),
        centroid: quantizeCentroid(shard.chunks.map(({ chunk }) => chunk)),
        contentHash: await sha256Text(content),
      },
    });
  }

  const manifest: HotRagManifest = {
    format: "shelby-hot-rag-manifest",
    version: 1,
    snapshotId,
    exportedAt: packageData.exportedAt,
    sourceOwner: packageData.sourceOwner,
    inventory: packageData.inventory,
    documents: packageData.documents.map((document) => document.manifest),
    stories: packageData.documents.flatMap((document) => document.stories ?? []),
    shards: parts.map((part) => part.descriptor),
    totals: {
      documents: packageData.documents.length,
      pages: packageData.documents.reduce((sum, document) => sum + document.pages.length, 0),
      chunks: entries.length,
      bytes: parts.reduce((sum, part) => sum + part.descriptor.byteLength, 0),
    },
  };
  return { manifest, manifestContent: JSON.stringify(manifest), parts };
}

/**
 * Packs the searchable manifest and all independently verifiable RAG regions
 * into one Shelby blob. `byteOffset` remains relative to the payload so the
 * manifest length can change without creating circular offsets.
 */
export async function buildHotRagPack(packageData: PortableRagPackage, blobName: string, targetShardBytes = DEFAULT_HOT_RAG_SHARD_BYTES): Promise<HotRagPack> {
  if (!isHotRagPackName(blobName)) throw new Error(localize(
    `The backup name must end with “${HOT_RAG_PACK_SUFFIX}”.`,
    `Tên bản sao phải kết thúc bằng “${HOT_RAG_PACK_SUFFIX}”.`,
  ));
  const legacyShape = await buildHotRagSnapshot(packageData, blobName, targetShardBytes);
  const encodedParts = legacyShape.parts.map((part) => textEncoder.encode(part.content));
  let byteOffset = 0;
  const descriptors = legacyShape.parts.map((part, index) => {
    const descriptor: HotRagShardDescriptor = {
      ...part.descriptor,
      blobName,
      byteOffset,
      byteLength: encodedParts[index].byteLength,
    };
    byteOffset += encodedParts[index].byteLength;
    return descriptor;
  });
  const manifest: HotRagManifest = { ...legacyShape.manifest, version: 2, shards: descriptors };
  const manifestContent = JSON.stringify(manifest);
  const manifestBytes = textEncoder.encode(manifestContent);
  parsedManifestByteLengths.set(manifest, manifestBytes.byteLength);
  const headerBytes = new Uint8Array(HOT_RAG_PACK_HEADER_BYTES);
  headerBytes.set(textEncoder.encode(HOT_RAG_PACK_MAGIC), 0);
  const headerView = new DataView(headerBytes.buffer);
  headerView.setUint32(8, HOT_RAG_PACK_VERSION, false);
  headerView.setUint32(12, manifestBytes.byteLength, false);

  const bytes = new Uint8Array(HOT_RAG_PACK_HEADER_BYTES + manifestBytes.byteLength + byteOffset);
  bytes.set(headerBytes, 0);
  bytes.set(manifestBytes, HOT_RAG_PACK_HEADER_BYTES);
  let writeOffset = HOT_RAG_PACK_HEADER_BYTES + manifestBytes.byteLength;
  encodedParts.forEach((partBytes) => {
    bytes.set(partBytes, writeOffset);
    writeOffset += partBytes.byteLength;
  });
  const parts = legacyShape.parts.map((part, index) => ({ ...part, descriptor: descriptors[index] }));
  return {
    blobName,
    manifest,
    manifestContent,
    parts,
    bytes,
    header: {
      version: HOT_RAG_PACK_VERSION,
      manifestByteLength: manifestBytes.byteLength,
      manifestStart: HOT_RAG_PACK_HEADER_BYTES,
      payloadStart: HOT_RAG_PACK_HEADER_BYTES + manifestBytes.byteLength,
    },
  };
}

export function hotRagManifestToPortableCatalog(manifest: HotRagManifest): PortableRagPackage {
  return {
    format: "shelby-rag-package",
    version: 1,
    exportedAt: manifest.exportedAt,
    sourceOwner: manifest.sourceOwner,
    inventory: manifest.inventory,
    documents: manifest.documents.map((document) => ({ manifest: document, pages: [], chunks: [], stories: manifest.stories.filter((story) => story.source === document.source) })),
  };
}

function remoteDocumentId(owner: string, source: string): string {
  return `shelby:${owner.toLowerCase()}:${source}`;
}

function metricNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export class HotRagRuntime {
  private readonly cache = new Map<string, { shard: HotRagShard; loadedAt: number }>();
  private readonly queryEmbeddings = new Map<string, number[]>();
  private latestProof?: HotRagProofSnapshot;

  constructor(private readonly options: HotRagRuntimeOptions) {}

  get manifest(): HotRagManifest {
    return this.options.manifest;
  }

  getLatestProofSnapshot(): HotRagProofSnapshot | undefined {
    return this.latestProof;
  }

  private async queryEmbedding(query: string, provider: EmbeddingProvider, signal?: AbortSignal): Promise<number[] | undefined> {
    if (!this.options.embedQuery) return undefined;
    const key = `${provider}:${normalizeSearchText(query)}`;
    const cached = this.queryEmbeddings.get(key);
    if (cached) return cached;
    try {
      const embedding = await this.options.embedQuery(query, provider, signal);
      signal?.throwIfAborted();
      this.queryEmbeddings.set(key, embedding);
      if (this.queryEmbeddings.size > 16) this.queryEmbeddings.delete(this.queryEmbeddings.keys().next().value!);
      return embedding;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  private async rankShards(query: string, signal?: AbortSignal): Promise<HotRagShardDescriptor[]> {
    const queryTokens = tokens(query);
    const providers = new Set(this.manifest.shards.flatMap((descriptor) => descriptor.centroid ? [descriptor.centroid.provider] : []));
    const embeddings = new Map<EmbeddingProvider, number[]>();
    await Promise.all([...providers].map(async (provider) => {
      const embedding = await this.queryEmbedding(query, provider, signal);
      if (embedding) embeddings.set(provider, embedding);
    }));
    return this.manifest.shards.map((descriptor) => {
      const searchable = `${descriptor.sources.join(" ")} ${descriptor.keywords.join(" ")}`;
      const lexical = tokenCoverage(queryTokens, searchable);
      const semantic = descriptor.centroid ? cosine(embeddings.get(descriptor.centroid.provider) ?? [], decodeCentroid(descriptor.centroid)) : 0;
      return { descriptor, score: lexical * 0.72 + Math.max(0, semantic) * 0.28 };
    }).sort((left, right) => right.score - left.score || left.descriptor.index - right.descriptor.index).map(({ descriptor }) => descriptor);
  }

  private async load(descriptor: HotRagShardDescriptor, signal?: AbortSignal): Promise<LoadedRuntimeShard> {
    const startedAt = metricNow();
    signal?.throwIfAborted();
    const now = Date.now();
    const cacheKey = `${descriptor.blobName}:${descriptor.byteOffset ?? descriptor.index}`;
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.loadedAt < (this.options.cacheTtlMs ?? 5 * 60_000)) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return {
        shard: cached.shard,
        observation: { descriptor, cacheHit: true, networkBytesRead: 0, latencyMs: metricNow() - startedAt },
      };
    }
    const loaded = await this.options.loadShard(descriptor, signal);
    signal?.throwIfAborted();
    if (!isHotRagShard(loaded.value) || loaded.value.snapshotId !== this.manifest.snapshotId || loaded.value.index !== descriptor.index) throw new Error(localize(`Data region “${descriptor.blobName}” does not belong to this backup.`, `Phần dữ liệu “${descriptor.blobName}” không khớp bản sao.`));
    if (loaded.value.chunks.length !== descriptor.chunkCount) throw new Error(localize(`Data region “${descriptor.blobName}” has a different chunk count from the directory.`, `Phần dữ liệu “${descriptor.blobName}” có số chunks không khớp mục lục.`));
    if (loaded.bytesRead !== undefined && loaded.bytesRead !== descriptor.byteLength) throw new Error(localize(`Data region “${descriptor.blobName}” is incomplete.`, `Phần dữ liệu “${descriptor.blobName}” không đủ byte như mục lục.`));
    const contentHash = await sha256Text(JSON.stringify(loaded.value));
    if (contentHash !== descriptor.contentHash) throw new Error(localize(
      `Data region “${descriptor.blobName}” failed its integrity check.`,
      `Phần dữ liệu “${descriptor.blobName}” không vượt qua kiểm tra toàn vẹn.`,
    ));
    const item = { shard: loaded.value, loadedAt: now };
    this.cache.set(cacheKey, item);
    const maxCached = this.options.maxCachedShards ?? 6;
    while (this.cache.size > maxCached) this.cache.delete(this.cache.keys().next().value!);
    return {
      shard: item.shard,
      observation: {
        descriptor,
        cacheHit: false,
        networkBytesRead: loaded.bytesRead,
        latencyMs: metricNow() - startedAt,
      },
    };
  }

  async searchWithProof(
    query: string,
    limit = 8,
    signal?: AbortSignal,
    excludeSources = new Set<string>(),
    options: { exhaustive?: boolean } = {},
  ): Promise<HotRagSearchWithProof> {
    const startedAt = metricNow();
    const rankedShards = await this.rankShards(query, signal);
    const loadAvailable = async (descriptors: HotRagShardDescriptor[]) => {
      const settled = await Promise.allSettled(descriptors.map((descriptor) => this.load(descriptor, signal)));
      signal?.throwIfAborted();
      const successful = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) console.warn(`Skipped ${failures.length} unreadable RAG regions and continued with the rest.`, failures[0]);
      if (!successful.length && descriptors.length && failures.length) throw failures[0];
      return successful;
    };
    const initialCount = Math.min(3, rankedShards.length);
    let loaded = await loadAvailable(rankedShards.slice(0, initialCount));
    let candidates = await this.rankEntries(query, loaded.map((item) => item.shard), excludeSources, signal);
    let cursor = initialCount;
    const adaptiveReadLimit = options.exhaustive ? rankedShards.length : Math.min(rankedShards.length, 9);
    while (cursor < adaptiveReadLimit && (
      options.exhaustive
      || candidates.length === 0
      || (candidates[0]?.score ?? 0) < 0.34
    )) {
      const nextCursor = Math.min(cursor + 2, adaptiveReadLimit);
      const fallback = await loadAvailable(rankedShards.slice(cursor, nextCursor));
      loaded = [...loaded, ...fallback];
      candidates = await this.rankEntries(query, loaded.map((item) => item.shard), excludeSources, signal);
      cursor = nextCursor;
    }
    const proof = createHotRagProofSnapshot({
      manifest: this.manifest,
      context: {
        ...this.options.proofContext,
        manifestBytes: this.options.proofContext?.manifestBytes ?? parsedManifestByteLengths.get(this.manifest),
      },
      observations: loaded.map((item) => item.observation),
      latencyMs: metricNow() - startedAt,
    });
    this.latestProof = proof;
    this.options.onProof?.(proof);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("shelby:hot-rag-read", {
        detail: {
          ...proof,
          // Backward-compatible aliases for the earlier lightweight event.
          shardsRead: proof.retrieval.cacheMisses,
          bytesRead: proof.retrieval.networkBytesRead,
        },
      }));
    }
    const results = candidates.slice(0, limit).map((result) => ({
      ...result,
      provenance: result.provenance ? {
        ...result.provenance,
        storageMode: "shelby_hot" as const,
        ...(proof.retrieval.networkBytesRead === null ? {} : { bytesRead: proof.retrieval.networkBytesRead }),
      } : result.provenance,
    }));
    return { results, proof };
  }

  async search(query: string, limit = 8, signal?: AbortSignal, excludeSources = new Set<string>()): Promise<RetrievalResult[]> {
    return (await this.searchWithProof(query, limit, signal, excludeSources)).results;
  }

  private async rankEntries(query: string, shards: HotRagShard[], excludeSources: Set<string>, signal?: AbortSignal): Promise<RetrievalResult[]> {
    const queryTokens = tokens(query);
    const normalizedQuery = normalizeSearchText(query);
    const providers = new Set<EmbeddingProvider>();
    shards.forEach((shard) => shard.chunks.forEach(({ chunk }) => { if (chunk.embedding?.length) providers.add(chunk.embeddingProvider ?? "gemini"); }));
    const embeddings = new Map<EmbeddingProvider, number[]>();
    await Promise.all([...providers].map(async (provider) => {
      const embedding = await this.queryEmbedding(query, provider, signal);
      if (embedding) embeddings.set(provider, embedding);
    }));

    const results: RetrievalResult[] = [];
    for (const shard of shards) {
      for (const { source, chunkIndex, chunk } of shard.chunks) {
        signal?.throwIfAborted();
        if (excludeSources.has(source)) continue;
        const document = shard.documents.find((candidate) => candidate.manifest.source === source);
        if (!document || document.manifest.status !== "indexed") continue;
        const coverage = tokenCoverage(queryTokens, chunk.text);
        const exact = Boolean(normalizedQuery && chunk.normalizedText.includes(normalizedQuery));
        const provider = chunk.embeddingProvider ?? "gemini";
        const semantic = chunk.embedding?.length ? cosine(embeddings.get(provider) ?? [], chunk.embedding) : 0;
        const score = coverage * 0.42 + (exact ? 0.85 : 0) + Math.max(0, semantic) * 0.5;
        if (score < 0.12) continue;
        const owner = document.manifest.originalSourceOwner || this.manifest.sourceOwner;
        const documentId = remoteDocumentId(owner, source);
        const page = document.pages.find((candidate) => candidate.pageNumber === chunk.pageNumber);
        const isPublic = document.manifest.accessTag === "public";
        results.push({
          method: semantic > 0 && (coverage > 0 || exact) ? "hybrid" : semantic > 0 ? "semantic" : "lexical",
          documentId,
          source,
          displayName: document.manifest.displayName,
          pageNumber: chunk.pageNumber,
          totalPages: chunk.totalPages,
          excerpt: chunk.text,
          score,
          imageUrl: chunk.imageUrl,
          link: isPublic ? `${getShelbyBlobUrl(owner, source)}${chunk.pageNumber ? `#page=${chunk.pageNumber}` : ""}` : undefined,
          provenance: {
            owner,
            accessTag: document.manifest.accessTag,
            blobId: document.manifest.blobId,
            blobMerkleRoot: document.manifest.blobMerkleRoot,
            blobSize: document.manifest.blobSize,
            blobCreatedAtMicros: document.manifest.blobCreatedAtMicros,
            indexedAt: document.manifest.sourceIndexedAt ?? this.manifest.exportedAt,
            sourceRevision: document.manifest.sourceRevision ?? `hot:${this.manifest.exportedAt}`,
            chunkId: `${documentId}:chunk:${chunkIndex}`,
            mimeType: document.manifest.mimeType,
            pageContentHash: page?.contentHash,
            chunkContentHash: chunk.contentHash,
            extractionMethod: page?.extractionMethod,
            storageMode: "shelby_hot",
            shardName: this.manifest.shards[shard.index]?.blobName,
          },
        });
      }
    }

    const output: RetrievalResult[] = [];
    const perDocument = new Map<string, number>();
    for (const result of results.sort((left, right) => right.score - left.score)) {
      if ((perDocument.get(result.documentId) ?? 0) >= 4) continue;
      if (output.some((item) => item.documentId === result.documentId && tokenJaccard(item.excerpt, result.excerpt) >= 0.86)) continue;
      output.push(result);
      perDocument.set(result.documentId, (perDocument.get(result.documentId) ?? 0) + 1);
    }
    return output;
  }

  async lookupExactQuote(quote: string, signal?: AbortSignal): Promise<RetrievalResult | null> {
    // Exact-location requests favor correctness over the normal bounded read:
    // scan every independently verifiable range until ranking sees the quote.
    const { results } = await this.searchWithProof(quote, 12, signal, new Set(), { exhaustive: true });
    const normalized = normalizeSearchText(quote);
    return results.find((result) => normalizeSearchText(result.excerpt).includes(normalized)) ?? null;
  }

  getPageRecord(documentId: string, pageNumber: number): PageRecord | undefined {
    for (const cached of this.cache.values()) {
      for (const document of cached.shard.documents) {
        const owner = document.manifest.originalSourceOwner || this.manifest.sourceOwner;
        if (remoteDocumentId(owner, document.manifest.source) !== documentId) continue;
        const page = document.pages.find((candidate) => candidate.pageNumber === pageNumber);
        if (page) return { ...page, id: `${documentId}:page:${pageNumber}`, owner, documentId };
      }
    }
    return undefined;
  }

  async reconstruct(signal?: AbortSignal): Promise<PortableRagPackage> {
    const loaded = await Promise.all(this.manifest.shards.map((descriptor) => this.load(descriptor, signal)));
    const documents = new Map<string, PortableRagDocument>();
    for (const { shard } of loaded.sort((left, right) => left.shard.index - right.shard.index)) {
      for (const document of shard.documents) {
        const current = documents.get(document.manifest.source) ?? { manifest: document.manifest, pages: [], chunks: [], stories: document.stories ?? [] };
        document.pages.forEach((page) => { if (!current.pages.some((candidate) => candidate.pageNumber === page.pageNumber)) current.pages.push(page); });
        documents.set(document.manifest.source, current);
      }
      shard.chunks.forEach(({ source, chunkIndex, chunk }) => {
        const document = documents.get(source);
        if (document) document.chunks[chunkIndex] = chunk;
      });
    }
    return {
      format: "shelby-rag-package",
      version: 1,
      exportedAt: this.manifest.exportedAt,
      sourceOwner: this.manifest.sourceOwner,
      inventory: this.manifest.inventory,
      documents: [...documents.values()].map((document) => ({ ...document, chunks: document.chunks.filter(Boolean), pages: document.pages.sort((left, right) => left.pageNumber - right.pageNumber) })),
    };
  }
}
