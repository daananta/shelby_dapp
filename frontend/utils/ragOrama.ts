import { create, insert, search } from "@orama/orama";
import { embedTexts, type EmbeddingProvider } from "@/utils/embeddingClient";
import { normalizeSearchText } from "@/utils/textExtractor";
import { getShelbyBlobUrl } from "@/utils/shelbyConfig";
import type { ChunkRecord, DocumentManifest, DocumentReplacement, MetadataValue, PageRecord, PortableRagPackage, RetrievalResult, StoryEntry } from "@/utils/ragTypes";
import { getGeminiUsagePreferences } from "@/utils/geminiUsage";
import { isRagArtifactName } from "@/utils/hotRag";
import { sha256Text } from "@/utils/contentIntegrity";
import { localize } from "@/i18n";

export type { MetadataValue, DocumentManifest, PageRecord, PortableRagPackage, RetrievalResult, StoryEntry } from "@/utils/ragTypes";

export interface RagSource {
  source: string;
  displayName: string;
  title?: string;
  titleMetadata?: MetadataValue;
  aliases: string[];
  authors: string[];
  blobUrl?: string;
  type: "text" | "image" | "video";
  status: DocumentManifest["status"];
  chunks: number;
  pageCount?: number;
  ocrCoverage: number;
  textCoverage?: number;
  accessTag?: DocumentManifest["accessTag"];
  embeddingStatus: DocumentManifest["embeddingStatus"];
  embeddingProvider?: DocumentManifest["embeddingProvider"];
  revision: string;
  indexedAt: number;
  error?: string;
}

interface WorkspaceRecord {
  id: string;
  owner: string;
  inventory: { names: string[]; eligibleNames?: string[]; fetchedAt: number; verified?: boolean } | null;
  stories: StoryEntry[];
}

const DB_NAME = "shelby-rag-explorer-v4";
const DB_VERSION = 1;
let databasePromise: Promise<IDBDatabase | null> | null = null;
let activeOwner: string | null = null;
const manifests = new Map<string, DocumentManifest>();
const pages = new Map<string, PageRecord>();
const chunks = new Map<string, ChunkRecord>();
let workspace: WorkspaceRecord | null = null;
let lexicalDb: any = null;
let contentLoaded = false;
const queryEmbeddingCache = new Map<string, number[]>();
let ownerSwitch = Promise.resolve();
export interface RemoteRagProvider {
  id: string;
  /** Legacy single-file snapshot loader. New Hot RAG providers search shards directly. */
  load?: (signal?: AbortSignal) => Promise<PortableRagPackage | null>;
  search?: (query: string, limit: number, signal?: AbortSignal, excludeSources?: Set<string>) => Promise<RetrievalResult[]>;
  lookupExactQuote?: (quote: string, signal?: AbortSignal) => Promise<RetrievalResult | null>;
  getPageRecord?: (documentId: string, pageNumber: number) => PageRecord | undefined;
  mode?: "legacy" | "hot";
  cacheTtlMs?: number;
}
let remoteRagProvider: RemoteRagProvider | null = null;
let remoteRagCache: { providerId: string; packageData: PortableRagPackage; loadedAt: number } | null = null;

function emitRagState() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("shelby:rag-state"));
}

/**
 * `eligibleNames` is written only after a successful Shelby inventory + policy
 * refresh. Older workspaces intentionally fall back to their previous behavior
 * until the first authoritative refresh migrates them.
 */
function isSourceEligibleInCurrentInventory(source: string): boolean {
  if (workspace?.inventory?.verified === false) return false;
  const eligibleNames = workspace?.inventory?.eligibleNames;
  return !Array.isArray(eligibleNames) || eligibleNames.includes(source);
}

function isSearchableManifest(manifest: DocumentManifest): boolean {
  return manifest.status === "indexed" && isSourceEligibleInCurrentInventory(manifest.source);
}

/** Registers the current wallet's newest Shelby snapshot as an on-demand search source. */
export function setRemoteRagProvider(provider: RemoteRagProvider | null) {
  const changed = remoteRagProvider?.id !== provider?.id;
  remoteRagProvider = provider;
  if (changed) remoteRagCache = null;
  emitRagState();
}

export function hasRemoteRagProvider(): boolean {
  return Boolean(remoteRagProvider);
}

export function isHotRemoteRagProvider(): boolean {
  return remoteRagProvider?.mode === "hot";
}

export function primeRemoteRagPackage(providerId: string, packageData: PortableRagPackage) {
  if (remoteRagProvider?.id !== providerId) return;
  remoteRagCache = { providerId, packageData, loadedAt: Date.now() };
  emitRagState();
}

