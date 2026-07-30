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

test("keeps Gemini quota permissions explicit and previews indexing calls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await expect(page.getByTestId("wallet-runtime")).toBeVisible();

  await page.getByRole("tab", { name: "Cấu hình", exact: true }).click();
  const chatSwitch = page.getByRole("switch", { name: "Dùng Gemini cho trò chuyện", exact: true });
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

test("replaces an exhausted Gemini key instead of retaining it after a 429", async ({ page }) => {
  let providerState: "limited" | "ready" = "limited";
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    if (providerState === "limited") {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for this project" } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: "OK" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await page.getByRole("button", { name: "Kết nối AI", exact: true }).click();
  const keyInput = page.getByPlaceholder("Dán Gemini API key…");
  await keyInput.fill("test-project-a-key-1111");
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();
  await expect(page.getByText(/Key …1111 chưa được kích hoạt.*dùng chung quota/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBeNull();

  providerState = "ready";
  await keyInput.fill("test-project-b-key-2222");
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();
  await expect(page.getByText("✓ Key …2222 hoạt động với gemini-2.5-flash.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("shelby-rag-explorer.gemini-api-key"))).toBe("test-project-b-key-2222");
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
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as any;
    if (request.url().includes(":streamGenerateContent")) {
      const responses = (body?.contents ?? [])
        .flatMap((content: any) => content?.parts ?? [])
        .map((part: any) => part?.functionResponse)
        .filter(Boolean);
      const latestResponse = responses.at(-1);
      if (latestResponse?.name === "refresh_wallet_blob_inventory") {
        refreshPayloads.push(latestResponse.response);
        toolTurns += 1;
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({
            candidates: [{
              index: 0,
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [{ functionCall: { name: "get_wallet_blob_inventory", args: { detail: "count" } } }],
              },
            }],
          })}\n\n`,
        });
        return;
      }
      if (latestResponse?.name === "get_wallet_blob_inventory") {
        inventoryPayloads.push(latestResponse.response);
        toolTurns += 1;
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({
            candidates: [{
              index: 0,
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [{ text: "Tôi vừa cập nhật từ Shelby: ví này hiện có 3 blob." }],
              },
            }],
          })}\n\n`,
        });
        return;
      }
    }

    const declarations = (body?.tools ?? []).flatMap((tool: any) => tool?.functionDeclarations ?? []);
    if (declarations.some((declaration: any) => declaration.name === "refresh_wallet_blob_inventory")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidates: [{
            index: 0,
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ functionCall: { name: "refresh_wallet_blob_inventory", args: {} } }],
            },
          }],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: "OK" }] } }],
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await page.getByRole("button", { name: "Kết nối AI", exact: true }).click();
  await page.getByPlaceholder("Dán Gemini API key…").fill("live-refresh-test-key-4444");
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();
  await expect(page.getByText("✓ Key …4444 hoạt động với gemini-2.5-flash.", { exact: true })).toBeVisible();

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
  await page.route("https://generativelanguage.googleapis.com/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as any;
    if (request.url().includes(":streamGenerateContent")) {
      const functionResponses = (body?.contents ?? [])
        .flatMap((content: any) => content?.parts ?? [])
        .map((part: any) => part?.functionResponse)
        .filter(Boolean);
      const inventoryResponse = functionResponses.find((response: any) => response.name === "get_wallet_blob_inventory");
      if (inventoryResponse?.response) {
        returnedInventoryPayloads.push(inventoryResponse.response);
        if (typeof inventoryResponse.response.count === "number") returnedCounts.push(inventoryResponse.response.count);
      }
      const searchResponse = functionResponses.find((response: any) => response.name === "search_user_knowledge");
      if (searchResponse?.response) blockedSearchResponses.push(searchResponse.response);
      const text = inventoryResponse
        ? "Theo lần làm mới gần nhất, ví này có 2 blob."
        : "Tôi đã tìm trong RAG nhưng không có bằng chứng.";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text }] } }],
        })}\n\n`,
      });
      return;
    }

    const declarations = (body?.tools ?? []).flatMap((tool: any) => tool?.functionDeclarations ?? []);
    if (declarations.some((declaration: any) => declaration.name === "get_wallet_blob_inventory")) {
      agentTurns += 1;
      if (agentTurns === 3) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            candidates: [{
              index: 0,
              finishReason: "STOP",
              content: { role: "model", parts: [{ text: "Chắc chắn rồi, không cần kiểm tra lại." }] },
            }],
          }),
        });
        return;
      }
      const functionCall = agentTurns === 1
        ? { name: "get_wallet_blob_inventory", args: { detail: "count" } }
        : { name: "search_user_knowledge", args: { query: "xác nhận số blob" } };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidates: [{
            index: 0,
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ functionCall }],
            },
          }],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: "OK" }] } }],
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Kết nối ví để bắt đầu", exact: true }).first().click();
  await page.getByRole("button", { name: "Kết nối AI", exact: true }).click();
  await page.getByPlaceholder("Dán Gemini API key…").fill("agent-tool-test-key-3333");
  await page.getByRole("button", { name: "Lưu & kiểm tra", exact: true }).click();
  await expect(page.getByText("✓ Key …3333 hoạt động với gemini-2.5-flash.", { exact: true })).toBeVisible();

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
