import { AccountAddress } from "@aptos-labs/ts-sdk";
import { BlobNameSchema, generateCommitments } from "@shelby-protocol/sdk/browser";
import { blobClient, getShelbyBlobUrl } from "@/utils/shelbyConfig";
import { getErasureProvider } from "@/utils/shelbyErasure";
import { normalizeHex, sha256Text } from "@/utils/contentIntegrity";
import { extractSinglePageFromUrl, normalizeSearchText } from "@/utils/textExtractor";
import type { AnswerReceipt, AnswerReceiptSource, AnswerVerificationLevel, RetrievalResult } from "@/utils/ragTypes";
import { localize } from "@/i18n";

const MAX_VERIFY_BYTES = 25 * 1024 * 1024;
const RECEIPT_ENVELOPE_FORMAT = "shelby-answer-receipt-envelope" as const;
const RECEIPT_ENVELOPE_VERSION = 2 as const;
const RECEIPT_CANONICALIZATION = "shelby-c14n-json-v1" as const;
const SHA256_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;
const CITATION_PATTERN = /^S[1-9]\d*$/i;
const RECEIPT_LEVELS = new Set<AnswerVerificationLevel>(["content_verified", "source_verified", "indexed_only", "failed"]);
const EXTRACTION_METHODS = new Set(["text_layer", "local_ocr", "cloud_vision", "cloud_video", "mixed"]);
const VERIFICATION_SCOPES = new Set<ReceiptVerificationScope>([
  "text_layer_excerpt_reproduced_at_creation",
  "source_bytes_only_ocr_not_independently_verified",
  "source_bytes_verified_at_creation",
  "index_record_only",
  "verification_failed",
]);

type ReceiptExtractionMethod = NonNullable<NonNullable<RetrievalResult["provenance"]>["extractionMethod"]>;
type ReceiptSourceWithContext = AnswerReceiptSource & { extractionMethod?: ReceiptExtractionMethod };

function boundedSourceStream(body: ReadableStream<Uint8Array>, expectedBytes: number, signal?: AbortSignal) {
  const reader = body.getReader();
  let bytesRead = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        bytesRead += result.value.byteLength;
        if (bytesRead > expectedBytes || bytesRead > MAX_VERIFY_BYTES) {
          await reader.cancel("Source exceeded its registered size");
          controller.error(new Error(localize(
            "The downloaded data is larger than the size registered on Shelby.",
            "Dữ liệu tải về lớn hơn kích thước đã đăng ký trên Shelby.",
          )));
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, bytesRead: () => bytesRead };
}

export type ReceiptVerificationScope =
  | "text_layer_excerpt_reproduced_at_creation"
  | "source_bytes_only_ocr_not_independently_verified"
  | "source_bytes_verified_at_creation"
  | "index_record_only"
  | "verification_failed";

export interface AnswerReceiptCitationIntegrity {
  citationId: string;
  source: string;
  pageNumber: number;
  /** SHA-256 of normalizeSearchText(excerpt), which can be recomputed offline. */
  excerptNormalization: "nfc-lowercase-vi-whitespace-v1";
  excerptSha256: string;
  /** Binds the citation ID and location to excerptSha256. This is an integrity checksum, not a signature. */
  citationSha256: string;
  indexedPageContentSha256?: string;
  indexedChunkContentSha256?: string;
  extractionMethod?: ReceiptExtractionMethod;
  verificationScope: ReceiptVerificationScope;
}

export interface AnswerReceiptEnvelopeV2 {
  format: typeof RECEIPT_ENVELOPE_FORMAT;
  version: typeof RECEIPT_ENVELOPE_VERSION;
  payload: {
    receipt: AnswerReceipt;
    citations: AnswerReceiptCitationIntegrity[];
  };
  integrity: {
    algorithm: "SHA-256";
    canonicalization: typeof RECEIPT_CANONICALIZATION;
    scope: "payload";
    digest: string;
  };
}

export type ReceiptCheckStatus = "pass" | "fail" | "unavailable" | "declared_only";

