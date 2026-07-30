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