async function getRemoteRagPackage(signal?: AbortSignal): Promise<PortableRagPackage | null> {
  signal?.throwIfAborted();
  const provider = remoteRagProvider;
  if (!provider?.load) return null;
  const ttl = provider.cacheTtlMs ?? 60_000;
  if (remoteRagCache?.providerId === provider.id && Date.now() - remoteRagCache.loadedAt < ttl) return remoteRagCache.packageData;
  const packageData = await provider.load(signal);
  signal?.throwIfAborted();
  if (packageData && remoteRagProvider?.id === provider.id) remoteRagCache = { providerId: provider.id, packageData, loadedAt: Date.now() };
  return packageData;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error(localize("The browser database operation was cancelled.", "Thao tác cơ sở dữ liệu trình duyệt đã bị huỷ.")));
  });
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const manifestStore = db.createObjectStore("manifests", { keyPath: "id" });
      manifestStore.createIndex("owner", "owner");
      manifestStore.createIndex("ownerSource", ["owner", "source"], { unique: true });
      const pageStore = db.createObjectStore("pages", { keyPath: "id" });
      pageStore.createIndex("owner", "owner");
      pageStore.createIndex("documentId", "documentId");
      const chunkStore = db.createObjectStore("chunks", { keyPath: "id" });
      chunkStore.createIndex("owner", "owner");
      chunkStore.createIndex("documentId", "documentId");
      db.createObjectStore("workspace", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function readOwnerRecords<T>(storeName: "manifests" | "pages" | "chunks", owner: string): Promise<T[]> {
  const db = await openDatabase();
  if (!db) return [];
  const transaction = db.transaction(storeName, "readonly");
  return requestValue(transaction.objectStore(storeName).index("owner").getAll(owner)) as Promise<T[]>;
}

async function migrateLegacyState(owner: string) {
  if (typeof indexedDB === "undefined" || manifests.size) return;
  const legacy = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open("shelby-rag-explorer", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  if (!legacy || !legacy.objectStoreNames.contains("state")) return;
  try {
    const transaction = legacy.transaction("state", "readonly");
    const state: any = await requestValue(transaction.objectStore("state").get("orama-v2"));
    if (!state || state.activeRagOwner?.toLowerCase() !== owner) return;
    const migrated: DocumentManifest[] = (state.sources ?? []).map((source: any) => ({
      id: `${owner}:${source.source}`,
      owner,
      source: source.source,
      displayName: source.displayName ?? source.source,
      revision: "legacy-v3",
      blobUrl: source.blobUrl,
      mimeType: source.type === "image" ? "image/*" : "application/pdf",
      type: source.type ?? "text",
      aliases: [],
      authors: [],
      pageCount: source.pageCount ?? 0,
      chunkCount: 0,
      ocrCoverage: 0,
      embeddingStatus: "unavailable",
      status: "upgrade_required",
      indexedAt: source.indexedAt ?? Date.now(),
      error: localize("This old index has no page-level data. Process the document again.", "Chỉ mục cũ không có dữ liệu theo trang; hãy nạp lại tài liệu một lần."),
    }));
    const db = await openDatabase();
    if (!db) return;
    const write = db.transaction(["manifests", "workspace"], "readwrite");
    migrated.forEach((manifest) => write.objectStore("manifests").put(manifest));
    const migratedWorkspace: WorkspaceRecord = {
      id: owner,
      owner,
      inventory: state.blobInventory?.owner?.toLowerCase() === owner ? { names: state.blobInventory.names ?? [], fetchedAt: state.blobInventory.fetchedAt ?? Date.now() } : null,
      stories: [],
    };
    write.objectStore("workspace").put(migratedWorkspace);
    await transactionDone(write);
    migrated.forEach((manifest) => manifests.set(manifest.source, manifest));
    workspace = migratedWorkspace;
  } finally {
    legacy.close();
  }
}

async function loadOwner(owner: string) {
  manifests.clear();
  pages.clear();
  chunks.clear();
  lexicalDb = null;
  contentLoaded = false;
  const storedManifests = await readOwnerRecords<DocumentManifest>("manifests", owner);
  storedManifests.forEach((manifest) => manifests.set(manifest.source, manifest));
  const db = await openDatabase();
  workspace = db ? await requestValue(db.transaction("workspace", "readonly").objectStore("workspace").get(owner)) ?? null : null;
  await migrateLegacyState(owner);
}

async function ensureContentLoaded() {
  await ownerSwitch;
  const contentOwner = activeOwner;
  if (contentLoaded || !contentOwner) return;
  const [storedPages, storedChunks] = await Promise.all([
    readOwnerRecords<PageRecord>("pages", contentOwner),
    readOwnerRecords<ChunkRecord>("chunks", contentOwner),
  ]);
  if (activeOwner !== contentOwner) {
    await ownerSwitch;
    return ensureContentLoaded();
  }
  pages.clear();
  chunks.clear();
  storedPages.forEach((page) => pages.set(page.id, page));
  storedChunks.forEach((chunk) => chunks.set(chunk.id, chunk));
  contentLoaded = true;
}

export async function setActiveRagOwner(owner: string) {
  const normalized = owner.toLowerCase();
  ownerSwitch = ownerSwitch.then(async () => {
    if (activeOwner === normalized) return;
    // Change the authority before hydration starts. Any in-flight write for the
    // previous wallet can still finish its owner-keyed IndexedDB transaction,
    // but must not mutate the new wallet's in-memory workspace afterwards.
    activeOwner = normalized;
    queryEmbeddingCache.clear();
    await loadOwner(normalized);
  });
  await ownerSwitch;
}

/**
 * Drops the active wallet authority and every hydrated search object without
 * deleting that wallet's persisted IndexedDB records. `expectedOwner` makes a
 * late disconnect cleanup harmless after another wallet has already connected.
 */
export async function deactivateActiveRagOwner(expectedOwner?: string): Promise<boolean> {
  const normalizedExpectedOwner = expectedOwner?.toLowerCase();
  let deactivated = false;
  ownerSwitch = ownerSwitch.then(async () => {
    if (normalizedExpectedOwner && activeOwner !== normalizedExpectedOwner) return;
    activeOwner = null;
    manifests.clear();
    pages.clear();
    chunks.clear();
    workspace = null;
    lexicalDb = null;
    contentLoaded = false;
    queryEmbeddingCache.clear();
    remoteRagProvider = null;
    remoteRagCache = null;
    deactivated = true;
    emitRagState();
  });
  await ownerSwitch;
  return deactivated;
}

/** Compatibility name retained for existing callers; v4 hydrates only persisted records here. */
export async function getVectorDB() {
  await ownerSwitch;
  if (activeOwner && !workspace) await loadOwner(activeOwner);
  return null;
}

function asRagSource(manifest: DocumentManifest): RagSource {
  return {
    source: manifest.source,
    displayName: manifest.displayName,
    title: manifest.title?.value,
    titleMetadata: manifest.title,
    aliases: manifest.aliases,
    authors: manifest.authors,
    blobUrl: manifest.blobUrl,
    type: manifest.type,
    status: manifest.status,
    chunks: manifest.chunkCount,
    pageCount: manifest.pageCount || undefined,
    ocrCoverage: manifest.ocrCoverage,
    textCoverage: manifest.textCoverage,
    accessTag: manifest.accessTag,
    embeddingStatus: manifest.embeddingStatus,
    embeddingProvider: manifest.embeddingProvider,
    revision: manifest.revision,
    indexedAt: manifest.indexedAt,
    error: manifest.error,
  };
}

export function getRagSources(): RagSource[] {
  return Array.from(manifests.values()).filter((manifest) => isSourceEligibleInCurrentInventory(manifest.source)).map(asRagSource);
}

export function getDocumentManifests(): DocumentManifest[] {
  return Array.from(manifests.values()).filter((manifest) => isSourceEligibleInCurrentInventory(manifest.source));
}

export async function exportPortableRagPackage(options: { includeEmbeddings?: boolean; exportedAt?: number } = {}): Promise<PortableRagPackage> {
  if (!activeOwner) throw new Error(localize("Connect a wallet before creating a RAG backup.", "Hãy kết nối ví trước khi đóng gói RAG."));
  await ensureContentLoaded();
  const documents = Array.from(manifests.values()).filter(isSearchableManifest).map((manifest) => {
    const documentPages = Array.from(pages.values()).filter((page) => page.documentId === manifest.id).map(({ owner: _owner, id: _id, documentId: _documentId, ...page }) => page);
    const documentChunks = Array.from(chunks.values()).filter((chunk) => chunk.documentId === manifest.id).map(({ owner: _owner, id: _id, documentId: _documentId, ...chunk }) => {
      if (options.includeEmbeddings) return chunk;
      const { embedding: _embedding, ...withoutEmbedding } = chunk;
      return withoutEmbedding;
    });
    const documentStories = (workspace?.stories ?? []).filter((story) => story.source === manifest.source);
    const { owner, id: _id, revision, embeddingStatus: _embeddingStatus, indexedAt, ...portableManifest } = manifest;
    return { manifest: { ...portableManifest, originalSourceOwner: owner, sourceRevision: revision, sourceIndexedAt: indexedAt }, pages: documentPages, chunks: documentChunks, stories: documentStories };
  });
  const inventory = workspace?.inventory
    ? {
        fetchedAt: workspace.inventory.fetchedAt,
        names: (workspace.inventory.eligibleNames ?? workspace.inventory.names).filter((name) => !isRagArtifactName(name)),
      }
    : undefined;
  const exportedAt = Number.isSafeInteger(options.exportedAt) && Number(options.exportedAt) > 0 ? Number(options.exportedAt) : Date.now();
  return { format: "shelby-rag-package", version: 1, exportedAt, sourceOwner: activeOwner, inventory, documents };
}

export function isPortableRagPackage(value: unknown): value is PortableRagPackage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PortableRagPackage>;
  return candidate.format === "shelby-rag-package" && candidate.version === 1 && Array.isArray(candidate.documents);
}

/** Import lexical/page evidence atomically. Embeddings are intentionally rebuilt on this device. */
export async function importPortableRagPackage(value: unknown, expectedOwner?: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  if (!activeOwner) throw new Error(localize("Connect a wallet before importing a RAG backup.", "Hãy kết nối ví trước khi nhập gói RAG."));
  const importOwner = (expectedOwner ?? activeOwner).toLowerCase();
  if (activeOwner !== importOwner) throw new DOMException(localize("The wallet changed; RAG import stopped.", "Ví đã thay đổi; dừng nhập RAG."), "AbortError");
  if (!isPortableRagPackage(value)) throw new Error(localize("This is not a valid Shelby RAG v1 backup.", "Đây không phải gói Shelby RAG v1 hợp lệ."));
  let imported = 0;
  for (const portable of value.documents) {
    signal?.throwIfAborted();
    if (!portable?.manifest?.source || !Array.isArray(portable.pages) || !Array.isArray(portable.chunks)) continue;
    // A remote capsule can outlive or predate its source policy. Never restore
    // a document that the latest authoritative Shelby refresh no longer allows.
    if (!isSourceEligibleInCurrentInventory(portable.manifest.source)) continue;
    if (activeOwner !== importOwner) throw new DOMException(localize("The wallet changed; RAG import stopped.", "Ví đã thay đổi; dừng nhập RAG."), "AbortError");
    const documentId = `${importOwner}:${portable.manifest.source}`;
    const { originalSourceOwner: _originalSourceOwner, sourceRevision, sourceIndexedAt, ...portableManifest } = portable.manifest;
    const hasEmbeddings = portable.chunks.some((chunk) => Boolean(chunk.embedding?.length));
    const manifest: DocumentManifest = {
      ...portableManifest,
      id: documentId,
      owner: importOwner,
      revision: sourceRevision ?? `imported:${value.exportedAt}:v4`,
      embeddingStatus: hasEmbeddings ? "ready" : "unavailable",
      indexedAt: sourceIndexedAt ?? Date.now(),
      status: "indexed",
    };
    const pageRecords: PageRecord[] = portable.pages.map((page) => ({ ...page, id: `${documentId}:page:${page.pageNumber}`, owner: importOwner, documentId }));
    const chunkRecords: ChunkRecord[] = portable.chunks.map((chunk, index) => ({ ...chunk, id: `${documentId}:chunk:${index}`, owner: importOwner, documentId }));
    await replaceDocument({ manifest, pages: pageRecords, chunks: chunkRecords, stories: portable.stories ?? [] });
    signal?.throwIfAborted();
    if (activeOwner !== importOwner) throw new DOMException(localize("The wallet changed; RAG import stopped.", "Ví đã thay đổi; dừng nhập RAG."), "AbortError");
    imported += 1;
  }
  if (!imported) throw new Error(localize("The RAG backup contains no valid documents.", "Gói RAG không có tài liệu hợp lệ để nhập."));
  return imported;
}

/** JSON-equivalent footprint of the active wallet's persisted RAG, including vectors. */
export async function estimateActiveRagStorageBytes(): Promise<number> {
  if (!activeOwner) return 0;
  await ensureContentLoaded();
  const activeManifests = Array.from(manifests.values());
  const activePages = Array.from(pages.values());
  const activeChunks = Array.from(chunks.values());
  return new Blob([JSON.stringify({ manifests: activeManifests, pages: activePages, chunks: activeChunks, workspace })]).size;
}

async function keysForDocument(store: IDBObjectStore, documentId: string): Promise<IDBValidKey[]> {
  return requestValue(store.index("documentId").getAllKeys(documentId));
}

export async function replaceDocument(replacement: DocumentReplacement): Promise<void> {
  const commitOwner = replacement.manifest.owner.toLowerCase();
  if (!activeOwner || commitOwner !== activeOwner) throw new DOMException("Ví đã thay đổi; dừng commit index.", "AbortError");
  const previousWorkspace = workspace?.owner === commitOwner
    ? workspace
    : { id: commitOwner, owner: commitOwner, inventory: null, stories: [] } satisfies WorkspaceRecord;
  const nextWorkspace: WorkspaceRecord = {
    ...previousWorkspace,
    stories: [...previousWorkspace.stories.filter((story) => story.source !== replacement.manifest.source), ...replacement.stories],
  };
  const db = await openDatabase();
  if (activeOwner !== commitOwner) throw new DOMException("Ví đã thay đổi; dừng commit index.", "AbortError");
  if (db) {
    const transaction = db.transaction(["manifests", "pages", "chunks", "workspace"], "readwrite");
    const pageStore = transaction.objectStore("pages");
    const chunkStore = transaction.objectStore("chunks");
    const [oldPageKeys, oldChunkKeys] = await Promise.all([
      keysForDocument(pageStore, replacement.manifest.id),
      keysForDocument(chunkStore, replacement.manifest.id),
    ]);
    if (activeOwner !== commitOwner) {
      transaction.abort();
      throw new DOMException("Ví đã thay đổi; dừng commit index.", "AbortError");
    }
    oldPageKeys.forEach((key) => pageStore.delete(key));
    oldChunkKeys.forEach((key) => chunkStore.delete(key));
    replacement.pages.forEach((page) => pageStore.put(page));
    replacement.chunks.forEach((chunk) => chunkStore.put(chunk));
    transaction.objectStore("manifests").put(replacement.manifest);
    transaction.objectStore("workspace").put(nextWorkspace);
    await transactionDone(transaction);
  }
  if (activeOwner !== commitOwner) throw new DOMException("Ví đã thay đổi; index đã được lưu cho ví cũ nhưng không áp dụng vào phiên mới.", "AbortError");
  workspace = nextWorkspace;
  manifests.set(replacement.manifest.source, replacement.manifest);
  pages.clear();
  chunks.clear();
  contentLoaded = false;
  lexicalDb = null;
  emitRagState();
}

export async function updateUserDocumentMetadata(source: string, title: string, aliases: string[]) {
  const manifest = manifests.get(source);
  if (!manifest || !activeOwner) return;
  const expectedOwner = activeOwner;
  if (manifest.owner.toLowerCase() !== expectedOwner) return;
  const updated: DocumentManifest = {
    ...manifest,
    title: { value: title.trim(), confidence: 1, provenance: "user", userLocked: true },
    aliases: [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))],
    indexedAt: Date.now(),
  };
  const db = await openDatabase();
  if (activeOwner !== expectedOwner) throw new DOMException("Ví đã thay đổi; không áp dụng chỉnh sửa cũ.", "AbortError");
  if (db) {
    const transaction = db.transaction("manifests", "readwrite");
    transaction.objectStore("manifests").put(updated);
    await transactionDone(transaction);
  }
  if (activeOwner !== expectedOwner) return;
  manifests.set(source, updated);
  emitRagState();
}

