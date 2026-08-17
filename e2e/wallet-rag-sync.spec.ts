import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Keep the existing functional assertions in Vietnamese while smoke.spec.ts
  // independently verifies the default English experience and persistence.
  await page.addInitScript(() => {
    localStorage.setItem("shelby-rag-explorer.language", "vi");
    (window as any).__SHELBY_E2E__ = true;
  });
});

async function mockQwenDocumentAnswer(page: Page, answer: string) {
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    const latestTool = [...(body?.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: latestTool
          ? { role: "assistant", content: answer }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "knowledge-call",
                type: "function",
                function: {
                  name: "search_user_knowledge",
                  arguments: JSON.stringify({ query: "Hệ thống kết nối mạng lưu trữ phi tập trung Shelby" }),
                },
              }],
            },
      }),
    });
  });
}

test("mocks wallet connection and verifies RAG sync dashboard renders", async ({ page }) => {
  await page.goto("/");

  // 1. Click "Kết nối ví để bắt đầu" on the Landing page
  const startConnectBtn = page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first();
  await expect(startConnectBtn).toBeVisible();
  await startConnectBtn.click();

  // 2. Wait for the wallet workspace runtime to load
  await expect(page.getByTestId("wallet-runtime")).toBeVisible();

  // 3. The internal E2E wallet makes the dashboard render deterministically.
  await expect(page.getByText("Kho dữ liệu Shelby", { exact: false })).toBeVisible();
  await expect(page.getByText("Trợ lý tri thức", { exact: false })).toBeVisible();
  await expect(page.getByTestId("rag-lifecycle")).toBeVisible();
  await expect(page.getByPlaceholder("Hỏi kiến thức chung hoặc dùng công cụ…")).toBeEnabled();

  await page.getByRole("tab", { name: "Sao lưu", exact: true }).click();
  await expect(page.getByTestId("memory-capsule")).toBeVisible();
  await expect(page.getByText("Bản sao kho tri thức", { exact: true })).toBeVisible();
  await expect(page.getByText("Bản sao không chứa Gemini API key", { exact: false })).toBeVisible();
});

test("keeps all three model choices visible on a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();

  const selector = page.getByTestId("chat-model-selector");
  await expect(selector).toBeVisible();
  const options = selector.getByRole("radio");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toContainText("Qwen 3.7 Flash");
  await expect(options.nth(1)).toContainText("Qwen 3.8 Flash");
  await expect(options.nth(2)).toContainText("Gemini");
  await options.nth(0).focus();
  await options.nth(0).press("ArrowRight");
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("shelby-rag-explorer.hosted-model"))).toBe("qwen/qwen3.8-max-free");
  await options.nth(1).press("ArrowLeft");
  await expect(options.nth(0)).toHaveAttribute("aria-checked", "true");
  expect(await selector.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("presents preserved Testnet data as a separate archive from ShelbyNet", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const owner = "testnet:0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("shelby-rag-explorer-v5", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const manifests = db.createObjectStore("manifests", { keyPath: "id" });
        manifests.createIndex("owner", "owner");
        manifests.createIndex("ownerSource", ["owner", "source"], { unique: true });
        const pages = db.createObjectStore("pages", { keyPath: "id" });
        pages.createIndex("owner", "owner");
        pages.createIndex("documentId", "documentId");
        const chunks = db.createObjectStore("chunks", { keyPath: "id" });
        chunks.createIndex("owner", "owner");
        chunks.createIndex("documentId", "documentId");
        db.createObjectStore("workspace", { keyPath: "id" });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("manifests", "readwrite");
        transaction.objectStore("manifests").put({
          id: `${owner}:legacy.txt`,
          owner,
          source: "legacy.txt",
          displayName: "legacy.txt",
          status: "indexed",
        });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();

  await expect(page.getByText("Chưa có kho ShelbyNet trên thiết bị", { exact: true })).toBeVisible();
  await expect(page.getByText("Kho Testnet trước đây được giữ riêng và không được dùng trong workspace này.", { exact: false })).toBeVisible();
  await expect(page.getByText("Kho Testnet được tách riêng", { exact: true })).toBeVisible();
  await expect(page.getByText("Kho trên thiết bị đang ở Shelby Testnet", { exact: true })).toHaveCount(0);
});

