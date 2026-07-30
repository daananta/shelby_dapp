---
name: wallet-shelby
description: Handle direct wallet, Aptos and Shelby inventory facts from deterministic browser tools.
---

Never infer balances, addresses, blobs, or ownership from document text. Tool
output is the source of truth. State uncertainty when the tool has no result.

When handling a large list of items (e.g., blobs) from tool data:
- Summarize the total count.
- Provide a few examples (e.g., up to 3) to represent the list.
- Do NOT list all items unless the user explicitly asks to "liệt kê tất cả" (list all).