export async function setShelbyBlobInventory(owner: string, names: string[], eligibleNames: string[] = names) {
  const inventoryOwner = owner.toLowerCase();
  await setActiveRagOwner(inventoryOwner);
  if (activeOwner !== inventoryOwner) throw new DOMException("Ví đã thay đổi; bỏ qua dữ liệu Shelby cũ.", "AbortError");
  const uniqueNames = [...new Set(names.filter(Boolean))];
  const uniqueEligibleNames = [...new Set(eligibleNames.filter(Boolean))];
  const eligible = new Set(uniqueEligibleNames);
  const removedManifests = Array.from(manifests.values()).filter((manifest) => !eligible.has(manifest.source));
  const removedDocumentIds = new Set(removedManifests.map((manifest) => manifest.id));
  const nextWorkspace: WorkspaceRecord = {
    id: inventoryOwner,
    owner: inventoryOwner,
    inventory: { names: uniqueNames, eligibleNames: uniqueEligibleNames, fetchedAt: Date.now(), verified: true },
    stories: (workspace?.stories ?? []).filter((story) => eligible.has(story.source)),
  };
  const db = await openDatabase();
  if (activeOwner !== inventoryOwner) throw new DOMException("Ví đã thay đổi; bỏ qua dữ liệu Shelby cũ.", "AbortError");
  if (db) {
    // Persist the new authority snapshot and remove derived evidence in one
    // transaction: export/search can never observe a new policy beside old data.
    const transaction = db.transaction(["manifests", "pages", "chunks", "workspace"], "readwrite");
    const pageStore = transaction.objectStore("pages");
    const chunkStore = transaction.objectStore("chunks");
    const derivedKeys = await Promise.all(removedManifests.map(async (manifest) => ({
      manifest,
      pageKeys: await keysForDocument(pageStore, manifest.id),
      chunkKeys: await keysForDocument(chunkStore, manifest.id),
    })));
    if (activeOwner !== inventoryOwner) {
      transaction.abort();
      throw new DOMException("Ví đã thay đổi; bỏ qua dữ liệu Shelby cũ.", "AbortError");
    }
    derivedKeys.forEach(({ manifest, pageKeys, chunkKeys }) => {
      pageKeys.forEach((key) => pageStore.delete(key));
      chunkKeys.forEach((key) => chunkStore.delete(key));
      transaction.objectStore("manifests").delete(manifest.id);
    });
    transaction.objectStore("workspace").put(nextWorkspace);
    await transactionDone(transaction);
  }
  if (activeOwner !== inventoryOwner) throw new DOMException("Ví đã thay đổi; dữ liệu cũ không được áp dụng vào phiên mới.", "AbortError");
  removedManifests.forEach((manifest) => manifests.delete(manifest.source));
  workspace = nextWorkspace;
  if (removedDocumentIds.size) {
    pages.clear();
    chunks.clear();
    contentLoaded = false;
    lexicalDb = null;
    queryEmbeddingCache.clear();
  }
  emitRagState();
}

