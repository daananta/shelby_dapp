import { describe, expect, it } from "vitest";
import {
  assignCitationIds,
  canonicalizeAnswerReceiptValue,
  computeAnswerReceiptId,
  createAnswerReceipt,
  createAnswerReceiptEnvelope,
  receiptLevel,
  selectCitedSources,
  verifyAnswerReceipt,
} from "@/utils/answerReceipt";
import { sha256Text } from "@/utils/contentIntegrity";
import type { AnswerReceipt, RetrievalResult } from "@/utils/ragTypes";

const source = (name: string): RetrievalResult => ({
  method: "lexical",
  documentId: `0x1:${name}`,
  source: name,
  displayName: name,
  pageNumber: 1,
  totalPages: 1,
  excerpt: `Nội dung từ ${name}`,
  score: 0.8,
});

const HASH = `0x${"ab".repeat(32)}`;

async function portableReceipt(): Promise<AnswerReceipt> {
  const receipt: AnswerReceipt = {
    format: "shelby-answer-receipt",
    version: 1,
    id: `0x${"12".repeat(32)}`,
    createdAt: 1_725_000_000_000,
    wallet: "0xabc",
    question: "Tệp nói gì?",
    answer: "Tài liệu mô tả Shelby [S1].",
    level: "content_verified",
    sources: [{
      citationId: "S1",
      source: "guide.pdf",
      displayName: "Guide",
      pageNumber: 2,
      excerpt: "Shelby là hot storage.",
      level: "content_verified",
      explanation: "Đã tìm lại đoạn chữ.",
      checkedAt: 1_725_000_000_100,
      indexedBlobMerkleRoot: HASH,
      currentBlobMerkleRoot: HASH,
      recomputedBlobMerkleRoot: HASH,
      pageContentHash: HASH,
      chunkContentHash: HASH,
      extractionMethod: "text_layer",
    } as AnswerReceipt["sources"][number]],
    note: "Không chứng minh mọi suy luận của AI đều đúng.",
  };
  receipt.id = await computeAnswerReceiptId(receipt);
  return receipt;
}

