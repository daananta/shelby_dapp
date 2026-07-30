import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // Keep the existing functional assertions in Vietnamese while smoke.spec.ts
  // independently verifies the default English experience and persistence.
  await page.addInitScript(() => {
    localStorage.setItem("shelby-rag-explorer.language", "vi");
    (window as any).__SHELBY_E2E__ = true;
  });
});

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
  await expect(page.getByText("Tìm thấy câu này ở trang 1/1", { exact: false })).toBeVisible();
});

test("creates an honest Answer Receipt from a cited local result", async ({ page }) => {
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
  const authorizationKey = "AQ.mock-project-key-2222";
  page.on("request", (request) => {
    if (request.url().includes("/api/ai/v1/chat")) qwenRequests += 1;
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
  await page.getByRole("button", { name: "Dùng Gemini", exact: true }).click();
  const keyInput = page.getByPlaceholder("Dán Gemini API key…");
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
  const readyGeminiButton = page.getByRole("button", { name: "Gemini sẵn sàng", exact: true });
  await expect(readyGeminiButton).toHaveAttribute("data-state", "ready");
  await expect(readyGeminiButton).toHaveAttribute("aria-expanded", "true");
  expect(observedApiKey).toBe(authorizationKey);
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBe(authorizationKey);

  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Xin chào");
  await chatInput.press("Enter");
  await expect(page.getByText("Gemini 2.5 đang trả lời cuộc trò chuyện này.", { exact: true })).toBeVisible();
  expect(qwenRequests).toBe(0);
  expect(observedThinkingBudget).toBe(0);

  providerState = "invalid";
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
  await page.getByRole("button", { name: "Dùng Gemini", exact: true }).click();
  await page.getByPlaceholder("Dán Gemini API key…").fill("AQ.invalid-key");
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();

  await expect(page.getByText(/Không thể dùng key.*không hợp lệ|không có quyền/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBeNull();
});

test("confirms the latest blob snapshot without requiring a Gemini key", async ({ page }) => {
  let geminiRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("generativelanguage.googleapis.com")) geminiRequests += 1;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByText("Hướng dẫn Shelby RAG (Public)", { exact: true })).toBeVisible();

  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Ví này có bao nhiêu blob trên Shelby?");
  await chatInput.press("Enter");
  await expect(page.getByText(/Snapshot Shelby được làm mới lúc .* có 2 blob\./)).toHaveCount(1);

  await chatInput.fill("chắc chưa?");
  await chatInput.press("Enter");
  await expect(page.getByText(/Snapshot Shelby được làm mới lúc .* có 2 blob\./)).toHaveCount(2);
  await expect(page.getByText("Hãy kết nối Gemini API key", { exact: false })).toHaveCount(0);
  expect(geminiRequests).toBe(0);
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
        body: JSON.stringify({ message: { role: "assistant", content: "Tôi vừa cập nhật từ Shelby: ví này hiện có 3 blob." } }),
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

  await expect(page.getByText(/Snapshot Shelby được làm mới lúc .* có 2 blob\./)).toBeVisible();
  await expect(page.getByText("Tôi vừa cập nhật từ Shelby: ví này hiện có 3 blob.", { exact: true })).toHaveCount(0);
  expect(toolTurns).toBe(2);
  expect(refreshPayloads).toEqual([
    expect.objectContaining({ ok: true, source: "demo" }),
  ]);
  expect(refreshPayloads.every((payload) => !("count" in payload) && !("names" in payload) && !("examples" in payload))).toBe(true);
  expect(inventoryPayloads).toEqual([
    expect.objectContaining({ ok: true, count: 2, verified: true }),
  ]);
  expect(inventoryPayloads.every((payload) => !("names" in payload) && !("examples" in payload))).toBe(true);
});

test("keeps an inventory follow-up out of RAG even when the model picks the wrong tool", async ({ page }) => {
  let agentTurns = 0;
  const returnedCounts: number[] = [];
  const returnedInventoryPayloads: any[] = [];
  const blockedSearchResponses: any[] = [];
  await page.route("**/api/ai/v1/chat", async (route) => {
    const body = route.request().postDataJSON() as any;
    const latestTool = [...(body?.messages ?? [])].reverse().find((message: any) => message?.role === "tool");
    if (latestTool) {
      const payload = JSON.parse(latestTool.content);
      const previousCall = [...(body?.messages ?? [])].reverse()
        .find((message: any) => message?.role === "assistant" && message?.tool_calls)
        ?.tool_calls?.find((call: any) => call.id === latestTool.tool_call_id);
      if (previousCall?.function?.name === "get_wallet_blob_inventory") {
        returnedInventoryPayloads.push(payload);
        if (typeof payload.count === "number") returnedCounts.push(payload.count);
      } else {
        blockedSearchResponses.push(payload);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: {
          role: "assistant",
          content: previousCall?.function?.name === "get_wallet_blob_inventory"
            ? "Theo lần làm mới gần nhất, ví này có 2 blob."
            : "Tôi đã tìm trong RAG nhưng không có bằng chứng.",
        } }),
      });
      return;
    }

    agentTurns += 1;
    if (agentTurns === 3) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: { role: "assistant", content: "Chắc chắn rồi, không cần kiểm tra lại." } }),
      });
      return;
    }
    const name = agentTurns === 1 ? "get_wallet_blob_inventory" : "search_user_knowledge";
    const args = agentTurns === 1 ? { detail: "count" } : { query: "xác nhận số blob" };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `agent-call-${agentTurns}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      } }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByText("Hướng dẫn Shelby RAG (Public)", { exact: true })).toBeVisible();
  const chatInput = page.getByLabel("Nhập câu hỏi");
  await chatInput.fill("Ví này có bao nhiêu blob trên Shelby?");
  await chatInput.press("Enter");
  await expect(page.getByText("Theo lần làm mới gần nhất, ví này có 2 blob.", { exact: true })).toBeVisible();
  await expect(page.getByText("Dữ liệu Shelby", { exact: true })).toBeVisible();

  await chatInput.fill("chắc chưa?");
  await chatInput.press("Enter");
  await expect(page.getByText(/Snapshot Shelby được làm mới lúc .* có 2 blob\./)).toBeVisible();
  await expect(page.getByText("Tôi đã tìm trong kho dữ liệu", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Tôi đã tìm trong RAG", { exact: false })).toHaveCount(0);
  expect(agentTurns).toBe(2);
  expect(returnedCounts).toEqual([2]);
  expect(returnedInventoryPayloads).toHaveLength(1);
  expect(returnedInventoryPayloads.every((payload) => !("names" in payload) && !("examples" in payload))).toBe(true);
  expect(blockedSearchResponses).toEqual([
    expect.objectContaining({ found: false, evidence: [] }),
  ]);

  await chatInput.fill("xác nhận lại đi");
  await chatInput.press("Enter");
  await expect(page.getByText(/Snapshot Shelby được làm mới lúc .* có 2 blob\./)).toHaveCount(2);
  await expect(page.getByText("Chắc chắn rồi, không cần kiểm tra lại.", { exact: true })).toHaveCount(0);
  expect(agentTurns).toBe(3);
});