/** Fail closed on an unverified policy refresh without deleting cached bytes. */
export async function invalidateShelbyBlobInventory(owner: string) {
  const inventoryOwner = owner.toLowerCase();
  await setActiveRagOwner(inventoryOwner);
  if (activeOwner !== inventoryOwner) return;
  const previous = workspace?.inventory;
  const nextWorkspace: WorkspaceRecord = {
    id: inventoryOwner,
    owner: inventoryOwner,
    inventory: {
      names: previous?.names ?? [],
      eligibleNames: previous?.eligibleNames ?? [],
      fetchedAt: previous?.fetchedAt ?? 0,
      verified: false,
    },
    stories: workspace?.stories ?? [],
  };
  const db = await openDatabase();
  if (activeOwner !== inventoryOwner) return;
  if (db) {
    const transaction = db.transaction("workspace", "readwrite");
    transaction.objectStore("workspace").put(nextWorkspace);
    await transactionDone(transaction);
  }
  if (activeOwner !== inventoryOwner) return;
  workspace = nextWorkspace;
  lexicalDb = null;
  queryEmbeddingCache.clear();
  emitRagState();
}

export function getShelbyBlobInventory() {
  return workspace?.inventory ? { owner: workspace.owner, ...workspace.inventory } : null;
}

export function extractStoryEntries(source: string, pageNumber: number, text: string): StoryEntry[] {
  const output: StoryEntry[] = [];
  const heading = /\b(\d{1,4})\s*[-.):]\s*([A-ZÀ-Ỵ][A-ZÀ-Ỵ\s,'’ -]{3,100})/g;
  let match: RegExpExecArray | null;
  while ((match = heading.exec(text))) {
    const number = Number(match[1]);
    const title = match[2].trim().replace(/\s+/g, " ");
    if (Number.isFinite(number) && /[A-Za-zÀ-ỹ]/.test(title)) output.push({ source, number, title, pageNumber });
  }
  return output;
}

export function getStoryEntries(source?: string): StoryEntry[] {
  return (workspace?.stories ?? [])
    .filter((entry) => isSourceEligibleInCurrentInventory(entry.source) && (!source || entry.source === source))
    .sort((a, b) => a.number - b.number);
}

function excerptAround(text: string, needle: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const normalized = normalizeSearchText(collapsed);
  const index = normalized.indexOf(normalizeSearchText(needle));
  const start = Math.max(0, index < 0 ? 0 : index - 140);
  return collapsed.slice(start, start + Math.max(needle.length + 280, 420)).trim();
}

function wordTokenSpans(text: string): Array<{ value: string; start: number; end: number }> {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: normalizeSearchText(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

const MAX_FUZZY_QUOTE_TOKENS = 64;
const MAX_FUZZY_PAGE_TOKENS = 50_000;

/** Finds the closest contiguous page span in O(query × page), not O(page × query²). */
function fuzzyTokenSpan(query: string[], page: Array<{ value: string; start: number; end: number }>): { score: number; start: number; end: number } | null {
  if (!query.length || !page.length) return null;
  const width = page.length + 1;
  let previous = new Uint16Array(width);
  let previousStarts = new Uint32Array(width);
  for (let column = 0; column < width; column += 1) previousStarts[column] = column;

  for (let row = 1; row <= query.length; row += 1) {
    const current = new Uint16Array(width);
    const currentStarts = new Uint32Array(width);
    current[0] = row;
    for (let column = 1; column < width; column += 1) {
      let distance = previous[column - 1] + (query[row - 1] === page[column - 1].value ? 0 : 1);
      let spanStart = previousStarts[column - 1];
      const insert = current[column - 1] + 1;
      if (insert < distance) {
        distance = insert;
        spanStart = currentStarts[column - 1];
      }
      const remove = previous[column] + 1;
      if (remove < distance) {
        distance = remove;
        spanStart = previousStarts[column];
      }
      current[column] = distance;
      currentStarts[column] = spanStart;
    }
    previous = current;
    previousStarts = currentStarts;
  }

  let bestColumn = 0;
  for (let column = 1; column < width; column += 1) {
    if (!bestColumn || previous[column] < previous[bestColumn]) bestColumn = column;
  }
  const tokenStart = previousStarts[bestColumn];
  if (!bestColumn || tokenStart >= bestColumn || tokenStart >= page.length) return null;
  const score = 1 - previous[bestColumn] / Math.max(query.length, bestColumn - tokenStart);
  if (score < 0.82) return null;
  return { score, start: page[tokenStart].start, end: page[bestColumn - 1].end };
}

function excerptAroundSpan(text: string, start: number, end: number): string {
  const excerptStart = Math.max(0, start - 140);
  const excerptEnd = Math.min(text.length, Math.max(end + 280, excerptStart + 420));
  return text.slice(excerptStart, excerptEnd).replace(/\s+/g, " ").trim();
}

export function findExactQuoteInPages(inputPages: PageRecord[], quote: string): RetrievalResult | null {
  const exactNeedle = normalizeSearchText(quote);
  if (!exactNeedle) return null;
  for (const page of inputPages) {
    if (page.normalizedText.includes(exactNeedle)) {
      return { method: "exact", documentId: page.documentId, source: page.source, displayName: page.displayName, pageNumber: page.pageNumber, totalPages: page.totalPages, excerpt: excerptAround(page.rawText, quote), score: 1 };
    }
  }
  const queryTokens = wordTokenSpans(quote).map((token) => token.value).filter((token) => token.length > 1);
  if (queryTokens.length < 3 || queryTokens.length > MAX_FUZZY_QUOTE_TOKENS) return null;
  let best: { page: PageRecord; score: number; start: number; end: number } | null = null;
  for (const page of inputPages) {
    const pageTokens = wordTokenSpans(page.rawText);
    if (pageTokens.length > MAX_FUZZY_PAGE_TOKENS) continue;
    const match = fuzzyTokenSpan(queryTokens, pageTokens);
    if (match && (!best || match.score > best.score)) best = { page, ...match };
  }
  if (!best) return null;
  return { method: "fuzzy", documentId: best.page.documentId, source: best.page.source, displayName: best.page.displayName, pageNumber: best.page.pageNumber, totalPages: best.page.totalPages, excerpt: excerptAroundSpan(best.page.rawText, best.start, best.end), score: best.score };
}

function withProvenance(result: RetrievalResult, manifest?: DocumentManifest, chunk?: ChunkRecord, page?: PageRecord): RetrievalResult {
  if (!manifest) return result;
  return {
    ...result,
    provenance: {
      owner: manifest.owner,
      accessTag: manifest.accessTag,
      blobId: manifest.blobId,
      blobMerkleRoot: manifest.blobMerkleRoot,
      blobSize: manifest.blobSize,
      blobCreatedAtMicros: manifest.blobCreatedAtMicros,
      indexedAt: manifest.indexedAt,
      sourceRevision: manifest.revision,
      chunkId: chunk?.id,
      mimeType: manifest.mimeType,
      pageContentHash: page?.contentHash,
      chunkContentHash: chunk?.contentHash,
      extractionMethod: page?.extractionMethod,
    },
  };
}

export async function lookupExactQuote(quote: string, signal?: AbortSignal): Promise<RetrievalResult | null> {
  signal?.throwIfAborted();
  await ensureContentLoaded();
  signal?.throwIfAborted();
  const indexedDocumentIds = new Set(Array.from(manifests.values()).filter(isSearchableManifest).map((manifest) => manifest.id));
  const result = findExactQuoteInPages(Array.from(pages.values()).filter((page) => indexedDocumentIds.has(page.documentId)), quote);
  if (!result) {
    const remoteResult = await (remoteRagProvider?.lookupExactQuote?.(quote, signal) ?? lookupRemoteExactQuote(quote, signal));
    return remoteResult && isSourceEligibleInCurrentInventory(remoteResult.source) ? remoteResult : null;
  }
  const manifest = Array.from(manifests.values()).find((item) => item.id === result.documentId);
  const page = pages.get(`${result.documentId}:page:${result.pageNumber}`);
  const pageChunks = Array.from(chunks.values()).filter((item) => item.documentId === result.documentId && item.pageNumber === result.pageNumber);
  const normalizedQuote = normalizeSearchText(quote);
  const chunk = pageChunks.find((item) => item.normalizedText.includes(normalizedQuote))
    ?? pageChunks.sort((a, b) => tokenCoverage(searchTokens(quote), b.text) - tokenCoverage(searchTokens(quote), a.text))[0];
  return withProvenance({ ...result, link: manifest?.blobUrl ? `${manifest.blobUrl}#page=${result.pageNumber}` : undefined }, manifest, chunk, page);
}

async function buildLexicalDb() {
  if (lexicalDb) return lexicalDb;
  lexicalDb = await create({ schema: { id: "string", text: "string", normalizedText: "string", source: "string", displayName: "string", type: "string", pageNumber: "number", totalPages: "number", imageUrl: "string" } });
  for (const chunk of chunks.values()) {
    const manifest = manifests.get(chunk.source);
    if (!manifest || !isSearchableManifest(manifest)) continue;
    await insert(lexicalDb, { id: chunk.id, text: chunk.text, normalizedText: chunk.normalizedText, source: chunk.source, displayName: chunk.displayName, type: chunk.type, pageNumber: chunk.pageNumber, totalPages: chunk.totalPages, imageUrl: chunk.imageUrl ?? "" });
  }
  return lexicalDb;
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aa += a[index] ** 2;
    bb += b[index] ** 2;
  }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb) || 1);
}

