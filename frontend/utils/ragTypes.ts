export type MetadataProvenance = "user" | "cloud_vision" | "local_ocr" | "pdf_metadata" | "filename" | "heuristic";

export interface MetadataValue {
  value: string;
  confidence: number;
  provenance: MetadataProvenance;
  userLocked: boolean;
}

export type DocumentStatus = "indexed" | "failed" | "skipped" | "upgrade_required";

export interface DocumentManifest {
  id: string;
  owner: string;
  source: string;
  displayName: string;
  revision: string;
  blobUrl?: string;
  /** Shelby registration data retained for answer provenance. */
  blobId?: string;
  blobMerkleRoot?: string;
  blobSize?: number;
  blobCreatedAtMicros?: number;
  /** Access class at ingestion; restricted source URLs are never persisted. */
  accessTag?: "public" | "allowlist" | "purchasable" | "time_lock";
  mimeType: string;
  type: "text" | "image" | "video";
  title?: MetadataValue;
  aliases: string[];
  authors: string[];
  pageCount: number;
  chunkCount: number;
  ocrCoverage: number;
  /** Pages with usable extracted/OCR text, divided by page count. */
  textCoverage?: number;
  embeddingStatus: "ready" | "unavailable" | "failed";
  embeddingProvider?: "gemini" | "gateway";
  status: DocumentStatus;
  indexedAt: number;
  error?: string;
}

export interface PageRecord {
  id: string;
  owner: string;
  documentId: string;
  source: string;
  displayName: string;
  pageNumber: number;
  totalPages: number;
  rawText: string;
  normalizedText: string;
  /** SHA-256 of normalized extracted text; this is not the Shelby blob root. */
  contentHash?: string;
  extractionMethod: "text_layer" | "local_ocr" | "cloud_vision" | "cloud_video" | "mixed";
}

export interface ChunkRecord {
  id: string;
  owner: string;
  documentId: string;
  source: string;
  displayName: string;
  type: "text" | "image" | "video";
  text: string;
  normalizedText: string;
  /** SHA-256 of normalized chunk text. */
  contentHash?: string;
  pageNumber: number;
  totalPages: number;
  heading?: string;
  imageUrl?: string;
  embedding?: number[];
  embeddingProvider?: "gemini" | "gateway";
}

export interface RetrievalResult {
  method: "exact" | "fuzzy" | "lexical" | "semantic" | "hybrid";
  documentId: string;
  source: string;
  displayName: string;
  pageNumber: number;
  totalPages: number;
  excerpt: string;
  score: number;
  /** Stable evidence label supplied to the model, for example S1. */
  citationId?: string;
  link?: string;
  imageUrl?: string;
  provenance?: {
    owner: string;
    accessTag?: DocumentManifest["accessTag"];
    blobId?: string;
    blobMerkleRoot?: string;
    blobSize?: number;
    blobCreatedAtMicros?: number;
    indexedAt: number;
    sourceRevision: string;
    chunkId?: string;
    mimeType?: string;
    pageContentHash?: string;
    chunkContentHash?: string;
    extractionMethod?: PageRecord["extractionMethod"];
    /** Where this evidence was read from for the current answer. */
    storageMode?: "local" | "shelby_hot";
    /** Hot RAG part selected from the lightweight Shelby manifest. */
    shardName?: string;
    /** Network bytes fetched for this retrieval pass (cache hits report zero). */
    bytesRead?: number;
  };
}

export type AnswerVerificationLevel = "content_verified" | "source_verified" | "indexed_only" | "failed";

export interface AnswerReceiptSource {
  citationId: string;
  source: string;
  displayName: string;
  pageNumber: number;
  excerpt: string;
  level: AnswerVerificationLevel;
  explanation: string;
  checkedAt: number;
  indexedBlobMerkleRoot?: string;
  currentBlobMerkleRoot?: string;
  recomputedBlobMerkleRoot?: string;
  pageContentHash?: string;
  chunkContentHash?: string;
}

export interface AnswerReceipt {
  format: "shelby-answer-receipt";
  version: 1;
  id: string;
  createdAt: number;
  wallet: string;
  question: string;
  answer: string;
  level: AnswerVerificationLevel;
  sources: AnswerReceiptSource[];
  note: string;
}

export interface StoryEntry {
  source: string;
  number: number;
  title: string;
  pageNumber: number;
}

export interface DocumentReplacement {
  manifest: DocumentManifest;
  pages: PageRecord[];
  chunks: ChunkRecord[];
  stories: StoryEntry[];
}

export interface PortableRagDocument {
  manifest: Omit<DocumentManifest, "owner" | "id" | "revision" | "embeddingStatus" | "indexedAt"> & {
    originalSourceOwner: string;
    /** Source blob revision retained so another browser can detect genuinely new blobs. */
    sourceRevision?: string;
    /** Original local commit time; prevents a restore from looking newer than its Shelby snapshot. */
    sourceIndexedAt?: number;
  };
  pages: Omit<PageRecord, "owner" | "id" | "documentId">[];
  /** Embeddings are optional so a Shelby snapshot can serve semantic search without a local rebuild. */
  chunks: Omit<ChunkRecord, "owner" | "id" | "documentId">[];
  stories: StoryEntry[];
}

/** A portable, unencrypted RAG backup. New snapshots may include embeddings for hot retrieval. */
export interface PortableRagPackage {
  format: "shelby-rag-package";
  version: 1;
  exportedAt: number;
  sourceOwner: string;
  /** Shelby inventory observed when this snapshot was created. */
  inventory?: { names: string[]; fetchedAt: number };
  documents: PortableRagDocument[];
}
