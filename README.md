# Shelby RAG Explorer

Blob-native DApp: kết nối ví Aptos, liệt kê blob Shelby, nhận diện nội dung trực tiếp từ bytes, tạo hybrid RAG có bằng chứng theo trang và hỏi bằng Cloud AI.

Dự án không đóng gói custom Move contract. Các giao dịch Aptos trong luồng lưu blob gọi contract của giao thức Shelby thông qua Shelby SDK; bytes của tài liệu được gửi riêng tới Shelby RPC.

Xem [HACKATHON_DEMO.md](HACKATHON_DEMO.md) để có pitch, các claim có thể kiểm chứng và luồng demo 90 giây cho giám khảo.

## Chạy dự án

```bash
npm install
npm run dev
```

Kết nối ví đúng Shelby network, chọn blob rồi bấm **Tạo RAG**. Index hiện tại gồm manifest, page text, chunks và embedding provider được lưu trong IndexedDB; refresh không phải nạp lại. Commit theo từng tài liệu là atomic nên huỷ giữa chừng giữ bản cũ, còn nạp lại thay thế thay vì tạo dữ liệu x2.

Shelby lưu dữ liệu dưới dạng blob nhị phân nên pipeline **không tin vào đuôi file**. Sau khi tải blob, app kiểm tra magic bytes để nhận diện PDF/PNG/JPEG/GIF/WebP, nhận diện JSON/HTML/XML/text từ nội dung, và chỉ sau đó mới chọn extractor. Binary/ZIP/Office chưa hỗ trợ sẽ fail-safe thay vì bị decode nhầm thành text.

Chọn những blob cần dùng bằng checkbox, rồi bấm **Tạo RAG**. Có thể dừng tiến trình; các file hoàn tất vẫn giữ index, file đang nạp dở sẽ không được lưu một phần.

Index được gắn với địa chỉ ví đang kết nối. Khi đổi ví, app chỉ hydrate workspace của ví mới, không làm lộ nội dung của ví cũ. Nút **Xóa RAG local** xóa manifest, page text, chunks và lịch sử chat của đúng ví hiện tại trong browser; blob Shelby và workspace của ví khác không bị ảnh hưởng.

Không cần ví để đánh giá cơ chế: từ landing page, chọn **Xem demo evidence**. Demo offline tạo một page index minh họa trong browser và cho phép xác minh citation `tài liệu · trang X/Y · excerpt`; nó tách biệt hoàn toàn khỏi ví và blob Shelby thật.

Khi index PDF, app lưu số trang, tỷ lệ trang có nội dung và heading đánh số (ví dụ `243. NGU CÔNG DỜI NÚI`) để trả lời chính xác hơn về số truyện/câu chuyện cụ thể. Câu hỏi “sách X bao nhiêu trang?” được trả trực tiếp từ page index thay vì để AI đoán. Sau khi nâng cấp, hãy tạo lại RAG cho PDF một lần để tạo metadata này. Lịch sử 20 lượt chat gần nhất và ảnh liên quan cũng được lưu cục bộ trong browser, tách theo địa chỉ ví; dùng **Xoá chat** để xoá.

Manifest PDF lưu title, aliases, confidence và provenance. Bìa/trang ít chữ được OCR local `vie+eng`; heading nội dung không còn được dùng làm tên sách. Có thể sửa title/aliases trên card và bản xác nhận của user không bị ghi đè khi reindex.

Các câu trích dẫn như `câu này ở trang nào "..."` chạy exact/fuzzy lookup trực tiếp trên page store và trả số trang mà không gọi LLM. Câu hỏi diễn đạt khác tài liệu dùng hybrid ranking: lexical score, semantic similarity, token coverage, title/alias boost và giới hạn độ trùng theo trang/tài liệu. PDF text layer được đọc song song tối đa 4 trang; PDF.js vẫn chạy parser worker chính thức.

## Agent policy và gói RAG Shelby

`agent/AGENT.md` định nghĩa hành vi chung của Cloud AI; các `agent/skills/*/SKILL.md` được chọn theo intent (kiến thức chung, tài liệu, wallet/Shelby hoặc ảnh). Chúng được đưa vào system instruction độc lập với RAG. Nhờ đó RAG chỉ là evidence cho câu hỏi về dữ liệu người dùng, không làm Cloud AI trả lời kiểu “không có trong tài liệu” cho kiến thức chung.