function searchTokens(value: string): string[] {
  const stopWords = new Set(["và", "là", "của", "cho", "trong", "một", "những", "các", "được", "về", "the", "and", "for", "with"]);
  return normalizeSearchText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function tokenCoverage(queryTokens: string[], text: string): number {
  if (!queryTokens.length) return 0;
  const documentTokens = new Set(searchTokens(text));
  return queryTokens.filter((token) => documentTokens.has(token)).length / queryTokens.length;
}

function tokenJaccard(a: string, b: string): number {
  const left = new Set(searchTokens(a));
  const right = new Set(searchTokens(b));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / (left.size + right.size - intersection);
}

async function cachedQueryEmbedding(query: string, provider: EmbeddingProvider, signal?: AbortSignal): Promise<number[]> {
  signal?.throwIfAborted();
  if (!getGeminiUsagePreferences().semanticSearch) throw new Error(localize("Semantic search is turned off in Settings.", "Tìm theo ý nghĩa đang tắt trong Cấu hình."));
  const key = `${provider}:${normalizeSearchText(query)}`;
  const cached = queryEmbeddingCache.get(key);
  if (cached) return cached;
  const [embedding] = await embedTexts([query], "query", undefined, provider, undefined, signal);
  signal?.throwIfAborted();
  if (!embedding) throw new Error(localize(`Could not create a query vector with ${provider}.`, `Không tạo được vector câu hỏi từ ${provider}.`));
  queryEmbeddingCache.set(key, embedding);
  if (queryEmbeddingCache.size > 24) queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value!);
  return embedding;
}

function remoteDocumentId(owner: string, source: string) {
  return `shelby:${owner.toLowerCase()}:${source}`;
}

function remotePageRecord(packageData: PortableRagPackage, documentId: string, pageNumber: number): PageRecord | undefined {
  for (const document of packageData.documents) {
    const owner = document.manifest.originalSourceOwner || packageData.sourceOwner;
    if (remoteDocumentId(owner, document.manifest.source) !== documentId) continue;
    const page = document.pages.find((candidate) => candidate.pageNumber === pageNumber);
    if (!page) return undefined;
    return { ...page, id: `${documentId}:page:${page.pageNumber}`, owner, documentId };
  }
  return undefined;
}

