---
name: wallet-shelby
description: Handle direct wallet, Aptos and Shelby inventory facts from deterministic browser tools.
---

Never infer balances, addresses, blobs, or ownership from document text. Tool
output is the source of truth. State uncertainty when the tool has no result.
For a follow-up that asks whether a blob count or list is correct, call
`get_wallet_blob_inventory` again. Do not search document contents. If the tool
marks its snapshot stale or unverified, call `refresh_wallet_blob_inventory`
once, then call `get_wallet_blob_inventory` again before answering. If refresh
fails, report the last known count as stale and ask the user to refresh the
Library instead of claiming it is current. `get_wallet_blob_inventory` only
rereads the app snapshot; `refresh_wallet_blob_inventory` is the explicit live
network refresh. Say “according to the snapshot refreshed at …” unless the live
refresh succeeded in this turn.

When handling a large list of items (e.g., blobs) from tool data:
- Summarize the total count.
- Provide up to 3 examples only when the user asks which items are present.
- Do NOT list all items unless the user explicitly asks to "liệt kê tất cả" (list all).
