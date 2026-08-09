# Shelby RAG Explorer

Shelby RAG Explorer turns documents stored as Shelby blobs into a local,
searchable knowledge base with page-level citations. It combines Shelby hot
storage, Aptos wallet ownership, browser-side extraction, and an AI assistant
that can use retrieved evidence when a question requires it.

## Highlights

- Lists blobs owned by the connected Aptos wallet.
- Runs on ShelbyNet while preserving isolated Testnet workspaces for the network's future reopening.
- Verifies access policy before downloading content for indexing.
- Detects supported file formats locally, extracts document text in the browser,
  and uses optional cloud analysis for image and video content.
- Builds a wallet-scoped hybrid index with lexical and optional semantic search.
- Returns source-backed answers with document, page, excerpt, and integrity
  metadata.
- Stores and restores a portable RAG snapshot on Shelby with byte-range reads.
- Keeps Gemini keys in the active browser tab and server provider keys outside
  the client bundle.

## Architecture

```text
Aptos wallet
   │
   ├─ Shelby SDK / indexer ── blob metadata and access state
   │
   ├─ Shelby RPC ──────────── blob bytes and range reads
   │
   └─ Browser workspace
        ├─ extraction and OCR
        ├─ IndexedDB page and chunk index
        ├─ lexical / semantic retrieval
        └─ evidence passed to the AI gateway
```

Blob metadata is registered through Shelby's Aptos contracts, while document
bytes are transferred separately through Shelby RPC. The project does not ship
a custom Move contract.

## Quick start

Requirements:

- Node.js 20 or newer
- An Aptos-compatible wallet
- Access to the configured Shelby network

```bash
npm install
cp .env.example .env
npm run dev:fullstack
```

Open `http://localhost:5173`, connect a wallet, select eligible blobs, and
choose **Create RAG**.

`npm run dev` starts the Vite frontend only. Use it for UI work that does not
need the server-side AI routes; hosted Qwen chat and vision require
`npm run dev:fullstack` or a deployed environment.

## Configuration

The most relevant environment variables are:

| Variable | Scope | Purpose |
| --- | --- | --- |
| `VITE_DEFAULT_SHELBY_NETWORK` | Browser | First-visit network (`shelbynet` by default) |
| `VITE_SHELBYNET_CLIENT_API_KEY` | Browser | ShelbyNet origin-restricted Geomi client key |
| `VITE_TESTNET_CLIENT_API_KEY` | Browser | Reserved Testnet key; dormant while Testnet is unavailable |
| `VITE_SHELBYNET_BLOB_API_URL` | Browser | ShelbyNet blob endpoint |
| `VITE_TESTNET_BLOB_API_URL` | Browser | Reserved Testnet endpoint; not contacted in this release |
| `VITE_SHELBYNET_ACCESS_CONTROL_MODULE_ADDRESS` | Browser | Optional ShelbyNet access-policy module |
| `VITE_TESTNET_ACCESS_CONTROL_MODULE_ADDRESS` | Browser | Testnet access-policy module |
| `VITE_RAG_PIPELINE_API_URL` | Browser | Optional hosted embedding endpoint |
| `OPENROUTER_API_KEY` | Server | Default AI gateway credential |
| `GEMINI_API_KEY` | Server | Optional hosted embedding credential |
| `APP_ORIGIN` | Server | Allowed production origin |

See [.env.example](.env.example) for the complete template and
[ACCESS_GATEWAY.md](ACCESS_GATEWAY.md) for access-policy behavior.

## Security and privacy

- Never place private keys, mnemonics, sponsor keys, or server API keys in a
  `VITE_*` variable.
- User-provided Gemini keys are stored in `sessionStorage`, are not written to a
  RAG snapshot, and are not uploaded to Shelby.
- Local indexes, chat history, remote caches, and upload journals are isolated by network and wallet address.
- Unknown or unverifiable access policies fail closed.
- Access metadata does not encrypt raw blob bytes; sensitive content still
  requires end-to-end encryption.
- Optional cloud OCR and semantic indexing can send selected document content to
  the configured provider. Lexical retrieval and supported local OCR remain
  available without them.
- AI chat sends the question and only the retrieved excerpts or indexed image
  needed for that answer to the selected provider.

## Supported content

The extractor inspects file signatures and content instead of trusting file
extensions. It supports common text formats, PDF, JSON, HTML/XML, and common
image formats. Unsupported binary, archive, and Office formats are skipped
without decoding their bytes as text.

## Quality checks

```bash
npm run lint
npm run test
npm run build
npm run test:e2e
```

For the deterministic retrieval benchmark:

```bash
npm run test:rag
```

## License

[Apache License 2.0](LICENSE)
