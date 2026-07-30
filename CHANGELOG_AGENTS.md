# Shelby RAG Explorer - Agent Changelog & Guidelines
*Last updated: 2026-07-18*

> [!IMPORTANT]
> **GUIDELINES FOR FUTURE AI AGENTS / CODING ASSISTANTS:**
> Before proposing or making any changes in this repository, you **MUST** read this file to understand the current architecture, components, and the reasoning behind previous design choices. Do not re-introduce local AI models, WebWorkers for E5, or Python agent frameworks, as they have been fully decommissioned per user request.

---

## Architectural Guidelines for Agents

1. **Frontend Architecture & Decoupling:**
   - The main workspace layout resides in [App.tsx](frontend/App.tsx) and the primary workspace container is [ShelbyExplorer.tsx](frontend/components/ShelbyExplorer.tsx).
   - Component logic is modularized inside the `frontend/components/explorer/` folder:
     - `BlobLibrary.tsx`: Handles file metadata editing, selection, and Sandbox purchases.
     - `UploadZone.tsx`: Handles file drop zones, backups, and restores.
     - `RagConfigPanel.tsx`: Manages chunking sizes and OCR selections.
     - `IndexingStepper.tsx`: Visual stepper tracking progress of active indexing tasks.
   - Business logics, state managements, and API coordinates are decoupled into custom React Hooks:
     - `useShelby.ts`: Handles wallet accounts, Faucet Sandbox actions, and Shelby protocol SDK calls.
     - `useRag.ts`: Handles PDF loading, SNIFF checking, local PDF OCR (via Tesseract), RAG index creation, and API vector calls.

2. **Decentralized Image URL Resolution & Persistence:**
   - **Do not** store temporary `blob:` URLs in IndexedDB as a source of truth for display across sessions. Browsers revoke these URLs on reload, causing image elements to break and RAG retrieval pipelines to filter them out due to invalid `imageUrl` references.
   - **Canonical Resolve Rule:** If a file/image has `accessTag === "public"`, always resolve its URL dynamically using `getShelbyBlobUrl(activeOwner, source)` from `utils/shelbyConfig` rather than relying on `manifest.blobUrl` or `chunk.imageUrl` values.

3. **Gemini Conversation Memory & Context Routing:**
   - Chat history uses the standard Google Generative AI `contents` multi-turn format (roles: `user` and `model`) inside `generateCloudAnswer` in `aiProvider.ts` rather than flattening history to string text inside the prompt.
   - If a query refers to a document via pronouns (*"nó"*, *"đó"*, *"này"*, *"cuốn này"*, *"tệp đó"*, v.v.) and the chat history has existing RAG sources, `UnifiedChat.tsx` automatically elevates the query to `documentQuestion = true` to query RAG sources, keeping conversation flow intuitive.

---

## Historical Changes (Changelog)

### [2026-07-18] - Đồng bộ tài liệu và loại bỏ local AI mã chết

#### Changed
- Đồng bộ README, AI handover, hackathon demo và metadata với runtime hiện tại: Gemini Cloud cho chat/vision/semantic embeddings; lexical retrieval và Tesseract OCR vẫn chạy trong browser khi không dùng semantic cloud.
- `npm run check` nay bao gồm browser E2E, đúng với yêu cầu bàn giao.

#### Removed
- Xóa local WebGPU text-generation path không còn được UI gọi, dependency `@huggingface/transformers` và tài liệu ONNX model assets đã lỗi thời.

### [2026-07-11] - Tối ưu hóa RAG, Nâng cấp Trí nhớ & Thu gọn UI

#### Added
- Created [CHANGELOG_AGENTS.md](CHANGELOG_AGENTS.md) (file này) để làm cẩm nang hướng dẫn cho các AI Agent khác khi vào làm việc trong thư mục này.
- Tích hợp thành công cấu trúc tin nhắn đa lượt `contents` (`Content[]`) chuẩn của Gemini API trong [aiProvider.ts](frontend/utils/aiProvider.ts).
- Bổ sung logic định tuyến theo lịch sử hội thoại trong [UnifiedChat.tsx](frontend/components/UnifiedChat.tsx), để AI tự suy luận câu hỏi tiếp nối và chỉ dùng RAG khi dữ liệu người dùng thực sự liên quan.
- Nạp thêm cơ chế giải quyết URL vĩnh viễn cho ảnh public của Shelby (`getShelbyBlobUrl`) trong `ragOrama.ts` để ngăn chặn lỗi mất đường dẫn ảnh xem trước sau khi refresh trang.

#### Changed
- Thu gọn triệt để giao diện của [BlobLibrary.tsx](frontend/components/explorer/BlobLibrary.tsx), chuyển đổi từ định dạng card lớn cồng kềnh sang định dạng hàng ngang (`px-3.5 py-2 flex items-center justify-between`) cực kỳ gọn gàng và hiện đại theo mong muốn của người dùng.
- Thay thế bộ hàm `parseMarkdown` tự viết cũ trong `UnifiedChat.tsx` bằng thư viện chuẩn `react-markdown` và `remark-gfm` để hỗ trợ hiển thị markdown chất lượng cao (bảng biểu, mã nguồn, danh sách).
- Tăng độ sáng và hiệu ứng phát sáng dải màu nền (`animate-gradient`), bổ sung hoạ tiết lưới tọa độ (`linear-gradient`) vào nền của [App.tsx](frontend/App.tsx) để tăng tính thẩm mỹ và cao cấp cho dApp.

#### Removed
- Xóa hoàn toàn các file backend của Python Local Agent ở thư mục gốc (`run_agent.py`, `workflows/`, `nodes/`, `tools/`, `state/`, v.v.) vì người dùng đã xóa AI cục bộ.
- Xóa bỏ tuỳ chọn nạp vector local `local-e5` cùng tiến trình WebWorker và nhãn hiển thị GPU/RAM thừa trong `UnifiedChat.tsx` và `embeddingClient.ts`.