test("desktop workspace keeps both panels usable without scrolling the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByTestId("wallet-runtime")).toBeVisible();

  const knowledgeBox = await page.getByTestId("knowledge-panel").boundingBox();
  const chatBox = await page.getByTestId("chat-panel").boundingBox();
  expect(knowledgeBox?.width ?? 0).toBeGreaterThan(450);
  expect(chatBox?.width ?? 9999).toBeLessThan(850);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);

  const syncButton = page.getByRole("button", { name: "Đồng bộ", exact: true });
  await expect(syncButton).toBeDisabled();
});

test("small mobile screens keep the document list usable without horizontal clipping", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByTestId("wallet-runtime")).toBeVisible();
  const listBox = await page.getByTestId("blob-list").boundingBox();
  expect(listBox?.height ?? 0).toBeGreaterThanOrEqual(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.getByText("Hướng dẫn Shelby RAG (Public)", { exact: true })).toBeVisible();
});

test("keeps AI chat and optional Gemini indexing permissions explicit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByTestId("wallet-runtime")).toBeVisible();

  await page.getByRole("tab", { name: "Cấu hình", exact: true }).click();
  const chatSwitch = page.getByRole("switch", { name: "Bật trò chuyện với AI", exact: true });
  const contentSwitch = page.getByRole("switch", { name: "Dùng Gemini để đọc nội dung khi tạo RAG", exact: true });
  const semanticSwitch = page.getByRole("switch", { name: "Tạo tìm kiếm theo ý nghĩa", exact: true });
  await expect(chatSwitch).toHaveAttribute("aria-checked", "true");
  await expect(contentSwitch).toHaveAttribute("aria-checked", "false");
  await expect(semanticSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Khi chat, AI vẫn có thể xem ảnh đã index nếu bạn yêu cầu.", { exact: false })).toBeVisible();
  await expect(page.getByText("chỉ các đoạn trích hoặc ảnh đã index cần cho câu trả lời", { exact: false })).toBeVisible();

  await contentSwitch.click();
  await semanticSwitch.click();
  await expect(contentSwitch).toHaveAttribute("aria-checked", "true");
  await expect(semanticSwitch).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("shelby-rag-explorer.gemini-usage-v1") ?? "{}"))).toEqual({ chat: true, contentAnalysis: true, semanticSearch: true });

  await page.getByRole("tab", { name: "Tài liệu", exact: true }).click();
  await expect(page.getByText("Ước tính trước khi tạo RAG", { exact: true })).toBeVisible();
  await expect(page.getByText("Chat không nằm trong con số này", { exact: false })).toBeVisible();

  await page.getByRole("tab", { name: "Cấu hình", exact: true }).click();
  await chatSwitch.click();
  await expect(page.getByText("Chat AI đang tắt để tiết kiệm quota", { exact: true })).toBeVisible();
});