describe("Answer Receipt grounding", () => {
  it("keeps only evidence IDs explicitly cited by the model", () => {
    const candidates = assignCitationIds([source("a.txt"), source("b.txt"), source("c.txt")]);
    expect(selectCitedSources("Kết luận thứ nhất [S2]. Nguồn bổ sung [S1].", candidates).map((item) => item.source)).toEqual(["a.txt", "b.txt"]);
    expect(selectCitedSources("Câu trả lời không có mã nguồn.", candidates)).toEqual([]);
  });

  it("uses the weakest honest verification level", () => {
    expect(receiptLevel([{ level: "content_verified" }, { level: "source_verified" }])).toBe("source_verified");
    expect(receiptLevel([{ level: "content_verified" }, { level: "indexed_only" }])).toBe("indexed_only");
    expect(receiptLevel([{ level: "failed" }])).toBe("failed");
  });

  it("creates an indexed-only receipt for a legacy source without a Shelby root", async () => {
    const receipt = await createAnswerReceipt({ wallet: "0xABC", question: "Tệp nói gì?", answer: "Một câu trả lời [S1].", sources: assignCitationIds([source("legacy.txt")]) });
    expect(receipt).toMatchObject({ format: "shelby-answer-receipt", version: 1, wallet: "0xabc", level: "indexed_only" });
    expect(receipt.id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.sources[0].explanation).toContain("does not contain the original file fingerprint");
    const envelope = await createAnswerReceiptEnvelope(receipt);
    expect((await verifyAnswerReceipt(envelope)).valid).toBe(true);
  });

  it("preserves a filtered source id so the receipt stays bound to the answer", async () => {
    const receipt = await createAnswerReceipt({
      wallet: "0xABC",
      question: "Nguồn thứ ba nói gì?",
      answer: "Câu trả lời chỉ dùng nguồn thứ ba [S3].",
      sources: [{ ...source("third.txt"), citationId: "S3" }],
    });

    expect(receipt.sources.map((item) => item.citationId)).toEqual(["S3"]);
    const envelope = await createAnswerReceiptEnvelope(receipt);
    expect(await verifyAnswerReceipt(envelope)).toMatchObject({
      valid: true,
      checks: { citations: "pass" },
    });
  });

  it("verifies compact citations without changing their source ids", async () => {
    const receipt = await createAnswerReceipt({
      wallet: "0xABC",
      question: "Hai nguồn nói gì?",
      answer: "Câu trả lời kết hợp hai nguồn [S1, S3].",
      sources: [
        { ...source("first.txt"), citationId: "S1" },
        { ...source("third.txt"), citationId: "S3" },
      ],
    });

    expect(receipt.sources.map((item) => item.citationId)).toEqual(["S1", "S3"]);
    expect(await verifyAnswerReceipt(await createAnswerReceiptEnvelope(receipt))).toMatchObject({
      valid: true,
      checks: { citations: "pass" },
    });
  });

  it("rejects ambiguous preassigned citation ids", async () => {
    await expect(createAnswerReceipt({
      wallet: "0xABC",
      question: "Tệp nói gì?",
      answer: "Không thể biết nguồn nào [S1].",
      sources: [
        { ...source("first.txt"), citationId: "S1" },
        { ...source("duplicate.txt"), citationId: "S1" },
      ],
    })).rejects.toThrow("Duplicate citation id: S1");
  });

  it("canonicalizes objects independently of property insertion order", () => {
    expect(canonicalizeAnswerReceiptValue({ z: 1, a: { y: true, b: "x" } })).toBe(canonicalizeAnswerReceiptValue({ a: { b: "x", y: true }, z: 1 }));
    expect(() => canonicalizeAnswerReceiptValue({ bad: undefined })).toThrow(/undefined/);
  });

  it("exports a canonical v2 envelope and verifies it entirely offline", async () => {
    const envelope = await createAnswerReceiptEnvelope(await portableReceipt());
    expect(envelope).toMatchObject({
      format: "shelby-answer-receipt-envelope",
      version: 2,
      integrity: { algorithm: "SHA-256", canonicalization: "shelby-c14n-json-v1", scope: "payload" },
    });
    expect(envelope.payload.citations[0]).toMatchObject({
      citationId: "S1",
      excerptNormalization: "nfc-lowercase-vi-whitespace-v1",
      indexedPageContentSha256: HASH,
      indexedChunkContentSha256: HASH,
      extractionMethod: "text_layer",
      verificationScope: "text_layer_excerpt_reproduced_at_creation",
    });

    const report = await verifyAnswerReceipt(JSON.stringify(envelope));
    expect(report).toMatchObject({
      valid: true,
      integrityVerified: true,
      compatible: true,
      inputVersion: 2,
      checks: {
        schema: "pass",
        receiptId: "pass",
        envelopeDigest: "pass",
        citations: "pass",
        excerptHashes: "pass",
        declaredContentHashes: "declared_only",
        evidenceScope: "pass",
        sourceBytes: "unavailable",
        authenticity: "unavailable",
      },
    });
    expect(report.warnings.join(" ")).toContain("không xác thực tác giả");
  });

  it("detects payload tampering through the envelope digest", async () => {
    const envelope = await createAnswerReceiptEnvelope(await portableReceipt());
    envelope.payload.receipt.answer = "Nội dung đã bị sửa [S1].";
    const report = await verifyAnswerReceipt(envelope);
    expect(report.valid).toBe(false);
    expect(report.checks.receiptId).toBe("fail");
    expect(report.checks.envelopeDigest).toBe("fail");
    expect(report.errors.join(" ")).toContain("Checksum canonical không khớp");
  });

  it("checks citations and excerpt hashes even when someone recomputes the unsigned digest", async () => {
    const badCitation = await createAnswerReceiptEnvelope(await portableReceipt());
    badCitation.payload.receipt.answer = "Nguồn không tồn tại [S9].";
    badCitation.integrity.digest = await sha256Text(canonicalizeAnswerReceiptValue(badCitation.payload));
    const citationReport = await verifyAnswerReceipt(badCitation);
    expect(citationReport.checks.envelopeDigest).toBe("pass");
    expect(citationReport.checks.citations).toBe("fail");
    expect(citationReport.valid).toBe(false);

    const badExcerpt = await createAnswerReceiptEnvelope(await portableReceipt());
    badExcerpt.payload.receipt.sources[0].excerpt = "Đoạn trích đã bị thay thế.";
    badExcerpt.integrity.digest = await sha256Text(canonicalizeAnswerReceiptValue(badExcerpt.payload));
    const excerptReport = await verifyAnswerReceipt(badExcerpt);
    expect(excerptReport.checks.envelopeDigest).toBe("pass");
    expect(excerptReport.checks.excerptHashes).toBe("fail");
    expect(excerptReport.valid).toBe(false);
  });

  it("shows that recomputed unsigned checksums do not authenticate the author", async () => {
    const forged = await createAnswerReceiptEnvelope(await portableReceipt());
    forged.payload.receipt.answer = "Một người khác có thể sửa câu chữ rồi tính lại mọi checksum [S1].";
    forged.payload.receipt.id = await computeAnswerReceiptId(forged.payload.receipt);
    forged.integrity.digest = await sha256Text(canonicalizeAnswerReceiptValue(forged.payload));

    const report = await verifyAnswerReceipt(forged);
    expect(report).toMatchObject({
      valid: true,
      integrityVerified: true,
      authenticated: false,
      checks: { receiptId: "pass", envelopeDigest: "pass", authenticity: "unavailable" },
    });
    expect(report.warnings.join(" ")).toContain("Bất kỳ ai sửa file cũng có thể tính lại checksum");
  });

  it("recomputes and rejects a stale v1 receipt id", async () => {
    const receipt = await portableReceipt();
    receipt.question = "Câu hỏi đã đổi";
    const report = await verifyAnswerReceipt(receipt);
    expect(report.valid).toBe(false);
    expect(report.checks.receiptId).toBe("fail");
    expect(report.errors.join(" ")).toContain("Mã phiếu v1 không khớp");
  });

  it("accepts legacy v1 receipts without pretending they already have a portable digest", async () => {
    const report = await verifyAnswerReceipt(await portableReceipt());
    expect(report).toMatchObject({ valid: true, compatible: true, inputVersion: 1, integrityVerified: false });
    expect(report.checks.envelopeDigest).toBe("unavailable");
    expect(report.warnings.join(" ")).toContain("export lại thành v2");
  });

  it("rejects a cryptographic content claim for OCR without independently reproducible text", async () => {
    const receipt = await portableReceipt();
    Object.assign(receipt.sources[0], { extractionMethod: "cloud_vision", level: "content_verified" });
    receipt.id = await computeAnswerReceiptId(receipt);
    const envelope = await createAnswerReceiptEnvelope(receipt);
    expect(envelope.payload.citations[0].verificationScope).toBe("source_bytes_only_ocr_not_independently_verified");
    const report = await verifyAnswerReceipt(envelope);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).toContain("OCR/AI không được phép ghi là content_verified");
  });
});
