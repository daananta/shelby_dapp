import { describe, expect, it } from "vitest";
import { getRagInputKind } from "@/utils/ragInput";

describe("RAG input classification", () => {
  it("keeps supported packages, images and documents in the proper pipeline", () => {
    expect(getRagInputKind("backup.shelby-rag.json")).toBe("package");
    expect(getRagInputKind("backup.shelby-hot-rag.json")).toBe("package");
    expect(getRagInputKind("cover.webp")).toBe("image");
    expect(getRagInputKind("books/guide.PDF")).toBe("document");
    expect(getRagInputKind("notes.jsonl")).toBe("document");
  });

  it("routes supported binary media to its real decoder", () => {
    expect(getRagInputKind("demo.mp4")).toBe("video");
    expect(getRagInputKind("weights.onnx")).toBe("unsupported");
  });
});