Tab **Sao lưu** tạo đúng một Hot RAG blob tại `rag-hot/<snapshot>/snapshot.shelby-hot-rag.pack`. Bên trong blob gồm header cố định, một mục lục nhỏ chứa inventory/từ khóa/vector đại diện, rồi các vùng page/chunk evidence khoảng 384 KB. Mỗi vùng có byte offset, độ dài và SHA-256 riêng.

Khi máy không còn RAG local, chat Range Read header và mục lục trước, chọn khoảng ba vùng phù hợp rồi gọi `ShelbyRPCClient.getBlob({ range })` để stream đúng các byte đó. Tối đa sáu vùng được giữ trong cache ngắn hạn. Chỉ thao tác **Lưu một bản về máy** mới đọc tất cả vùng để khôi phục IndexedDB. Các gói đơn `*.shelby-rag.json` và snapshot `manifest + parts` cũ vẫn được hỗ trợ để người dùng không mất dữ liệu.

Snapshot không chứa API key, private key, model hay lịch sử chat. SHA-256 của từng phần nằm trong tệp chỉ đường; mã Merkle của blob nguồn vẫn đi cùng evidence để Answer Receipt đối chiếu.

## Quyền blob khi tạo RAG

- `public`: tải trực tiếp và index cục bộ.
- `time_lock`: chỉ được đưa vào pipeline sau `unlockAt`/`unlockTime`; thiếu timestamp hoặc chưa đến hạn sẽ bị bỏ qua an toàn.
- `allowlist` và `purchasable`: app vẫn hiển thị policy BCS on-chain (`access_control::query3_bcs`), nhưng luôn loại chúng khỏi hàng đợi Tạo RAG.

Nếu RPC không xác minh được policy, app hiển thị **Không xác minh quyền** và fail-closed: blob không được đếm, tạo RAG hoặc mở link trực tiếp cho đến khi làm mới xác minh thành công. App không tự đoán blob đó là public.

Mục **Config** cho phép đổi giữa OCR toàn bộ PDF hoặc OCR thông minh, bật/tắt tìm kiếm theo ý nghĩa, chọn nguồn embedding và chọn kích thước chunk 800/1200/1600 ký tự. Mặc định dùng OCR thông minh, tắt semantic embedding để tiết kiệm quota và chunk 1200. Khi thay đổi thiết lập, **Đồng bộ** tự nhận file cần re-index.

### Semantic engine

- `Gemini`: gọi `gemini-embedding-001` với task type `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY` và vector 768 chiều. Nội dung chunk được gửi tới Gemini.
- `RAG Gateway`: gọi endpoint server-managed; phù hợp production khi không muốn người dùng nhập key.
- Khi tắt **Tìm theo ý nghĩa**, ứng dụng bỏ semantic embedding và chỉ dùng lexical retrieval trong browser; chế độ này không gửi chunk tới dịch vụ embedding.

Mỗi chunk ghi lại provider đã tạo vector. Khi query, app chỉ gọi đúng provider tương thích với vector trong index; lexical-only không gọi dịch vụ embedding.

Thẻ **RAG evidence** là quality gate, không chỉ là dashboard số liệu: nếu PDF có ít trang đọc được, thiếu page/chunk evidence hoặc semantic embedding lỗi, app chuyển sang cảnh báo và nêu hành động khắc phục thay vì tuyên bố AI đã sẵn sàng.

Shelby SDK hiện không chuẩn hoá các tag này trong `BlobMetadata`; chúng được đọc từ access-control contract. Xem [ACCESS_GATEWAY.md](ACCESS_GATEWAY.md) để biết format truy vấn và giới hạn bảo mật của policy này.

## Cloud AI hiện tại

- **Chat mặc định**: dùng `qwen/qwen3.7-flash` qua Vercel function `api/ai/v1/chat.ts`. `OPENROUTER_API_KEY` chỉ tồn tại ở server; trình duyệt không nhận key. Model có thể chọn các tool RAG/blob read-only, nhưng tool vẫn chạy trong browser dưới harness giới hạn số vòng/lượt gọi.
- **Gemini tùy chọn khi tạo RAG**: người dùng có thể nhập key riêng cho OCR cloud, đọc ảnh/video và semantic embedding. Key chỉ ở `sessionStorage` của tab, không nằm trong chat/RAG snapshot và không gửi tới Shelby.
- **Fallback local**: PDF OCR có Tesseract trong browser; lexical retrieval và page lookup vẫn hoạt động khi không có Gemini key.

## Công cụ chat