test("mock workspace saves and reads back a knowledge backup without Clay WASM", async ({ page }) => {
  await mockQwenDocumentAnswer(page, "Câu này nằm ở trang 1/1 của tài liệu [S1].");
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Tạo RAG local (1)", exact: true })).toBeVisible();
  await expect(page.getByText("MỚI", { exact: true })).toBeVisible();
  await expect(page.getByText("1 cần xử lý", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tạo RAG local (1)", exact: true }).click();
  await expect(page.getByRole("button", { name: "RAG local đã cập nhật", exact: true })).toBeVisible();
  await expect(page.getByText("Đã có RAG · 1 chunks", { exact: true })).toBeVisible();
  await expect(page.getByText("MỚI", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Sao lưu Bản sao cần cập nhật", exact: true }).click();
  const announcedFolderName = await page.getByTestId("backup-folder-name").textContent();
  const announcedBlobName = await page.getByTestId("backup-blob-name").textContent();
  expect(announcedFolderName).toMatch(/^rag-hot\/.*\/$/);
  expect(announcedBlobName).toBe("snapshot.shelby-hot-rag.pack");
  await page.getByTestId("memory-capsule").getByRole("button", { name: "Lưu kho lên Shelby", exact: true }).click();

  await expect(page.getByTestId("memory-capsule").getByRole("button", { name: "Bản sao đã cập nhật", exact: true })).toBeVisible();
  await expect(page.getByTestId("memory-capsule").getByText(`${announcedFolderName}${announcedBlobName}`, { exact: true })).toBeVisible();
  await expect(page.getByTestId("memory-capsule").getByRole("button", { name: "Cập nhật 1 blob thay đổi", exact: true })).toHaveCount(0);
  await expect(page.getByText("Đã lưu trong phiên trình duyệt; chưa gửi giao dịch lên Shelby thật.", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("memory-capsule").getByRole("button", { name: "Xóa RAG trên máy", exact: true }).click();
  await expect(page.getByText("Đọc từ Shelby", { exact: true })).toBeVisible();
  await expect(page.getByTestId("memory-capsule").getByText("Đã bật tra cứu trực tiếp từ Shelby", { exact: true })).toBeVisible();

  const chatInput = page.getByPlaceholder("Hỏi về dữ liệu đã nạp…");
  await chatInput.fill('Câu "Hệ thống này kết nối mạng lưu trữ phi tập trung Shelby" nằm ở trang nào?');
  await chatInput.press("Enter");
  await expect(page.getByText("Câu này nằm ở trang 1/1 của tài liệu", { exact: false })).toBeVisible();
});

test("creates an honest Answer Receipt from a cited local result", async ({ page }) => {
  await mockQwenDocumentAnswer(page, "Câu này nằm ở trang 1/1 của tài liệu [S1].");
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await page.getByRole("button", { name: "Tạo RAG local (1)", exact: true }).click();
  await expect(page.getByRole("button", { name: "RAG local đã cập nhật", exact: true })).toBeVisible();

  const chatInput = page.getByPlaceholder("Hỏi về dữ liệu đã nạp…");
  await chatInput.fill('Câu "Hệ thống này kết nối mạng lưu trữ phi tập trung Shelby" nằm ở trang nào?');
  await chatInput.press("Enter");
  await expect(page.getByRole("button", { name: "Tạo Phiếu kiểm chứng", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Tạo Phiếu kiểm chứng", exact: true }).click();

  await expect(page.getByTestId("answer-receipt")).toBeVisible();
  await expect(page.getByTestId("receipt-overall-level").getByText("Có dấu vết trong kho trên máy", { exact: true })).toBeVisible();
  await expect(page.getByText(/không xác thực tác giả.*không chứng minh mọi suy luận/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Xem Phiếu kiểm chứng", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tải phiếu", exact: true })).toBeVisible();
});

test("keeps a temporarily limited Gemini key locally and accepts it on retry", async ({ page }) => {
  let providerState: "limited" | "ready" | "invalid" = "limited";
  let observedApiKey = "";
  let observedThinkingBudget: number | undefined;
  let qwenRequests = 0;
  let observedHostedModel = "";
  const authorizationKey = "AQ.mock-project-key-2222";
  page.on("request", (request) => {
    if (request.url().includes("/api/ai/v1/chat")) qwenRequests += 1;
  });
  await page.route("**/api/ai/v1/chat", async (route) => {
    observedHostedModel = route.request().postDataJSON()?.model ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { role: "assistant", content: "Qwen 3.7 đang trả lời cuộc trò chuyện này." },
      }),
    });
  });
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    observedApiKey = route.request().headers()["x-goog-api-key"] ?? "";
    if (providerState === "limited") {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for this project" } }),
      });
      return;
    }
    if (providerState === "invalid") {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "API key not valid" } }),
      });
      return;
    }
    if (route.request().method() !== "GET") {
      observedThinkingBudget = route.request().postDataJSON()?.generationConfig?.thinkingConfig?.thinkingBudget;
      const streamedPayload = {
        candidates: [{
          content: {
            role: "model",
            parts: [{ text: "Gemini 2.5 đang trả lời cuộc trò chuyện này." }],
          },
          finishReason: "STOP",
          index: 0,
        }],
      };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify(streamedPayload)}\n\n`,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [{
          name: "models/gemini-2.5-flash",
          supportedGenerationMethods: ["generateContent"],
        }],
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  const modelOptions = page.getByRole("radiogroup", { name: "Mô hình trò chuyện" }).getByRole("radio");
  await expect(modelOptions).toHaveCount(3);
  await expect(modelOptions.nth(0)).toContainText("Qwen 3.7 Flash");
  await expect(modelOptions.nth(1)).toContainText("Qwen 3.8 Flash");
  await expect(modelOptions.nth(2)).toContainText("Gemini");
  await expect(modelOptions.nth(0)).toHaveAttribute("aria-checked", "true");

  const geminiOption = page.getByRole("radio", { name: /Gemini/ });
  await geminiOption.click();
  const keyInput = page.getByPlaceholder("Dán Gemini API key…");
  await expect(keyInput).toBeFocused();
  await keyInput.fill(`  ${authorizationKey}  `);
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();
  await expect(page.getByText(/Key …2222 đã được lưu cục bộ.*không bị từ chối.*Thử lại/)).toBeVisible();
  expect(observedApiKey).toBe(authorizationKey);
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBe(authorizationKey);
  await expect(page.getByRole("button", { name: "Thử lại", exact: true })).toBeVisible();

  await keyInput.fill("AQ.unsaved-draft-key");
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBe(authorizationKey);
  await expect(page.getByRole("button", { name: "Lưu & kiểm tra", exact: true })).toBeVisible();
  await keyInput.fill(authorizationKey);

  providerState = "ready";
  await page.getByRole("button", { name: "Thử lại", exact: true }).click();
  await expect(page.getByText("✓ Key …2222 đã được Gemini chấp nhận; gemini-2.5-flash khả dụng.", { exact: true })).toBeVisible();
  await expect(geminiOption).toHaveAttribute("data-key-state", "ready");
  await expect(geminiOption).toHaveAttribute("aria-checked", "true");
  await expect(geminiOption).toHaveAttribute("aria-expanded", "true");
  expect(observedApiKey).toBe(authorizationKey);
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBe(authorizationKey);

  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Xin chào");
  await chatInput.press("Enter");
  await expect(page.getByText("Gemini 2.5 đang trả lời cuộc trò chuyện này.", { exact: true })).toBeVisible();
  expect(qwenRequests).toBe(0);
  expect(observedThinkingBudget).toBe(0);

  const qwen37Option = page.getByRole("radio", { name: /Qwen 3\.7 Flash/ });
  await qwen37Option.click();
  await expect(qwen37Option).toHaveAttribute("aria-checked", "true");
  await chatInput.fill("Tiếp tục bằng Qwen");
  await chatInput.press("Enter");
  await expect(page.getByText("Qwen 3.7 đang trả lời cuộc trò chuyện này.", { exact: true })).toBeVisible();
  expect(qwenRequests).toBe(1);
  expect(observedHostedModel).toBe("qwen/qwen3.7-flash");
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBe(authorizationKey);

  providerState = "invalid";
  await geminiOption.click();
  await keyInput.fill("AQ.invalid-replacement");
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();
  await expect(page.getByText(/Key trước đó …2222 vẫn hoạt động/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBe(authorizationKey);

});

test("rejects only a Gemini key that the provider explicitly marks invalid", async ({ page }) => {
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "API key not valid" } }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await page.getByRole("radio", { name: /Gemini/ }).click();
  await page.getByPlaceholder("Dán Gemini API key…").fill("AQ.invalid-key");
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();

  await expect(page.getByText(/Không thể dùng key.*không hợp lệ|không có quyền/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBeNull();
});

test("lets hosted AI phrase inventory observations without requiring a Gemini key", async ({ page }) => {
  let geminiRequests = 0;
  let hostedTurns = 0;
  page.on("request", (request) => {
    if (request.url().includes("generativelanguage.googleapis.com")) geminiRequests += 1;
  });
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    const latestTool = [...(body?.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
    hostedTurns += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: latestTool
          ? { role: "assistant", content: "Theo dữ liệu ứng dụng vừa cung cấp, ví này có 2 blob." }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `inventory-${hostedTurns}`,
                type: "function",
                function: { name: "get_wallet_blob_inventory", arguments: "{\"detail\":\"count\"}" },
              }],
            },
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByText("Hướng dẫn Shelby RAG (Public)", { exact: true })).toBeVisible();

  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Ví này có bao nhiêu blob trên Shelby?");
  await chatInput.press("Enter");
  await expect(page.getByText("Theo dữ liệu ứng dụng vừa cung cấp, ví này có 2 blob.", { exact: true })).toHaveCount(1);

  await chatInput.fill("chắc chưa?");
  await chatInput.press("Enter");
  await expect(page.getByText("Theo dữ liệu ứng dụng vừa cung cấp, ví này có 2 blob.", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Hãy kết nối Gemini API key", { exact: false })).toHaveCount(0);
  expect(geminiRequests).toBe(0);
  expect(hostedTurns).toBe(4);
});

test("keeps the visible inventory answer as context for a natural follow-up", async ({ page }) => {
  const requestMessages: any[][] = [];
  let hostedTurns = 0;
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    const messages = body?.messages ?? [];
    requestMessages.push(messages);
    const latestTool = [...messages].reverse().find((message: any) => message?.role === "tool");
    const latestUser = [...messages].reverse().find((message: any) => message?.role === "user")?.content;
    let toolPayload: Record<string, unknown> = {};
    if (latestTool?.content) {
      try {
        toolPayload = JSON.parse(latestTool.content);
      } catch {
        toolPayload = {};
      }
    }
    const examples = Array.isArray(toolPayload.examples)
      ? toolPayload.examples.filter((value): value is string => typeof value === "string")
      : [];
    const followUpAnswer = examples.length > 0
      ? `Hai blob trong ví là ${examples.join(" và ")} (${String(toolPayload.count ?? examples.length)} blob).`
      : "Tôi chưa nhận được tên blob từ Shelby.";
    hostedTurns += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: latestTool
          ? {
              role: "assistant",
              content: latestUser === "nó là gì"
                ? followUpAnswer
                : "Hiện tại, ví của bạn đang có 2 blob.",
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `inventory-context-${hostedTurns}`,
                type: "function",
                function: {
                  name: "get_wallet_blob_inventory",
                  arguments: latestUser === "nó là gì" ? "{\"detail\":\"sample\"}" : "{\"detail\":\"count\"}",
                },
              }],
            },
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  const chatInput = page.getByLabel("Nhập câu hỏi");

  await chatInput.fill("chào, tôi đang có bao nhiêu blob");
  await chatInput.press("Enter");
  await expect(page.getByText("Hiện tại, ví của bạn đang có 2 blob.", { exact: true })).toBeVisible();

  await chatInput.fill("nó là gì");
  await chatInput.press("Enter");
  await expect(page.getByText("Hai blob trong ví là HuongDan_Shelby_RAG.txt và KeHoach_Shelby_2026.txt (2 blob).", { exact: true })).toBeVisible();

  const followUpRequest = requestMessages.find((messages) => (
    messages.some((message: any) => message?.role === "user" && message?.content === "nó là gì")
    && messages.some((message: any) => message?.role === "assistant" && message?.content === "Hiện tại, ví của bạn đang có 2 blob.")
  ));
  expect(followUpRequest).toBeTruthy();
  const serialized = JSON.stringify(followUpRequest);
  expect(serialized).not.toContain("observedAt");
  expect(serialized).not.toContain("fetchedAt");
  expect(serialized).not.toContain("Previous Shelby inventory observation");
  expect(hostedTurns).toBe(4);
});

test("lets the agent read the exact Aptos wallet connected to the app", async ({ page }) => {
  const expectedAddress = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
  const walletPayloads: any[] = [];
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    const latestTool = [...(body?.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
    if (latestTool) walletPayloads.push(JSON.parse(latestTool.content));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: latestTool
          ? { role: "assistant", content: `Địa chỉ ví Aptos đang kết nối là ${expectedAddress}.` }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "wallet-address-call",
                type: "function",
                function: { name: "get_connected_wallet", arguments: "{\"detail\":\"address\"}" },
              }],
            },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("địa chỉ ví của tôi là gì");
  await chatInput.press("Enter");

  await expect(page.getByText(`Địa chỉ ví Aptos đang kết nối là ${expectedAddress}.`, { exact: true })).toBeVisible();
  expect(walletPayloads).toEqual([
    expect.objectContaining({
      ok: true,
      kind: "wallet_address",
      wallet: expect.objectContaining({ connected: true, address: expectedAddress }),
    }),
  ]);
});

test("lets the agent refresh Shelby live and reread the bounded inventory payload", async ({ page }) => {
  const refreshPayloads: any[] = [];
  const inventoryPayloads: any[] = [];
  let toolTurns = 0;
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    const latestTool = [...(body?.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
    if (latestTool) {
      const payload = JSON.parse(latestTool.content);
      const previousCall = [...(body?.messages ?? [])].reverse()
        .find((message: any) => message?.role === "assistant" && message?.tool_calls)
        ?.tool_calls?.find((call: any) => call.id === latestTool.tool_call_id);
      if (previousCall?.function?.name === "refresh_wallet_blob_inventory") {
        refreshPayloads.push(payload);
        toolTurns += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "inventory-call", type: "function", function: { name: "get_wallet_blob_inventory", arguments: "{\"detail\":\"count\"}" } }],
          } }),
        });
        return;
      }
      inventoryPayloads.push(payload);
      toolTurns += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: { role: "assistant", content: "Tôi vừa cập nhật từ Shelby: ví này hiện có 2 blob." } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "refresh-call", type: "function", function: { name: "refresh_wallet_blob_inventory", arguments: "{}" } }],
      } }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByText("Hướng dẫn Shelby RAG (Public)", { exact: true })).toBeVisible();
  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Kiểm tra số blob hiện tại của ví tôi");
  await chatInput.press("Enter");

  await expect(page.getByText("Tôi vừa cập nhật từ Shelby: ví này hiện có 2 blob.", { exact: true })).toBeVisible();
  expect(toolTurns).toBe(2);
  expect(refreshPayloads).toEqual([
    expect.objectContaining({ ok: true }),
  ]);
  expect(refreshPayloads.every((payload) => (
    !("count" in payload)
    && !("names" in payload)
    && !("examples" in payload)
    && !("source" in payload)
    && !("fetchedAt" in payload)
    && !("refreshedAt" in payload)
  ))).toBe(true);
  expect(inventoryPayloads).toEqual([
    expect.objectContaining({ ok: true, count: 2 }),
  ]);
  expect(inventoryPayloads.every((payload) => (
    !("names" in payload)
    && !("examples" in payload)
    && !("status" in payload)
    && !("freshness" in payload)
    && !("fetchedAt" in payload)
    && !("observedAt" in payload)
  ))).toBe(true);
});

test("lets the model choose a free-form blob filename filter", async ({ page }) => {
  const inventoryPayloads: any[] = [];
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    const latestTool = [...(body?.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
    if (latestTool) {
      const payload = JSON.parse(latestTool.content);
      inventoryPayloads.push(payload);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          message: {
            role: "assistant",
            content: "Theo danh sách ví vừa cung cấp, hiện không có blob nào có tên chứa “anime”.",
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "anime-inventory",
            type: "function",
            function: {
              name: "get_wallet_blob_inventory",
              arguments: JSON.stringify({ detail: "sample", nameQuery: "anime" }),
            },
          }],
        },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByText("Hướng dẫn Shelby RAG (Public)", { exact: true })).toBeVisible();
  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Tôi có blob anime nào?");
  await chatInput.press("Enter");
  await expect(page.getByText("Theo danh sách ví vừa cung cấp, hiện không có blob nào có tên chứa “anime”.", { exact: true })).toBeVisible();
  await expect(page.getByText("Dữ liệu Shelby", { exact: true })).toBeVisible();
  expect(inventoryPayloads).toEqual([
    expect.objectContaining({
      ok: true,
      nameQuery: "anime",
      matchedCount: 0,
      matches: [],
    }),
  ]);
});

test("lets Qwen choose runtime vision for a follow-up while RAG image processing stays off", async ({ page }) => {
  const visionPayloads: any[] = [];
  const toolPayloads: any[] = [];
  const agentPayloads: any[] = [];
  await page.route("**/runtime-vision-anime.gif", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/gif",
      body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    });
  });
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    if (body?.mode === "vision") {
      visionPayloads.push(body);
      const asksForSupportingDetails = String(body.question).includes("small blue square");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          message: {
            role: "assistant",
            content: asksForSupportingDetails
              ? "The blue color, square outline, and plain background support that description."
              : "The image shows a small blue square on a plain background.",
          },
        }),
      });
      return;
    }

    const messages = body?.messages ?? [];
    agentPayloads.push(body);
    const latestUserText = String([...messages].reverse().find((message: any) => message?.role === "user")?.content ?? "");
    const latestTool = [...messages].reverse().find((message: any) => message?.role === "tool");
    if (latestTool) {
      toolPayloads.push(JSON.parse(latestTool.content));
      const previousCall = [...messages].reverse()
        .find((message: any) => message?.role === "assistant" && message?.tool_calls)
        ?.tool_calls?.find((call: any) => call.id === latestTool.tool_call_id);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          message: {
            role: "assistant",
            content: previousCall?.function?.name === "analyze_indexed_image"
              ? latestUserText.includes("Which visible details support that description?")
                ? "The blue color, square outline, and plain background support that description."
                : "It shows a small blue square on a plain background."
              : "Here is anime2.jpeg from your indexed images.",
          },
        }),
      });
      return;
    }

    const supportingDetailsFollowUp = latestUserText.includes("Which visible details support that description?");
    const describeFollowUp = latestUserText.includes("Describe what is visible") || supportingDetailsFollowUp;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: supportingDetailsFollowUp ? "vision-evidence-call" : describeFollowUp ? "vision-call" : "preview-call",
            type: "function",
            function: describeFollowUp
              ? {
                name: "analyze_indexed_image",
                arguments: JSON.stringify(supportingDetailsFollowUp
                  ? {
                    source: "anime2.jpeg",
                    question: "Which visible details support that this image shows a small blue square on a plain background?",
                  }
                  : { question: "Describe what is visible in this image." }),
              }
              : { name: "inspect_application", arguments: JSON.stringify({ query: "Show anime2.jpeg" }) },
          }],
        },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByTestId("wallet-runtime")).toBeVisible();
  const indexedImages = await page.evaluate(async () => {
    // @ts-expect-error Vite serves this browser-only module during E2E.
    const rag = await import("/frontend/utils/ragOrama.ts");
    const owner = "shelbynet:0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const source = "anime2.jpeg";
    const documentId = `${owner}:${source}`;
    const imageUrl = `${window.location.origin}/runtime-vision-anime.gif`;
    await rag.setActiveRagOwner(owner);
    await rag.setShelbyBlobInventory(owner, [source], [source]);
    await rag.replaceDocument({
      manifest: { id: documentId, owner, source, displayName: source, revision: "vision-e2e", blobUrl: imageUrl, mimeType: "image/gif", type: "image", aliases: [], authors: [], pageCount: 0, chunkCount: 1, ocrCoverage: 0, embeddingStatus: "unavailable", status: "indexed", indexedAt: Date.now() },
      pages: [],
      chunks: [{ id: `${documentId}:chunk:0`, owner, documentId, source, displayName: source, type: "image", text: `[Image]\nFile name: ${source}`, normalizedText: source, pageNumber: 0, totalPages: 0, imageUrl }],
      stories: [],
    });
    return rag.getImageDocuments();
  });
  expect(indexedImages).toEqual([
    expect.objectContaining({ source: "anime2.jpeg", url: expect.stringContaining("/runtime-vision-anime.gif") }),
  ]);

  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Show me anime2.jpeg from my indexed Shelby blobs.");
  await chatInput.press("Enter");
  await expect(page.getByText("Here is anime2.jpeg from your indexed images.", { exact: true })).toBeVisible();

  await chatInput.fill("Describe what is visible in this image.");
  await chatInput.press("Enter");
  await expect(page.getByText("It shows a small blue square on a plain background.", { exact: true })).toBeVisible();

  await chatInput.fill("Which visible details support that description?");
  await chatInput.press("Enter");
  await expect(page.getByText(
    "The blue color, square outline, and plain background support that description.",
    { exact: true },
  )).toBeVisible();
  expect(toolPayloads).toEqual([
    expect.objectContaining({ ok: true, kind: "show_images", referencedSources: ["anime2.jpeg"] }),
    expect.objectContaining({ ok: true, kind: "image_analysis", referencedSources: ["anime2.jpeg"] }),
    expect.objectContaining({ ok: true, kind: "image_analysis", referencedSources: ["anime2.jpeg"] }),
  ]);
  await expect(page.getByText("AI · Hình ảnh", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Dữ liệu từ ứng dụng", { exact: true })).toHaveCount(0);
  expect(visionPayloads).toHaveLength(2);
  const supportingDetailsRequest = agentPayloads.find((payload) => (
    [...(payload.messages ?? [])].reverse()
      .find((message: any) => message?.role === "user")
      ?.content === "Which visible details support that description?"
  ));
  expect(JSON.stringify(supportingDetailsRequest)).toContain("anime2.jpeg");
  expect(JSON.stringify(supportingDetailsRequest)).toContain("small blue square");
  expect(JSON.stringify(supportingDetailsRequest)).not.toContain("app-provided data");
  expect(JSON.stringify(supportingDetailsRequest)).not.toContain("use the tool to search again");
  expect(visionPayloads[0]).toMatchObject({
    mode: "vision",
    language: "vi",
    question: "Describe what is visible in this image.",
    image: {
      mimeType: "image/gif",
      fileName: "anime2.jpeg",
      data: expect.any(String),
    },
  });
  expect(visionPayloads[1]).toMatchObject({
    mode: "vision",
    language: "vi",
    question: expect.stringContaining("small blue square"),
    image: {
      mimeType: "image/gif",
      fileName: "anime2.jpeg",
      data: expect.any(String),
    },
  });
});
