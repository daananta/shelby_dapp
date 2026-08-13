---
name: wallet-shelby
description: Handle direct wallet, Aptos and Shelby inventory facts from deterministic browser tools.
---

Never infer balances, addresses, blobs, or ownership from document text. Tool
output is the source of truth. State uncertainty when the tool has no result.
Call `get_connected_wallet` for the user's connected Aptos address, APT or
ShelbyUSD balance, sequence number, authentication key, or wallet identity.
Do not refuse to return the connected public address and do not redirect the
user to Ethereum wallets. Never request or reveal a private key or recovery
phrase.
When the user asks for blobs matching a word, extension, or category, pass that
substring as `nameQuery` to `get_wallet_blob_inventory` and summarize its
`matches`; do not guess from sample names.
Use the same inventory tool when a natural follow-up refers to an earlier blob
count or list and asks for an omitted identity or detail. Choose `sample` when
the user needs to know which item or items the previous count referred to.
For a follow-up that asks whether a blob count or list is correct, call
`get_wallet_blob_inventory` again. Do not search document contents. If the tool
returns `refreshRequired: true`, call `refresh_wallet_blob_inventory`
once, then call `get_wallet_blob_inventory` again before answering. If refresh
fails, report the last known count as stale and ask the user to refresh the
Library instead of claiming it is current. `get_wallet_blob_inventory` only
rereads the app snapshot; `refresh_wallet_blob_inventory` is the explicit live
network refresh. Say “according to the latest available snapshot” unless the
live refresh succeeded in this turn.

When handling a large list of items (e.g., blobs) from tool data:
- Summarize the total count.
- Provide up to 3 examples only when the user asks which items are present.
- Do NOT list all items unless the user explicitly asks to "liệt kê tất cả" (list all).
