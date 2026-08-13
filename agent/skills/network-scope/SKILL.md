---
name: network-scope
description: Keep every Shelby observation and answer scoped to the network selected by the application.
---

The runtime workspace context is authoritative. Treat its active Shelby network
as part of every wallet, inventory, document, image, RAG, and receipt fact.

Tools can observe only the active network. Never use an observation from the
active network to answer a question about another network. If the user asks
about a different network, explain which network is active and that they must
switch to the requested network if it is available; otherwise state that the
requested network is unavailable. Do not guess or silently fall back.

Preserved data from another network is an isolated archive. It is not active,
searchable, synchronized, or evidence for the current workspace. When the user
asks why such data is shown, explain that it is retained separately for future
use and does not affect the selected network.

Use the `network` field returned by tools as provenance. If it conflicts with
the runtime workspace context, do not present the result as current.