export interface AnswerReceiptVerificationReport {
  /** True when every check that can make the artifact invalid passes. */
  valid: boolean;
  /** True only for a v2 envelope whose canonical payload digest matches. */
  integrityVerified: boolean;
  /** Always false until the format gains a trusted digital signature. */
  authenticated: false;
  compatible: boolean;
  inputVersion?: 1 | 2;
  receipt?: AnswerReceipt;
  checks: {
    schema: ReceiptCheckStatus;
    receiptId: ReceiptCheckStatus;
    envelopeDigest: ReceiptCheckStatus;
    citations: ReceiptCheckStatus;
    excerptHashes: ReceiptCheckStatus;
    declaredContentHashes: ReceiptCheckStatus;
    evidenceScope: ReceiptCheckStatus;
    sourceBytes: "unavailable";
    authenticity: "unavailable";
  };
  errors: string[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic JSON for this receipt format. Keys are sorted recursively and
 * non-JSON/ambiguous values are rejected. This is intentionally named as an
 * app-local scheme rather than claiming RFC 8785 compatibility.
 */
export function canonicalizeAnswerReceiptValue(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (candidate: unknown, path: string): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new TypeError(`${path} chứa số không hợp lệ.`);
      return JSON.stringify(Object.is(candidate, -0) ? 0 : candidate);
    }
    if (typeof candidate !== "object") throw new TypeError(`${path} không phải dữ liệu JSON hợp lệ.`);
    if (ancestors.has(candidate)) throw new TypeError(`${path} chứa tham chiếu vòng.`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) return `[${candidate.map((item, index) => encode(item, `${path}[${index}]`)).join(",")}]`;
      const record = candidate as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => {
        if (record[key] === undefined) throw new TypeError(`${path}.${key} không được để undefined.`);
        return `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`)}`;
      }).join(",")}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return encode(value, "receipt");
}

function normalizeSha256(value: string): string {
  return `0x${value.replace(/^0x/i, "").toLowerCase()}`;
}

/** Recomputes the legacy v1 receipt checksum. It is not a signature. */
export async function computeAnswerReceiptId(receipt: AnswerReceipt | Omit<AnswerReceipt, "id">): Promise<string> {
  const payload = {
    format: receipt.format,
    version: receipt.version,
    createdAt: receipt.createdAt,
    wallet: receipt.wallet,
    question: receipt.question,
    answer: receipt.answer,
    level: receipt.level,
    sources: receipt.sources,
    note: receipt.note,
  };
  return sha256Text(JSON.stringify(payload));
}

function verificationScope(source: ReceiptSourceWithContext): ReceiptVerificationScope {
  if (source.level === "failed") return "verification_failed";
  if (source.level === "indexed_only") return "index_record_only";
  if (source.extractionMethod === "local_ocr" || source.extractionMethod === "cloud_vision" || source.extractionMethod === "cloud_video" || source.extractionMethod === "mixed") {
    return "source_bytes_only_ocr_not_independently_verified";
  }
  if (source.level === "content_verified" && source.extractionMethod === "text_layer") return "text_layer_excerpt_reproduced_at_creation";
  return "source_bytes_verified_at_creation";
}

async function citationIntegrity(source: ReceiptSourceWithContext): Promise<AnswerReceiptCitationIntegrity> {
  const excerptSha256 = await sha256Text(normalizeSearchText(source.excerpt));
  const citationSha256 = await sha256Text(canonicalizeAnswerReceiptValue({
    citationId: source.citationId.toUpperCase(),
    excerptSha256,
    pageNumber: source.pageNumber,
    source: source.source,
  }));
  return {
    citationId: source.citationId.toUpperCase(),
    source: source.source,
    pageNumber: source.pageNumber,
    excerptNormalization: "nfc-lowercase-vi-whitespace-v1",
    excerptSha256,
    citationSha256,
    ...(source.pageContentHash && SHA256_PATTERN.test(source.pageContentHash) ? { indexedPageContentSha256: normalizeSha256(source.pageContentHash) } : {}),
    ...(source.chunkContentHash && SHA256_PATTERN.test(source.chunkContentHash) ? { indexedChunkContentSha256: normalizeSha256(source.chunkContentHash) } : {}),
    ...(source.extractionMethod ? { extractionMethod: source.extractionMethod } : {}),
    verificationScope: verificationScope(source),
  };
}

function validateReceiptSchema(value: unknown, errors: string[]): value is AnswerReceipt {
  if (!isRecord(value)) {
    errors.push("Receipt phải là một JSON object.");
    return false;
  }
  if (value.format !== "shelby-answer-receipt") errors.push("Receipt format không được hỗ trợ.");
  if (value.version !== 1) errors.push("Receipt version không được hỗ trợ.");
  if (typeof value.id !== "string" || !SHA256_PATTERN.test(value.id)) errors.push("Mã receipt phải là SHA-256 hợp lệ.");
  if (!Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0) errors.push("createdAt không hợp lệ.");
  for (const field of ["wallet", "question", "answer", "note"] as const) {
    if (typeof value[field] !== "string") errors.push(`${field} phải là chuỗi.`);
  }
  if (typeof value.level !== "string" || !RECEIPT_LEVELS.has(value.level as AnswerVerificationLevel)) errors.push("Mức xác minh của receipt không hợp lệ.");
  if (!Array.isArray(value.sources)) {
    errors.push("sources phải là một mảng.");
    return false;
  }
  value.sources.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      errors.push(`Nguồn ${index + 1} không hợp lệ.`);
      return;
    }
    for (const field of ["citationId", "source", "displayName", "excerpt", "explanation"] as const) {
      if (typeof candidate[field] !== "string") errors.push(`Nguồn ${index + 1}: ${field} phải là chuỗi.`);
    }
    if (!Number.isSafeInteger(candidate.pageNumber) || Number(candidate.pageNumber) < 0) errors.push(`Nguồn ${index + 1}: pageNumber không hợp lệ.`);
    if (!Number.isSafeInteger(candidate.checkedAt) || Number(candidate.checkedAt) < 0) errors.push(`Nguồn ${index + 1}: checkedAt không hợp lệ.`);
    if (typeof candidate.level !== "string" || !RECEIPT_LEVELS.has(candidate.level as AnswerVerificationLevel)) errors.push(`Nguồn ${index + 1}: level không hợp lệ.`);
    for (const field of ["indexedBlobMerkleRoot", "currentBlobMerkleRoot", "recomputedBlobMerkleRoot", "pageContentHash", "chunkContentHash"] as const) {
      if (candidate[field] !== undefined && typeof candidate[field] !== "string") errors.push(`Nguồn ${index + 1}: ${field} phải là chuỗi.`);
    }
    if (candidate.extractionMethod !== undefined && (typeof candidate.extractionMethod !== "string" || !EXTRACTION_METHODS.has(candidate.extractionMethod))) {
      errors.push(`Nguồn ${index + 1}: extractionMethod không hợp lệ.`);
    }
  });
  return errors.length === 0;
}

function validateCitationIntegritySchema(value: unknown, index: number, errors: string[]): value is AnswerReceiptCitationIntegrity {
  if (!isRecord(value)) {
    errors.push(`Citation integrity ${index + 1} không hợp lệ.`);
    return false;
  }
  if (typeof value.citationId !== "string" || !CITATION_PATTERN.test(value.citationId)) errors.push(`Citation integrity ${index + 1}: citationId không hợp lệ.`);
  if (typeof value.source !== "string") errors.push(`Citation integrity ${index + 1}: source phải là chuỗi.`);
  if (!Number.isSafeInteger(value.pageNumber) || Number(value.pageNumber) < 0) errors.push(`Citation integrity ${index + 1}: pageNumber không hợp lệ.`);
  if (value.excerptNormalization !== "nfc-lowercase-vi-whitespace-v1") errors.push(`Citation integrity ${index + 1}: excerptNormalization không hợp lệ.`);
  for (const field of ["excerptSha256", "citationSha256", "indexedPageContentSha256", "indexedChunkContentSha256"] as const) {
    if ((field === "excerptSha256" || field === "citationSha256" || value[field] !== undefined) && (typeof value[field] !== "string" || !SHA256_PATTERN.test(value[field] as string))) {
      errors.push(`Citation integrity ${index + 1}: ${field} không phải SHA-256 hợp lệ.`);
    }
  }
  if (value.extractionMethod !== undefined && (typeof value.extractionMethod !== "string" || !EXTRACTION_METHODS.has(value.extractionMethod))) {
    errors.push(`Citation integrity ${index + 1}: extractionMethod không hợp lệ.`);
  }
  if (typeof value.verificationScope !== "string" || !VERIFICATION_SCOPES.has(value.verificationScope as ReceiptVerificationScope)) {
    errors.push(`Citation integrity ${index + 1}: verificationScope không hợp lệ.`);
  }
  return errors.length === 0;
}

function checkReceiptSemantics(receipt: AnswerReceipt, errors: string[], warnings: string[]) {
  const sourceMap = new Map<string, ReceiptSourceWithContext>();
  for (const [index, rawSource] of receipt.sources.entries()) {
    const source = rawSource as ReceiptSourceWithContext;
    const citationId = source.citationId.toUpperCase();
    if (!CITATION_PATTERN.test(citationId)) errors.push(`Nguồn ${index + 1} có mã trích dẫn không hợp lệ.`);
    if (sourceMap.has(citationId)) errors.push(`Mã trích dẫn ${citationId} bị lặp.`);
    sourceMap.set(citationId, source);
    for (const [label, value] of [
      ["mã tệp đã index", source.indexedBlobMerkleRoot],
      ["mã tệp hiện tại", source.currentBlobMerkleRoot],
      ["mã tệp tính lại", source.recomputedBlobMerkleRoot],
      ["pageContentHash", source.pageContentHash],
      ["chunkContentHash", source.chunkContentHash],
    ] as const) {
      if (value && !SHA256_PATTERN.test(value)) errors.push(`${citationId}: ${label} không phải SHA-256 32-byte hợp lệ.`);
    }
    const roots = [source.indexedBlobMerkleRoot, source.currentBlobMerkleRoot, source.recomputedBlobMerkleRoot].filter(Boolean).map((root) => normalizeSha256(root!));
    if (source.level !== "failed" && roots.length > 1 && new Set(roots).size !== 1) errors.push(`${citationId}: các mã đối chiếu tệp không khớp nhau.`);
    if (verificationScope(source) === "source_bytes_only_ocr_not_independently_verified" && source.level === "content_verified") {
      errors.push(`${citationId}: nội dung OCR/AI không được phép ghi là content_verified nếu không có dữ liệu tái tạo độc lập.`);
    }
  }
  const citedIds = Array.from(receipt.answer.matchAll(/\[(S\d+)\]/gi), (match) => match[1].toUpperCase());
  if (!citedIds.length && receipt.sources.length) errors.push("Câu trả lời không liên kết tới nguồn nào trong receipt.");
  for (const citationId of citedIds) if (!sourceMap.has(citationId)) errors.push(`Câu trả lời tham chiếu ${citationId} nhưng receipt không có nguồn này.`);
  for (const citationId of sourceMap.keys()) if (!citedIds.includes(citationId)) errors.push(`Nguồn ${citationId} không được dùng trong câu trả lời.`);
  if (receipt.sources.some((source) => !source.pageContentHash && !source.chunkContentHash)) {
    warnings.push("Một số nguồn không có page/chunk content hash; vẫn kiểm tra được hash đoạn trích của envelope v2 nhưng không thể tái tạo hash toàn trang/chunk offline.");
  }
}

/** Wraps the existing v1 receipt in a deterministic, portable v2 envelope. */
export async function createAnswerReceiptEnvelope(receipt: AnswerReceipt): Promise<AnswerReceiptEnvelopeV2> {
  // A freshly-created v1 object may still contain optional properties set to
  // undefined. Round-trip through JSON so the exported artifact has exactly
  // the same portable value model that the verifier canonicalizes.
  const portableReceipt = JSON.parse(JSON.stringify(receipt)) as unknown;
  const errors: string[] = [];
  if (!validateReceiptSchema(portableReceipt, errors)) throw new TypeError(errors.join(" "));
  const expectedReceiptId = await computeAnswerReceiptId(portableReceipt);
  if (normalizeSha256(portableReceipt.id) !== normalizeSha256(expectedReceiptId)) {
    throw new TypeError("Mã phiếu v1 không khớp nội dung receipt.");
  }
  const citations = await Promise.all(portableReceipt.sources.map((source) => citationIntegrity(source as ReceiptSourceWithContext)));
  const payload = { receipt: portableReceipt, citations };
  return {
    format: RECEIPT_ENVELOPE_FORMAT,
    version: RECEIPT_ENVELOPE_VERSION,
    payload,
    integrity: {
      algorithm: "SHA-256",
      canonicalization: RECEIPT_CANONICALIZATION,
      scope: "payload",
      digest: await sha256Text(canonicalizeAnswerReceiptValue(payload)),
    },
  };
}

function emptyVerificationReport(): AnswerReceiptVerificationReport {
  return {
    valid: false,
    integrityVerified: false,
    authenticated: false,
    compatible: false,
    checks: {
      schema: "fail",
      receiptId: "unavailable",
      envelopeDigest: "unavailable",
      citations: "unavailable",
      excerptHashes: "unavailable",
      declaredContentHashes: "unavailable",
      evidenceScope: "unavailable",
      sourceBytes: "unavailable",
      authenticity: "unavailable",
    },
    errors: [],
    warnings: ["Checksum SHA-256 chỉ cho biết các trường hiện tại nhất quán. Bất kỳ ai sửa file cũng có thể tính lại checksum; receipt không xác thực tác giả hoặc lịch sử chỉnh sửa vì chưa có chữ ký số."],
  };
}

function parseReceiptInput(input: string | unknown): unknown {
  if (typeof input !== "string") return input;
  return JSON.parse(input) as unknown;
}

/**
 * Verifies a downloaded receipt without Shelby/network access. It verifies the
 * schema, canonical envelope digest, citation binding and hashes that are
 * actually present. It deliberately does not claim to re-run OCR, fetch source
 * bytes, or authenticate the receipt author.
 */
export async function verifyAnswerReceipt(input: string | unknown): Promise<AnswerReceiptVerificationReport> {
  const report = emptyVerificationReport();
  let parsed: unknown;
  try {
    parsed = parseReceiptInput(input);
  } catch {
    report.errors.push("JSON không hợp lệ.");
    return report;
  }

  if (isRecord(parsed) && parsed.format === "shelby-answer-receipt" && parsed.version === 1) {
    const schemaErrors: string[] = [];
    if (!validateReceiptSchema(parsed, schemaErrors)) {
      report.errors.push(...schemaErrors);
      return report;
    }
    report.compatible = true;
    report.inputVersion = 1;
    report.receipt = parsed;
    report.checks.schema = "pass";
    const expectedReceiptId = await computeAnswerReceiptId(parsed);
    report.checks.receiptId = normalizeSha256(parsed.id) === normalizeSha256(expectedReceiptId) ? "pass" : "fail";
    if (report.checks.receiptId === "fail") report.errors.push("Mã phiếu v1 không khớp các trường nội dung hiện tại.");
    const semanticErrors: string[] = [];
    checkReceiptSemantics(parsed, semanticErrors, report.warnings);
    report.errors.push(...semanticErrors);
    report.checks.citations = semanticErrors.some((error) => /trích dẫn|tham chiếu|Nguồn S\d+ không được dùng|liên kết tới nguồn/.test(error)) ? "fail" : "pass";
    report.checks.declaredContentHashes = semanticErrors.some((error) => /hash|mã đối chiếu/.test(error)) ? "fail" : parsed.sources.some((source) => source.pageContentHash || source.chunkContentHash) ? "declared_only" : "unavailable";
    report.valid = report.errors.length === 0;
    report.warnings.push("Receipt v1 tương thích nhưng chưa có checksum canonical cho toàn payload; hãy export lại thành v2 để kiểm tra cấu trúc nội bộ đầy đủ hơn.");
    return report;
  }

  if (!isRecord(parsed) || parsed.format !== RECEIPT_ENVELOPE_FORMAT || parsed.version !== RECEIPT_ENVELOPE_VERSION) {
    report.errors.push("Không nhận ra định dạng Answer Receipt v1 hoặc envelope v2.");
    return report;
  }
  report.inputVersion = 2;
  if (!isRecord(parsed.payload) || !isRecord(parsed.integrity) || !Array.isArray(parsed.payload.citations)) {
    report.errors.push("Cấu trúc envelope v2 không hợp lệ.");
    return report;
  }
  const integrity = parsed.integrity;
  if (integrity.algorithm !== "SHA-256" || integrity.canonicalization !== RECEIPT_CANONICALIZATION || integrity.scope !== "payload" || typeof integrity.digest !== "string" || !SHA256_PATTERN.test(integrity.digest)) {
    report.errors.push("Thông tin canonical digest không hợp lệ.");
    return report;
  }
  const schemaErrors: string[] = [];
  if (!validateReceiptSchema(parsed.payload.receipt, schemaErrors)) {
    report.errors.push(...schemaErrors);
    return report;
  }
  parsed.payload.citations.forEach((citation, index) => validateCitationIntegritySchema(citation, index, schemaErrors));
  if (schemaErrors.length) {
    report.errors.push(...schemaErrors);
    return report;
  }
  const receipt = parsed.payload.receipt;
  report.compatible = true;
  report.receipt = receipt;
  report.checks.schema = "pass";
  const expectedReceiptId = await computeAnswerReceiptId(receipt);
  report.checks.receiptId = normalizeSha256(receipt.id) === normalizeSha256(expectedReceiptId) ? "pass" : "fail";
  if (report.checks.receiptId === "fail") report.errors.push("Mã phiếu v1 không khớp các trường nội dung hiện tại.");
  const expectedDigest = await sha256Text(canonicalizeAnswerReceiptValue(parsed.payload));
  report.integrityVerified = normalizeSha256(integrity.digest) === normalizeSha256(expectedDigest);
  report.checks.envelopeDigest = report.integrityVerified ? "pass" : "fail";
  if (!report.integrityVerified) report.errors.push("Checksum canonical không khớp payload hiện tại; file có thể bị hỏng hoặc checksum chưa được tính lại.");

  const semanticErrors: string[] = [];
  checkReceiptSemantics(receipt, semanticErrors, report.warnings);
  report.errors.push(...semanticErrors);
  report.checks.citations = semanticErrors.some((error) => /trích dẫn|tham chiếu|Nguồn S\d+ không được dùng|liên kết tới nguồn/.test(error)) ? "fail" : "pass";
  report.checks.declaredContentHashes = semanticErrors.some((error) => /hash|mã đối chiếu/.test(error)) ? "fail" : receipt.sources.some((source) => source.pageContentHash || source.chunkContentHash) ? "declared_only" : "unavailable";

  const citations = parsed.payload.citations as unknown[];
  const citationIntegrityErrors: string[] = [];
  const excerptHashErrors: string[] = [];
  const declaredHashErrors: string[] = [];
  const evidenceScopeErrors: string[] = [];
  if (citations.length !== receipt.sources.length) citationIntegrityErrors.push("Số citation integrity record không khớp receipt.");
  for (const source of receipt.sources as ReceiptSourceWithContext[]) {
    const candidate = citations.find((item) => isRecord(item) && typeof item.citationId === "string" && item.citationId.toUpperCase() === source.citationId.toUpperCase());
    if (!isRecord(candidate)) {
      const error = `${source.citationId}: thiếu citation integrity record.`;
      citationIntegrityErrors.push(error);
      excerptHashErrors.push(error);
      evidenceScopeErrors.push(error);
      if (source.pageContentHash || source.chunkContentHash) declaredHashErrors.push(error);
      continue;
    }
    const expected = await citationIntegrity(source);
    for (const field of ["citationId", "source", "pageNumber", "citationSha256"] as const) if (candidate[field] !== expected[field]) citationIntegrityErrors.push(`${source.citationId}: ${field} không khớp.`);
    for (const field of ["excerptNormalization", "excerptSha256"] as const) if (candidate[field] !== expected[field]) excerptHashErrors.push(`${source.citationId}: ${field} không khớp.`);
    for (const field of ["indexedPageContentSha256", "indexedChunkContentSha256"] as const) if (candidate[field] !== expected[field]) declaredHashErrors.push(`${source.citationId}: ${field} không khớp.`);
    for (const field of ["verificationScope", "extractionMethod"] as const) if (candidate[field] !== expected[field]) evidenceScopeErrors.push(`${source.citationId}: ${field} không khớp.`);
  }
  report.errors.push(...citationIntegrityErrors, ...excerptHashErrors, ...declaredHashErrors, ...evidenceScopeErrors);
  if (citationIntegrityErrors.length) report.checks.citations = "fail";
  report.checks.excerptHashes = excerptHashErrors.length ? "fail" : "pass";
  if (declaredHashErrors.length) report.checks.declaredContentHashes = "fail";
  report.checks.evidenceScope = evidenceScopeErrors.length ? "fail" : "pass";
  report.valid = report.errors.length === 0 && report.integrityVerified;
  return report;
}

export function assignCitationIds(sources: RetrievalResult[]): RetrievalResult[] {
  return sources.map((source, index) => ({ ...source, citationId: `S${index + 1}` }));
}

/** Keeps only evidence IDs the model explicitly cited in its final answer. */
export function selectCitedSources(answer: string, candidates: RetrievalResult[]): RetrievalResult[] {
  const citedIds = new Set<string>();
  for (const group of answer.matchAll(/\[([^\]]+)\]/g)) {
    for (const citation of group[1].matchAll(/\bS(\d+)\b/gi)) {
      citedIds.add(`S${Number(citation[1])}`);
    }
  }
  return candidates.filter((source) => source.citationId && citedIds.has(source.citationId.toUpperCase()));
}

export function finalizeCitationGrounding(
  answer: string,
  candidates: RetrievalResult[],
  missingCitationMessage: string,
  options: {
    retrievalAttempted?: boolean;
    noEvidenceMessage?: string;
  } = {},
): { answer: string; sources: RetrievalResult[]; grounded: boolean | null } {
  const sources = selectCitedSources(answer, candidates);
  if (!candidates.length) {
    if (options.retrievalAttempted) {
      return {
        answer: options.noEvidenceMessage ?? missingCitationMessage,
        sources,
        grounded: false,
      };
    }
    return { answer, sources, grounded: null };
  }
  if (!sources.length) return { answer: missingCitationMessage, sources: [], grounded: false };
  return { answer, sources, grounded: true };
}

export function receiptLevel(sources: Pick<AnswerReceiptSource, "level">[]): AnswerVerificationLevel {
  if (!sources.length || sources.some((source) => source.level === "failed")) return "failed";
  if (sources.every((source) => source.level === "content_verified")) return "content_verified";
  if (sources.every((source) => source.level === "content_verified" || source.level === "source_verified")) return "source_verified";
  return "indexed_only";
}

async function verifySource(source: RetrievalResult, signal?: AbortSignal): Promise<AnswerReceiptSource> {
  const checkedAt = Date.now();
  const base = {
    citationId: source.citationId ?? "S?",
    source: source.source,
    displayName: source.displayName,
    pageNumber: source.pageNumber,
    excerpt: source.excerpt,
    checkedAt,
    indexedBlobMerkleRoot: source.provenance?.blobMerkleRoot,
    pageContentHash: source.provenance?.pageContentHash,
    chunkContentHash: source.provenance?.chunkContentHash,
    extractionMethod: source.provenance?.extractionMethod,
  };
  const provenance = source.provenance;
  if (!provenance?.owner || !provenance.blobMerkleRoot) {
    return { ...base, level: "indexed_only", explanation: localize(
      "This index does not contain the original file fingerprint. Rebuild RAG to enable stronger verification.",
      "Bản chỉ mục này chưa lưu mã đối chiếu của tệp gốc. Hãy tạo lại RAG để nâng mức xác minh.",
    ) };
  }
  if (provenance.accessTag !== "public") {
    return { ...base, level: "indexed_only", explanation: localize(
      "The excerpt exists in the on-device index, but the source requires access and could not be checked again automatically.",
      "Đoạn trích có trong kho trên máy, nhưng tệp nguồn cần quyền truy cập nên chưa thể tự đối chiếu lại.",
    ) };
  }

  try {
    signal?.throwIfAborted();
    const blobName = BlobNameSchema.parse(source.source);
    const metadata = await blobClient.getBlobMetadata({ account: AccountAddress.fromString(provenance.owner), name: blobName });
    signal?.throwIfAborted();
    if (!metadata || metadata.isDeleted) return { ...base, level: "failed", explanation: localize("The file registration is no longer available on Shelby.", "Không còn tìm thấy đăng ký tệp này trên Shelby.") };
    if (metadata.isWritten !== true) return { ...base, level: "failed", explanation: localize("The file is registered, but its data has not finished uploading to Shelby.", "Tệp đã đăng ký nhưng dữ liệu chưa được ghi hoàn tất lên Shelby.") };
    if (Number(metadata.expirationMicros ?? 0) > 0 && Number(metadata.expirationMicros) <= Date.now() * 1_000) {
      return { ...base, level: "failed", explanation: localize("The source file has expired on Shelby.", "Tệp nguồn trên Shelby đã hết hạn.") };
    }

    const indexedRoot = normalizeHex(provenance.blobMerkleRoot);
    const currentRoot = normalizeHex(metadata.blobMerkleRoot);
    const currentRootDisplay = currentRoot ? `0x${currentRoot}` : undefined;
    if (!indexedRoot || !currentRoot || indexedRoot !== currentRoot) {
      return { ...base, currentBlobMerkleRoot: currentRootDisplay, level: "failed", explanation: localize("The current file fingerprint does not match the version used to build RAG.", "Mã tệp hiện tại không khớp với bản đã dùng để tạo RAG.") };
    }
    if (provenance.blobSize !== undefined && metadata.size !== provenance.blobSize) {
      return { ...base, currentBlobMerkleRoot: currentRootDisplay, level: "failed", explanation: localize("The current file size differs from the version used to build RAG.", "Kích thước tệp hiện tại khác bản đã dùng để tạo RAG.") };
    }
    if (metadata.size > MAX_VERIFY_BYTES) {
      return { ...base, currentBlobMerkleRoot: currentRootDisplay, level: "indexed_only", explanation: localize("The file exceeds 25 MB, so the browser did not repeat the verification.", "Tệp lớn hơn giới hạn 25 MB nên trình duyệt không tự chạy lại phép đối chiếu.") };
    }

    const url = getShelbyBlobUrl(provenance.owner, source.source);
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(localize(`Unable to download the source file (${response.status}).`, `Không tải được tệp nguồn (${response.status}).`));
    const contentLength = Number(response.headers.get("content-length") ?? metadata.size);
    if (contentLength > MAX_VERIFY_BYTES) throw new Error(localize("The file exceeds the 25 MB verification limit.", "Tệp vượt giới hạn đối chiếu 25 MB."));
    const provider = await getErasureProvider();
    signal?.throwIfAborted();
    const bounded = boundedSourceStream(response.body, metadata.size, signal);
    const commitments = await generateCommitments(provider, bounded.stream);
    if (bounded.bytesRead() !== metadata.size) throw new Error(localize("Downloaded bytes do not match the size registered on Shelby.", "Số byte tải về không khớp kích thước đã đăng ký trên Shelby."));
    const recomputedRoot = normalizeHex(commitments.blob_merkle_root);
    const recomputedRootDisplay = recomputedRoot ? `0x${recomputedRoot}` : undefined;
    if (!recomputedRoot || recomputedRoot !== currentRoot) {
      return { ...base, currentBlobMerkleRoot: currentRootDisplay, recomputedBlobMerkleRoot: recomputedRootDisplay, level: "failed", explanation: localize("The downloaded bytes do not reproduce the fingerprint registered on Shelby.", "Dữ liệu tải về không tạo ra cùng mã với đăng ký trên Shelby.") };
    }

    const extractionMethod = provenance.extractionMethod;
    if (extractionMethod === "text_layer" && source.pageNumber > 0) {
      const page = await extractSinglePageFromUrl(url, source.source, source.pageNumber, provenance.mimeType, signal);
      signal?.throwIfAborted();
      const normalizedPage = normalizeSearchText(page.text);
      const normalizedExcerpt = normalizeSearchText(source.excerpt);
      const freshPageHash = await sha256Text(normalizedPage);
      const hashMatches = !provenance.pageContentHash || normalizeHex(freshPageHash) === normalizeHex(provenance.pageContentHash);
      if (normalizedExcerpt && normalizedPage.includes(normalizedExcerpt) && hashMatches) {
        return { ...base, currentBlobMerkleRoot: currentRootDisplay, recomputedBlobMerkleRoot: recomputedRootDisplay, level: "content_verified", explanation: localize("The Shelby file matched and the excerpt was found again on the source page.", "Đã đối chiếu tệp trên Shelby và tìm lại đúng đoạn trích ở trang nguồn.") };
      }
      return { ...base, currentBlobMerkleRoot: currentRootDisplay, recomputedBlobMerkleRoot: recomputedRootDisplay, level: "source_verified", explanation: localize("The source file matches Shelby, but rereading the page did not reproduce the indexed excerpt exactly.", "Tệp gốc khớp Shelby, nhưng lần đọc lại trang không tái tạo chính xác đoạn đã lập chỉ mục.") };
    }

    return {
      ...base,
      currentBlobMerkleRoot: currentRootDisplay,
      recomputedBlobMerkleRoot: recomputedRootDisplay,
      level: "source_verified",
      explanation: extractionMethod === "local_ocr" || extractionMethod === "cloud_vision" || extractionMethod === "mixed"
        ? localize("The source file matches Shelby. Because the text came from OCR or AI, the receipt does not call it cryptographic proof of the content.", "Tệp gốc khớp Shelby. Đoạn chữ đến từ OCR/AI nên phiếu không gọi đó là bằng chứng mật mã của nội dung.")
        : localize("The source file matches its Shelby registration, but the older index lacks enough data to reproduce the excerpt.", "Tệp gốc khớp đăng ký Shelby; bản chỉ mục cũ chưa đủ dữ liệu để đối chiếu lại đoạn chữ."),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...base, level: "failed", explanation: error instanceof Error ? error.message : String(error) };
  }
}

export async function createAnswerReceipt(input: {
  wallet: string;
  question: string;
  answer: string;
  sources: RetrievalResult[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<AnswerReceipt> {
  const labeledSources = assignCitationIds(input.sources);
  const verifiedSources: AnswerReceiptSource[] = [];
  for (let index = 0; index < labeledSources.length; index += 1) {
    input.signal?.throwIfAborted();
    input.onProgress?.(localize(
      `Checking source ${index + 1}/${labeledSources.length}…`,
      `Đang đối chiếu nguồn ${index + 1}/${labeledSources.length}…`,
    ));
    verifiedSources.push(await verifySource(labeledSources[index], input.signal));
  }
  const createdAt = Date.now();
  const payload = {
    format: "shelby-answer-receipt" as const,
    version: 1 as const,
    createdAt,
    wallet: input.wallet.toLowerCase(),
    question: input.question,
    answer: input.answer,
    level: receiptLevel(verifiedSources),
    sources: verifiedSources,
    note: localize(
      "This receipt records source checks performed when it was created. Its checksum only checks internal consistency; it does not authenticate the author or prove every AI inference is correct.",
      "Phiếu ghi lại kết quả đối chiếu nguồn tại thời điểm tạo. Checksum chỉ kiểm tra cấu trúc nội bộ; không xác thực tác giả và không chứng minh mọi suy luận của AI đều đúng.",
    ),
  };
  return { ...payload, id: await computeAnswerReceiptId(payload) };
}

export async function downloadAnswerReceipt(receipt: AnswerReceipt): Promise<AnswerReceiptEnvelopeV2> {
  const envelope = await createAnswerReceiptEnvelope(receipt);
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `answer-receipt-${receipt.id.slice(2, 12)}.json`;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return envelope;
}
