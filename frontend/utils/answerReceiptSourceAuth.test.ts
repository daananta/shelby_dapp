import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBlobMetadata: vi.fn(),
  generateCommitments: vi.fn(),
}));

vi.mock("@/utils/shelbyConfig", () => ({
  blobClient: { getBlobMetadata: mocks.getBlobMetadata },
  getShelbyBlobUrl: (_owner: string, name: string) => `https://api.testnet.shelby.xyz/${name}`,
}));

vi.mock("@/utils/geomiClientKey", () => ({
  SHELBY_CLIENT_API_KEY: "AG-test-client",
}));

vi.mock("@/utils/shelbyErasure", () => ({
  getErasureProvider: vi.fn().mockResolvedValue({}),
}));

vi.mock("@shelby-protocol/sdk/browser", () => ({
  BlobNameSchema: { parse: (value: string) => value },
  generateCommitments: mocks.generateCommitments,
}));

import { createAnswerReceipt } from "@/utils/answerReceipt";
import type { RetrievalResult } from "@/utils/ragTypes";

const ROOT = `0x${"ab".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Answer Receipt Shelby authentication", () => {
  it("uses the configured public client key when rereading registered source bytes", async () => {
    mocks.getBlobMetadata.mockResolvedValue({
      blobMerkleRoot: ROOT,
      expirationMicros: Date.now() * 1_000 + 60_000_000,
      isDeleted: false,
      isWritten: true,
      size: 4,
    });
    mocks.generateCommitments.mockImplementation(async (_provider: unknown, stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // Consume the bounded stream so the receipt can verify the byte count.
      }
      return { blob_merkle_root: ROOT };
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-length": "4", "content-type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const evidence: RetrievalResult = {
      citationId: "S1",
      method: "lexical",
      documentId: "0x1:image.png",
      source: "image.png",
      displayName: "Image",
      pageNumber: 1,
      totalPages: 1,
      excerpt: "An indexed image description.",
      score: 0.9,
      provenance: {
        owner: "0x1",
        accessTag: "public",
        blobMerkleRoot: ROOT,
        blobSize: 4,
        indexedAt: Date.now(),
        sourceRevision: "revision-1",
        mimeType: "image/png",
        extractionMethod: "cloud_vision",
      },
    };

    const receipt = await createAnswerReceipt({
      wallet: "0x1",
      question: "What is visible?",
      answer: "An indexed image [S1].",
      sources: [evidence],
    });

    expect(receipt.sources[0]).toMatchObject({ level: "source_verified" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer AG-test-client");
  });
});