Trước khi gọi LLM, chat xử lý một số câu hỏi bằng dữ liệu thật trong browser:

- `Số dư APT hiện tại của tôi là bao nhiêu?` → gọi Aptos RPC read-only.
- `Địa chỉ ví tôi là gì?` → trả về địa chỉ của ví đang kết nối.
- `Xem thông tin tài khoản on-chain của tôi` → sequence number và authentication key từ Aptos RPC.
- `Liệt kê blob của tôi` → dùng inventory Shelby của ví đã tải.
- `Hiển thị ảnh của tôi` → hiện preview và link blob ảnh đã index.
- Phép tính cơ bản như `1+1=?` và các câu nhận diện như `tôi là ai`/`bạn là ai` được trả lời trực tiếp, không rơi xuống RAG.
- `Bạn có thể làm gì?` → liệt kê các khả năng hiện có.

Những kết quả này được gắn nhãn **công cụ** trong chat để phân biệt với câu trả lời suy luận từ RAG/AI.

## Cấu hình

| Biến | Mặc định | Mục đích |
| --- | --- | --- |
| `VITE_APP_NETWORK` | `testnet` | Network Shelby/Aptos SDK |
| `VITE_SHELBY_CLIENT_API_KEY` | trống | Geomi **client key** `AG-…` dành cho frontend, dùng với Shelby Indexer/RPC và Aptos RPC |
| `VITE_SHELBY_BLOB_API_URL` | Shelby testnet blob endpoint | Public endpoint download blob/model |
| `VITE_ACCESS_CONTROL_MODULE_ADDRESS` | Testnet reference deployment | Module chứa `access_control::query3_bcs` và `purchase` |
| `VITE_RAG_ACCESS_BROKER_URL` | trống | Gateway tùy chọn cho một schema tag ngoài access-control contract |
| `VITE_RAG_PIPELINE_API_URL` | trống | Base URL của hosted embedding gateway, ví dụ `/api/rag` |
| `GEMINI_API_KEY` | trống | **Server-only**, dùng bởi Vercel function `api/rag/v1/embeddings.ts` |
| `OPENROUTER_API_KEY` | trống | **Server-only**, dùng bởi Vercel function `api/ai/v1/chat.ts` |
| `APP_ORIGIN` | bắt buộc ở production | Origin duy nhất được gọi AI/embedding gateway |
| `RAG_GATEWAY_ALLOW_SERVER_CALLS` | `false` | Cho phép request không có header Origin (chỉ bật cho server tin cậy) |

Không cấu hình `VITE_GEMINI_API_KEY`, `VITE_APTOS_API_KEY`, `VITE_*PRIVATE_KEY`, `VITE_*SECRET` hoặc `VITE_*SPONSOR*`. `VITE_SHELBY_CLIENT_API_KEY` chỉ nhận client key công khai có prefix `AG-`; server key `aptoslabs_…` phải nằm ở backend và cần được xoay vòng nếu từng xuất hiện trong bundle trình duyệt. Vite build sẽ từ chối key sai loại trong biến mới. Key sinh câu trả lời là dữ liệu riêng của người dùng; secret phía máy chủ chỉ được phép tồn tại ở backend. Sao chép `.env.example` để bắt đầu; không commit `.env`.

## Deploy production

1. Deploy repository lên Vercel với root directory là `.`.
2. Tạo Geomi client key dành cho frontend với origin/rate limit phù hợp, rồi đặt `VITE_SHELBY_CLIENT_API_KEY=AG-…` cho Preview và Production. Đặt `OPENROUTER_API_KEY` ở server để bật Qwen chat. Nếu dùng embedding gateway, đặt `VITE_RAG_PIPELINE_API_URL=/api/rag` và `GEMINI_API_KEY` ở server.
3. Chạy `npm run check` trước deploy.
4. Gateway giới hạn 32 text/request, 4.000 ký tự/text, 64.000 ký tự/request, 30 request/IP/phút trên mỗi instance, kiểm tra origin, timeout upstream 25 giây và không cache response. Với production nhiều instance, đặt thêm rate limit phân tán tại CDN/WAF.

Nếu cần managed RAG hoàn toàn thay vì chỉ managed embeddings, Gemini File Search có thể đảm nhiệm upload, chunking, indexing và retrieval. Đây nên là một chế độ opt-in riêng vì dữ liệu đã import được lưu trong File Search store cho đến khi xóa; không nên âm thầm bật cho blob người dùng.