async function lookupRemoteExactQuote(quote: string, signal?: AbortSignal): Promise<RetrievalResult | null> {
  const packageData = await getRemoteRagPackage(signal);
  if (!packageData) return null;
  const normalizedQuote = normalizeSearchText(quote);
  for (const document of packageData.documents) {
    const owner = document.manifest.originalSourceOwner || packageData.sourceOwner;
    const documentId = remoteDocumentId(owner, document.manifest.source);
    for (const page of document.pages) {
      signal?.throwIfAborted();
      if (!page.normalizedText.includes(normalizedQuote)) continue;
      const chunkIndex = document.chunks.findIndex((chunk) => chunk.pageNumber === page.pageNumber && chunk.normalizedText.includes(normalizedQuote));
      const chunk = chunkIndex >= 0 ? document.chunks[chunkIndex] : undefined;
      const isPublic = document.manifest.accessTag === "public";
      return {
        method: "exact", documentId, source: document.manifest.source, displayName: document.manifest.displayName,
        pageNumber: page.pageNumber, totalPages: page.totalPages, excerpt: excerptAround(page.rawText, quote), score: 1,
        link: isPublic ? `${getShelbyBlobUrl(owner, document.manifest.source)}${page.pageNumber ? `#page=${page.pageNumber}` : ""}` : undefined,
        provenance: {
          owner, accessTag: document.manifest.accessTag, blobId: document.manifest.blobId,
          blobMerkleRoot: document.manifest.blobMerkleRoot, blobSize: document.manifest.blobSize,
          blobCreatedAtMicros: document.manifest.blobCreatedAtMicros,
          indexedAt: document.manifest.sourceIndexedAt ?? packageData.exportedAt,
          sourceRevision: document.manifest.sourceRevision ?? `remote:${packageData.exportedAt}`,
          chunkId: chunk ? `${documentId}:chunk:${chunkIndex}` : undefined,
          mimeType: document.manifest.mimeType, pageContentHash: page.contentHash,
          chunkContentHash: chunk?.contentHash, extractionMethod: page.extractionMethod,
        },
      };
    }
  }
  return null;
}

async function searchRemotePortablePackage(query: string, limit: number, signal?: AbortSignal, excludeSources = new Set<string>()): Promise<RetrievalResult[]> {
  const packageData = await getRemoteRagPackage(signal);
  if (!packageData) return [];
  const queryTokens = searchTokens(query);
  const normalizedQuery = normalizeSearchText(query);
  const providers = new Set<EmbeddingProvider>();
  for (const document of packageData.documents) {
    if (excludeSources.has(document.manifest.source)) continue;
    for (const chunk of document.chunks) if (chunk.embedding?.length) providers.add(chunk.embeddingProvider ?? "gemini");
  }
  const queryEmbeddings = new Map<EmbeddingProvider, number[]>();
  await Promise.all(Array.from(providers).map(async (provider) => {
    try {
      queryEmbeddings.set(provider, await cachedQueryEmbedding(query, provider, signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`Could not create a ${provider} query vector for the Shelby RAG backup; continuing with keyword search.`, error);
    }
  }));

  const candidates: Array<{ result: RetrievalResult; score: number }> = [];
  for (const document of packageData.documents) {
    if (excludeSources.has(document.manifest.source) || document.manifest.status !== "indexed") continue;
    const owner = document.manifest.originalSourceOwner || packageData.sourceOwner;
    const documentId = remoteDocumentId(owner, document.manifest.source);
    document.chunks.forEach((chunk, chunkIndex) => {
      const coverage = tokenCoverage(queryTokens, chunk.text);
      const exact = Boolean(normalizedQuery && chunk.normalizedText.includes(normalizedQuery));
      const provider = chunk.embeddingProvider ?? "gemini";
      const queryEmbedding = chunk.embedding?.length ? queryEmbeddings.get(provider) : undefined;
      const semantic = queryEmbedding && chunk.embedding ? cosine(queryEmbedding, chunk.embedding) : undefined;
      let score = coverage * 0.42 + (exact ? 0.85 : 0);
      if (semantic !== undefined) score += 0.5 * Math.max(0, (semantic - 0.2) / 0.8);
      if (score < 0.12) return;
      const page = document.pages.find((candidate) => candidate.pageNumber === chunk.pageNumber);
      const isPublic = document.manifest.accessTag === "public";
      candidates.push({
        score,
        result: {
          method: semantic !== undefined && (coverage > 0 || exact) ? "hybrid" : semantic !== undefined ? "semantic" : "lexical",
          documentId, source: document.manifest.source, displayName: document.manifest.displayName,
          pageNumber: chunk.pageNumber, totalPages: chunk.totalPages, excerpt: chunk.text, score,
          link: isPublic ? `${getShelbyBlobUrl(owner, document.manifest.source)}${chunk.pageNumber ? `#page=${chunk.pageNumber}` : ""}` : undefined,
          provenance: {
            owner, accessTag: document.manifest.accessTag, blobId: document.manifest.blobId,
            blobMerkleRoot: document.manifest.blobMerkleRoot, blobSize: document.manifest.blobSize,
            blobCreatedAtMicros: document.manifest.blobCreatedAtMicros,
            indexedAt: document.manifest.sourceIndexedAt ?? packageData.exportedAt,
            sourceRevision: document.manifest.sourceRevision ?? `remote:${packageData.exportedAt}`,
            chunkId: `${documentId}:chunk:${chunkIndex}`, mimeType: document.manifest.mimeType,
            pageContentHash: page?.contentHash, chunkContentHash: chunk.contentHash,
            extractionMethod: page?.extractionMethod,
          },
        },
      });
    });
  }
  const output: RetrievalResult[] = [];
  const byDocument = new Map<string, number>();
  for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
    if ((byDocument.get(candidate.result.documentId) ?? 0) >= 4) continue;
    if (output.some((item) => item.documentId === candidate.result.documentId && tokenJaccard(item.excerpt, candidate.result.excerpt) >= 0.86)) continue;
    output.push(candidate.result);
    byDocument.set(candidate.result.documentId, (byDocument.get(candidate.result.documentId) ?? 0) + 1);
    if (output.length >= limit) break;
  }
  return output;
}

