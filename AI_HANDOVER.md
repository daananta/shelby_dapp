# Shelby RAG Explorer — AI Handover

## Mục tiêu hiện tại

DApp browser-first cho phép ví Aptos sở hữu blob Shelby, chọn tài liệu/ảnh để index RAG cục bộ, rồi hỏi bằng Gemini Cloud với key do người dùng nhập. RAG là **bộ nhớ bổ sung**, không thay thế kiến thức chung hay các tool dữ liệu thật.

## Kiến trúc đang chạy (RAG v4)

| Lớp | Vị trí | Vai trò |
| --- | --- | --- |
| Shelby explorer | `frontend/components/ShelbyExplorer.tsx` | Liệt kê, upload và chọn blob để index; có giới hạn, huỷ tiến trình và trạng thái từng blob. |
| RAG store | `frontend/utils/ragOrama.ts`, `frontend/utils/ragTypes.ts` | IndexedDB v4 tách manifest/pages/chunks; Orama chỉ hydrate lười khi query. Commit theo tài liệu là atomic và tách theo ví. |
| Ingestion | `frontend/utils/textExtractor.ts`, `frontend/utils/pdfOcr.ts` | PDF.js dùng parsing worker chính thức; OCR `vie+eng` thích ứng hoặc quét sâu; canvas được giải phóng theo trang. |
| Retrieval | `frontend/utils/queryRouter.ts`, `frontend/utils/embeddingClient.ts` | Exact/fuzzy page lookup deterministic; lexical + Gemini hoặc gateway embedding cho hybrid RAG. |
| Chat/tools | `frontend/components/UnifiedChat.tsx`, `frontend/utils/chatTools.ts` | Route tool trước LLM; giữ 20 tin nhắn gần nhất theo ví; preview ảnh. |
| AI provider | `frontend/utils/aiProvider.ts` | Gemini Cloud cho chat, function calling, vision và OCR cloud; không có local text-generation model. |
| Agent policy | `agent/AGENT.md`, `agent/skills/*/SKILL.md`, `frontend/utils/agentPolicy.ts` | System instruction và skill pack chọn theo intent; hoàn toàn tách khỏi context RAG. |

## Luồng xử lý

1. Khi ví kết nối, ứng dụng lấy blob từ Shelby và đồng bộ inventory.
2. Người dùng chọn **Nạp nhanh** hoặc **Quét sâu**. PDF.js parse PDF trong worker chính thức; text layer được dùng trước, bìa/trang ít chữ được OCR. Gemini chỉ được dùng cho content analysis/OCR khi user bật consent và có key; nếu không, PDF dùng Tesseract trong browser.
3. Manifest/page/chunk được commit atomically vào IndexedDB. Refresh không phải index lại; nạp lại không nhân đôi.
4. Chat chạy query router và tool deterministic trước. Exact quote trả trang trực tiếp, không giao cho LLM phủ nhận.
5. Gemini nhận agent policy + skill scoped trước; RAG evidence chỉ được thêm vào prompt khi intent thuộc dữ liệu người dùng.
5. Với câu hỏi về tài liệu, LLM chỉ khẳng định điều có trong RAG và phải citation. Với kiến thức chung, LLM trả lời bình thường, không citation giả.

## Tool hiện có

- Địa chỉ ví Aptos.
- Số dư APT on-chain.
- Số dư ShelbyUSD bằng FA metadata address/decimals lấy từ Aptos indexer.
- Account info on-chain (sequence number, authentication key).
- Liệt kê blob Shelby.
- Liệt kê sách PDF theo manifest (title, filename, page count, blob link).
- Liệt kê/hiển thị ảnh blob đã index, bao gồm coreference như “hiển thị nó”.
- Phép tính cơ bản an toàn và các câu nhận diện/hội thoại cơ bản.

## Các invariant quan trọng

- Không dùng `VITE_GEMINI_API_KEY`. Người dùng nhập key, xác thực rồi key chỉ được lưu trong `sessionStorage` của tab; có nút xoá.
- RAG và lịch sử chat **tách theo wallet address**. Đổi ví xoá RAG của ví cũ khỏi runtime browser để không lộ dữ liệu chéo.
- Không đưa toàn bộ ảnh vào mỗi prompt. Ảnh chỉ đính kèm/preview khi liên quan.
- Retrieval phải lọc modality: câu sách/PDF chỉ nhận text chunks; câu ảnh chỉ nhận image descriptions.
- Title phải có provenance/confidence. Không lấy heading nội dung như `TIỂU TỰ` làm title; user override luôn được khóa.
- State v3 được migrate thành `upgrade_required`; phải nạp lại PDF một lần để có page store v4.
- `*.shelby-rag.json` là backup portable không mã hóa: manifest/page/chunk được import atomic và có thể mang theo embedding đã tạo. Chỉ upload sau khi user xác nhận nội dung text/vector được chia sẻ lên Shelby.
- PDF bị giới hạn 25 MB, 500 trang, 3.000 chunks; người dùng có thể dừng index. Blob đang index dở không được giữ partial state.
- Dùng `blobNameSuffix` khi SDK trả về; không cắt mất đường dẫn blob.

## Việc cần kiểm thử với dữ liệu thật

1. Kết nối một ví Shelby, thử số dư/account info/blob inventory.
2. Index PDF có heading đánh số, kiểm tra tổng số truyện và truyện theo số.
3. Index ảnh sau khi xác thực Gemini key, kiểm tra preview và “hiển thị nó”.
4. Đổi ví trong cùng browser để xác nhận RAG/chat không lẫn dữ liệu.
5. Kiểm tra lexical retrieval khi tắt Gemini semantic search và gateway retrieval khi server được cấu hình.
6. Với `sach.pdf`, câu `Người ấy thấy Dương Bố...` phải trả trang 12 bằng nhãn **Tra cứu tài liệu**.

## Kiểm tra cục bộ

```bash
npm run lint
npm test
npm run build
npm run test:e2e
```

Bốn lệnh phải pass trước khi bàn giao. `npm run check` chạy toàn bộ lint, unit/integration, production build và browser E2E.
