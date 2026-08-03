import { describe, expect, it } from "vitest";
import { classifyQueryIntent, extractQuotedText } from "@/utils/queryRouter";

describe("query router", () => {
  it("routes quoted page lookup without invoking semantic RAG", () => {
    const query = 'Câu này ở trang nào "Người ấy thấy Dương Bố ướt cả cho mượn cái áo thâm"';
    expect(extractQuotedText(query)).toContain("Dương Bố");
    expect(classifyQueryIntent(query).intent).toBe("page_lookup");
    expect(classifyQueryIntent('Which page contains "Every answer needs a source citation"?').intent).toBe("page_lookup");
  });

  it("keeps general knowledge outside document RAG", () => {
    expect(classifyQueryIntent("Con ngựa có chạy nhanh không?")).toEqual({ intent: "general", documentScoped: false });
    expect(classifyQueryIntent('“Knowledge is power” nghĩa là gì?')).toEqual({ intent: "general", documentScoped: false });
    expect(classifyQueryIntent("How many pages does a typical book have?")).toEqual({ intent: "general", documentScoped: false });
    expect(classifyQueryIntent("What is work-life balance?")).toEqual({ intent: "general", documentScoped: false });
    expect(classifyQueryIntent("Explain what a wallet address is.")).toEqual({ intent: "general", documentScoped: false });
    expect(classifyQueryIntent("How many files can a directory contain?")).toEqual({ intent: "general", documentScoped: false });
  });

  it("recognizes an explicit request to inspect a concrete indexed filename", () => {
    expect(classifyQueryIntent("Open package.json and identify the main libraries used.")).toEqual({
      intent: "document_semantic",
      documentScoped: true,
    });
  });

  it("uses exact lookup only when the user explicitly asks to locate a quote", () => {
    expect(classifyQueryIntent('Tìm nguyên văn câu “Knowledge is power” trong tài liệu').intent).toBe("exact_quote");
    expect(classifyQueryIntent('Câu “Knowledge is power” có xuất hiện trong sách không?').intent).toBe("exact_quote");
  });

  it("recognizes book inventory and story lookup", () => {
    expect(classifyQueryIntent("Tôi có sách Cổ học tinh hoa không?").intent).toBe("inventory");
    expect(classifyQueryIntent("Kể câu chuyện 243").intent).toBe("story_lookup");
    expect(classifyQueryIntent("Tôi có sách không, kể câu chuyện thứ 112 trong sách").intent).toBe("story_lookup");
    expect(classifyQueryIntent("How many blobs does my wallet have?").intent).toBe("inventory");
    expect(classifyQueryIntent("Tôi có những blob nào?").intent).toBe("inventory");
    expect(classifyQueryIntent("Kiểm tra số blob hiện tại của ví tôi").intent).toBe("inventory");
    expect(classifyQueryIntent("Which wallet is connected?").intent).toBe("wallet");
    expect(classifyQueryIntent("Tell me story number 12 from my book").intent).toBe("story_lookup");
  });

  it("routes a named image blob to the image pipeline without requiring the word ảnh", () => {
    expect(classifyQueryIntent("moai.webp của tôi mô tả cái gì")).toMatchObject({ intent: "image", documentScoped: true });
    expect(classifyQueryIntent("Show me anime2.jpeg from my indexed Shelby blobs.")).toMatchObject({ intent: "image", documentScoped: true });
    expect(classifyQueryIntent("Which indexed image blobs are available?")).toMatchObject({ intent: "image", documentScoped: true });
    expect(classifyQueryIntent("List indexed image blobs")).toMatchObject({ intent: "image", documentScoped: true });
    expect(classifyQueryIntent("Inspect indexed image blobs")).toMatchObject({ intent: "image", documentScoped: true });
  });

  it("keeps visual-detail follow-ups inside the image trust boundary", () => {
    expect(classifyQueryIntent("Describe what is visible in this image.").intent).toBe("image");
    expect(classifyQueryIntent("Which visible details support that description?").intent).toBe("image");
    expect(classifyQueryIntent("Trong ảnh này nhìn thấy gì?").intent).toBe("image");
  });

  it("does not guess ambiguous references with local pronoun rules", () => {
    expect(classifyQueryIntent("vậy đối tượng vừa nói tới có ý nghĩa gì?")).toEqual({ intent: "general", documentScoped: false });
  });
});