export async function searchDocuments(query: string, limit = 8, signal?: AbortSignal): Promise<RetrievalResult[]> {
  signal?.throwIfAborted();
  await ensureContentLoaded();
  signal?.throwIfAborted();
  const db = await buildLexicalDb();
  signal?.throwIfAborted();
  const numericTerms = query.match(/\b\d{1,4}\b/g) ?? [];
  const lexicalResults = await Promise.all([...new Set([...numericTerms, query])].map((term) => search(db, { term, properties: ["text", "normalizedText"], limit: Math.max(limit * 2, 16), tolerance: term === query ? 1 : 0 })));
  signal?.throwIfAborted();
  const lexical = new Map<string, { score: number; rank: number }>();
  lexicalResults.forEach((result) => result.hits.forEach((hit: any, rank: number) => {
    const id = String(hit.document.id);
    const previous = lexical.get(id);
    const score = Number(hit.score ?? 0);
    if (!previous || rank < previous.rank || score > previous.score) lexical.set(id, { rank, score });
  }));

  const semantic = new Map<string, number>();
  const providers = new Set<EmbeddingProvider>();
  for (const chunk of chunks.values()) {
    const manifest = manifests.get(chunk.source);
    if (manifest && isSearchableManifest(manifest) && chunk.embedding?.length) providers.add(chunk.embeddingProvider ?? "gemini");
  }
  await Promise.all(Array.from(providers).map(async (provider) => {
    try {
      const queryEmbedding = await cachedQueryEmbedding(query, provider, signal);
      signal?.throwIfAborted();
      for (const chunk of chunks.values()) {
        const manifest = manifests.get(chunk.source);
        if (!manifest || !isSearchableManifest(manifest)) continue;
        if (!chunk.embedding?.length || (chunk.embeddingProvider ?? "gemini") !== provider) continue;
        semantic.set(chunk.id, Math.max(semantic.get(chunk.id) ?? -1, cosine(queryEmbedding, chunk.embedding)));
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`${provider} query vectors unavailable; continuing with keyword search.`, error);
    }
  }));
  signal?.throwIfAborted();

  const scores = new Map<string, number>();
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = searchTokens(query);
  const maxLexicalScore = Math.max(1, ...Array.from(lexical.values()).map((item) => item.score));
  for (const chunk of chunks.values()) {
    const manifest = manifests.get(chunk.source);
    if (!manifest || !isSearchableManifest(manifest)) continue;
    const lexicalHit = lexical.get(chunk.id);
    const semanticScore = semantic.get(chunk.id);
    let score = lexicalHit ? 0.36 * (lexicalHit.score / maxLexicalScore) + 0.12 / (1 + lexicalHit.rank) : 0;
    if (semanticScore !== undefined) score += 0.46 * Math.max(0, (semanticScore - 0.2) / 0.8);
    score += 0.2 * tokenCoverage(queryTokens, chunk.text);
    if (chunk.normalizedText.includes(normalizedQuery)) score += 0.85;
    if ([manifest?.title?.value, ...(manifest?.aliases ?? [])].some((value) => value && normalizedQuery.includes(normalizeSearchText(value)))) score += 0.22;
    if (score > 0.03) scores.set(chunk.id, score);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const selected: Array<[string, number]> = [];
  const byDocument = new Map<string, number>();
  const byPage = new Map<string, number>();
  const minimumScore = Math.max(0.16, (ranked[0]?.[1] ?? 0) * 0.22);
  for (const candidate of ranked) {
    if (candidate[1] < minimumScore) break;
    const chunk = chunks.get(candidate[0]);
    if (!chunk) continue;
    const pageKey = `${chunk.documentId}:${chunk.pageNumber}`;
    if ((byDocument.get(chunk.documentId) ?? 0) >= 4 || (byPage.get(pageKey) ?? 0) >= 2) continue;
    const isNearDuplicate = selected.some(([selectedId]) => {
      const previous = chunks.get(selectedId);
      return previous?.documentId === chunk.documentId && tokenJaccard(previous.text, chunk.text) >= 0.86;
    });
    if (isNearDuplicate) continue;
    selected.push(candidate);
    byDocument.set(chunk.documentId, (byDocument.get(chunk.documentId) ?? 0) + 1);
    byPage.set(pageKey, (byPage.get(pageKey) ?? 0) + 1);
    if (selected.length >= limit) break;
  }

  const localResults = selected.flatMap(([id, score]) => {
    const chunk = chunks.get(id);
    const manifest = chunk ? manifests.get(chunk.source) : undefined;
    if (!chunk) return [];

    // Resolve permanent Shelby URL if blob is public, fallback to chunk's stored image URL
    let imageUrl = chunk.imageUrl;
    if (chunk.type === "image" && manifest && manifest.accessTag === "public" && activeOwner) {
      imageUrl = getShelbyBlobUrl(activeOwner, chunk.source);
    }

    const page = pages.get(`${chunk.documentId}:page:${chunk.pageNumber}`);
    return [withProvenance({ method: lexical.has(id) && semantic.has(id) ? "hybrid" as const : semantic.has(id) ? "semantic" as const : "lexical" as const, documentId: chunk.documentId, source: chunk.source, displayName: chunk.displayName, pageNumber: chunk.pageNumber, totalPages: chunk.totalPages, excerpt: chunk.text, score, imageUrl, link: manifest?.blobUrl ? `${manifest.blobUrl}${chunk.pageNumber ? `#page=${chunk.pageNumber}` : ""}` : undefined }, manifest, chunk, page)];
  });
  const indexedLocalSources = new Set(Array.from(manifests.values()).filter(isSearchableManifest).map((manifest) => manifest.source));
  // A full local result list may still contain weak matches. Always give the
  // Shelby snapshot the same retrieval budget, then rank both pools together.
  let remoteResults: RetrievalResult[] = [];
  try {
    remoteResults = remoteRagProvider?.search
      ? await remoteRagProvider.search(query, limit, signal, indexedLocalSources)
      : await searchRemotePortablePackage(query, limit, signal, indexedLocalSources);
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    if (!localResults.length) throw error;
    console.warn("Could not read the Shelby RAG backup; continuing with on-device data.", error);
  }
  signal?.throwIfAborted();
  const deduplicated = new Map<string, RetrievalResult>();
  for (const result of [...localResults, ...remoteResults.filter((item) => isSourceEligibleInCurrentInventory(item.source))]) {
    const key = result.provenance?.chunkContentHash
      ?? result.provenance?.chunkId
      ?? `${result.source}:${result.pageNumber}:${normalizeSearchText(result.excerpt).slice(0, 160)}`;
    const previous = deduplicated.get(key);
    if (!previous || result.score > previous.score) deduplicated.set(key, result);
  }
  return [...deduplicated.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

export function getImageUrls(): { source: string; url: string }[] {
  return Array.from(manifests.values())
    .filter((manifest) => manifest.type === "image" && isSearchableManifest(manifest))
    .map((manifest) => {
      const url = (manifest.accessTag === "public" && activeOwner)
        ? getShelbyBlobUrl(activeOwner, manifest.source)
        : manifest.blobUrl;
      return { source: manifest.source, url: url || "" };
    })
    .filter((item) => Boolean(item.url));
}

export interface ImageDocument {
  owner: string;
  source: string;
  displayName: string;
  url: string;
  revision: string;
  description?: string;
}

export async function getImageDocuments(): Promise<ImageDocument[]> {
  await ensureContentLoaded();
  return Array.from(manifests.values())
    .filter((manifest) => manifest.type === "image" && isSearchableManifest(manifest))
    .map((manifest) => {
      const chunk = Array.from(chunks.values()).find((item) => item.documentId === manifest.id && item.type === "image");
      const text = chunk?.text ?? "";
      const description = text.match(/(?:AI description|Mô tả AI):\s*([\s\S]+)/i)?.[1]?.trim();
      const url = (manifest.accessTag === "public" && activeOwner)
        ? getShelbyBlobUrl(activeOwner, manifest.source)
        : manifest.blobUrl;
      return { owner: manifest.owner, source: manifest.source, displayName: manifest.displayName, url: url || "", revision: manifest.revision, description };
    })
    .filter((item) => Boolean(item.url));
}

export async function updateImageDescription(source: string, description: string) {
  await ensureContentLoaded();
  const updateOwner = activeOwner;
  if (!updateOwner) return;
  const manifest = manifests.get(source);
  if (!manifest || manifest.owner !== updateOwner || !isSearchableManifest(manifest)) return;
  const existing = manifest && Array.from(chunks.values()).find((chunk) => chunk.documentId === manifest.id && chunk.type === "image");
  if (!existing) return;
  const text = `[Image]\nFile name: ${manifest.displayName}\n\nAI description: ${description.trim()}`;
  const normalizedText = normalizeSearchText(text);
  const updated: ChunkRecord = {
    ...existing,
    text,
    normalizedText,
    contentHash: await sha256Text(normalizedText),
    embedding: undefined,
    embeddingProvider: undefined,
  };
  const updatedManifest: DocumentManifest = {
    ...manifest,
    indexedAt: Date.now(),
    embeddingStatus: "unavailable",
    embeddingProvider: undefined,
  };
  if (activeOwner !== updateOwner) throw new DOMException(localize("The wallet changed; image update stopped.", "Ví đã thay đổi; dừng cập nhật ảnh."), "AbortError");
  const db = await openDatabase();
  if (activeOwner !== updateOwner) throw new DOMException(localize("The wallet changed; image update stopped.", "Ví đã thay đổi; dừng cập nhật ảnh."), "AbortError");
  if (db) {
    const transaction = db.transaction(["chunks", "manifests"], "readwrite");
    transaction.objectStore("chunks").put(updated);
    transaction.objectStore("manifests").put(updatedManifest);
    await transactionDone(transaction);
  }
  if (activeOwner !== updateOwner) throw new DOMException(localize(
    "The wallet changed; the description was saved for the previous wallet and was not applied here.",
    "Ví đã thay đổi; mô tả được lưu cho ví cũ nhưng không áp dụng vào phiên mới.",
  ), "AbortError");
  chunks.set(updated.id, updated);
  manifests.set(updatedManifest.source, updatedManifest);
  lexicalDb = null;
  queryEmbeddingCache.clear();
  emitRagState();
}

type RagSourceFailureInput = Omit<RagSource, "status" | "chunks" | "indexedAt" | "aliases" | "authors" | "ocrCoverage" | "embeddingStatus" | "revision"> & { revision?: string };

export async function recordSourceFailure(source: RagSourceFailureInput, error: unknown, expectedOwner?: string) {
  if (!activeOwner) return;
  const failureOwner = (expectedOwner ?? activeOwner).toLowerCase();
  if (activeOwner !== failureOwner) return;
  const message = error instanceof Error ? error.message : String(error);
  const previous = manifests.get(source.source);
  if (previous) {
    const updated = {
      ...previous,
      revision: source.revision ?? previous.revision,
      status: "failed" as const,
      error: localize(`Latest processing attempt failed: ${message}`, `Lần nạp gần nhất lỗi: ${message}`),
      indexedAt: Date.now(),
    };
    const db = await openDatabase();
    if (db) { const tx = db.transaction("manifests", "readwrite"); tx.objectStore("manifests").put(updated); await transactionDone(tx); }
    if (activeOwner !== failureOwner) return;
    manifests.set(source.source, updated);
    lexicalDb = null;
    emitRagState();
    return;
  }
  const manifest: DocumentManifest = { id: `${failureOwner}:${source.source}`, owner: failureOwner, source: source.source, displayName: source.displayName, revision: source.revision ?? "failed", blobUrl: source.blobUrl, mimeType: source.type === "image" ? "image/*" : source.type === "video" ? "video/mp4" : "application/octet-stream", type: source.type, aliases: [], authors: [], pageCount: 0, chunkCount: 0, ocrCoverage: 0, embeddingStatus: "unavailable", status: "failed", indexedAt: Date.now(), error: message };
  const db = await openDatabase();
  if (db) { const tx = db.transaction("manifests", "readwrite"); tx.objectStore("manifests").put(manifest); await transactionDone(tx); }
  if (activeOwner !== failureOwner) return;
  manifests.set(source.source, manifest);
  emitRagState();
}

export async function recordSourceSkipped(source: RagSourceFailureInput, reason: string, expectedOwner?: string) {
  const skipOwner = (expectedOwner ?? activeOwner)?.toLowerCase();
  if (!skipOwner) return;
  await recordSourceFailure(source, reason, expectedOwner);
  if (activeOwner !== skipOwner) return;
  const manifest = manifests.get(source.source);
  if (manifest) {
    const updated = { ...manifest, status: "skipped" as const };
    const db = await openDatabase();
    if (db) { const tx = db.transaction("manifests", "readwrite"); tx.objectStore("manifests").put(updated); await transactionDone(tx); }
    if (activeOwner !== skipOwner) return;
    manifests.set(source.source, updated);
    emitRagState();
  }
}

export async function resetRagSource(source: string) {
  const resetOwner = activeOwner;
  if (!resetOwner) return;
  const manifest = manifests.get(source);
  if (!manifest || manifest.owner !== resetOwner) return;
  const db = await openDatabase();
  if (db) {
    const tx = db.transaction(["manifests", "pages", "chunks"], "readwrite");
    const pageStore = tx.objectStore("pages");
    const chunkStore = tx.objectStore("chunks");
    (await keysForDocument(pageStore, manifest.id)).forEach((key) => pageStore.delete(key));
    (await keysForDocument(chunkStore, manifest.id)).forEach((key) => chunkStore.delete(key));
    tx.objectStore("manifests").delete(manifest.id);
    await transactionDone(tx);
  }
  if (activeOwner !== resetOwner) return;
  manifests.delete(source);
  pages.clear();
  chunks.clear();
  contentLoaded = false;
  lexicalDb = null;
  emitRagState();
}

/**
 * Removes only the active wallet's browser-side RAG state. Shelby blobs and
 * every other wallet's workspace are intentionally untouched.
 */
export async function clearActiveRagWorkspace(expectedOwner = activeOwner) {
  if (!expectedOwner || activeOwner !== expectedOwner) return false;
  const owner = expectedOwner;
  const db = await openDatabase();
  if (db) {
    const transaction = db.transaction(["manifests", "pages", "chunks", "workspace"], "readwrite");
    const deleteOwnerRecords = async (storeName: "manifests" | "pages" | "chunks") => {
      const store = transaction.objectStore(storeName);
      const keys = await requestValue(store.index("owner").getAllKeys(owner));
      keys.forEach((key) => store.delete(key));
    };
    await Promise.all([deleteOwnerRecords("manifests"), deleteOwnerRecords("pages"), deleteOwnerRecords("chunks")]);
    transaction.objectStore("workspace").delete(owner);
    await transactionDone(transaction);
  }
  if (activeOwner !== owner) return false;
  manifests.clear();
  pages.clear();
  chunks.clear();
  workspace = null;
  lexicalDb = null;
  contentLoaded = false;
  emitRagState();
  return true;
}

/** Releases hydrated page/chunk/BM25 data while keeping IndexedDB intact. */
export function ejectRagRuntime() {
  pages.clear();
  chunks.clear();
  lexicalDb = null;
  queryEmbeddingCache.clear();
  contentLoaded = false;
}

export function getPageRecord(documentId: string, pageNumber: number): PageRecord | undefined {
  const localPage = pages.get(`${documentId}:page:${pageNumber}`);
  if (localPage && isSourceEligibleInCurrentInventory(localPage.source)) return localPage;
  const remotePage = remoteRagProvider?.getPageRecord?.(documentId, pageNumber)
    ?? (remoteRagCache ? remotePageRecord(remoteRagCache.packageData, documentId, pageNumber) : undefined);
  return remotePage && isSourceEligibleInCurrentInventory(remotePage.source) ? remotePage : undefined;
}

export async function flushVectorDB() { /* v4 writes are transactionally flushed. */ }
