# Shelby RAG Explorer — Judge Demo

## One-line pitch

Turn Shelby blobs into a browser-local, page-citable knowledge base while enforcing the blob's on-chain access policy before any RAG ingestion.

## What is real and verifiable

| Claim | Proof in the product |
| --- | --- |
| Access-aware ingestion | The app calls `access_control::query3_bcs`, decodes the BCS policy, and only queues `public` or already-unlocked `time_lock` blobs. An unknown policy fails closed. |
| Locked Policy States | On-chain locks (`allowlist`, `purchasable`, `time_lock`) are rendered with clear explanations and visual indicators. `purchasable` blobs offer a direct "Mua quyền" button. |
| Progress Stepper Tracker | Heavy ingestion runs through an animated, horizontal stepper tracker (Access Policy → Tải Blob → Extract & OCR → Embeddings → Commit) with microsecond logs. |
| Premium Citations | Chat replies present RAG evidence in collapsible, glassmorphic citation cards. Displays match method (semantic vs. keyword) and a confidence percentage meter. |
| Summarize & Study Guide Skill | Native AI skill routes "tóm tắt" and "đề cương" queries to summarize documents with structured outlines (Overview, Key Concepts, review questions) and exact citations. |
| Hosted agent + optional enrichment | Qwen3.7 Flash chat works without a user key; Gemini content analysis and semantic embeddings remain explicit opt-in features. |
| Robust RPC Fallback | Fail-safe catch blocks trigger toast notifications if Aptos fullnode or Shelby RPC endpoints experience latency or outage. |
| Local-first privacy | Extraction, Tesseract OCR, page index, chunks and lexical retrieval run in the browser. Optional semantic embeddings are sent only after explicit consent. Workspaces are isolated per wallet. **Xóa RAG local** removes the active wallet's local evidence and chat without touching Shelby blobs. |
| Portable RAG | A `*.shelby-rag.json` backup contains manifest/page text/chunks only. It intentionally excludes API keys, private keys, and model files. |

## Honest scope

- `allowlist` and `purchasable` policies are displayed from the same on-chain policy source, but are deliberately **not** included in the standard RAG queue unless unlocked or purchased.
- This submission does not claim to decrypt GreenBox-protected data. It avoids pretending that a wallet signature alone is decryption.
- Qwen3.7 Flash is served through a bounded server-side gateway. Gemini is optional and uses a user-provided key stored in that browser. Deterministic page/quote lookups require neither provider.

## 90-second demo flow

1. Open the app and click **Xem demo evidence**. Without a wallet or model/API key, click **Kiểm tra policy** to show a real page-index citation (`Shelby RAG Evidence Demo · trang 1/3`).
2. Return to the landing page, connect a Shelby/Aptos wallet, and point out `N/M blob đủ điều kiện tạo RAG`. Notice the visual Lock icons and policy details for locked files.
3. Open **Nâng cao** and explain the quality/performance controls: full-page local OCR, semantic embedding, and chunk size.
4. Click **Tạo RAG**. Watch the Horizontal Progress Stepper transition from Access Policy checking and page text reading through optional Gemini/gateway embedding to the final atomic commit.
5. Ask “*Tóm tắt tài liệu X*” or "*Tạo đề cương ôn tập*" to trigger the Summarization Skill, yielding an outline with key concepts, review questions, and citable page refs.
6. Click **Bằng chứng trích xuất** under an AI response to show the premium citation cards displaying semantic/lexical match types and confidence metrics.
7. Show that Qwen chat is ready by default, then disable semantic search to demonstrate that lexical retrieval remains available without Gemini embedding calls.
8. Show the **RAG evidence** quality gate and, if needed, **Xóa RAG local** to demonstrate wallet-scoped privacy controls.

## Verification commands

```bash
npm run test
npm run lint
npm run build
npm run test:e2e
```

The browser suite includes a generated PDF that exercises the real browser PDF.js worker. An optional real-Shelby-PDF test runs only when `SHELBY_REAL_PDF_URL` is provided.
