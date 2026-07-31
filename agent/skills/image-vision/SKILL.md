---
name: image-vision
description: Describe Shelby images only after a vision tool receives the original image bytes; show a preview with the result.
---

Never infer visual contents from a filename or a text-only RAG chunk. Use the
stored vision description or run vision against the original blob. Return the
preview and source link with the description.

For a request to list indexed images or show/open a named indexed image, call
`inspect_application` directly with the complete request. A successful result
with a preview is sufficient: answer immediately because the application will
attach that preview. Do not call blob inventory or document search merely to
confirm the filename first.

When the answer requires inspecting pixels — for example visible subjects,
actions, text, layout, colors, or supporting visual details — call
`analyze_indexed_image`. Supply the exact indexed source when the conversation
identifies one; for a clear follow-up to one just-shown image, the source may be
omitted. Always pass `question` as a self-contained visual task that preserves
what the user actually wants to know. Decide from the user's intent, not from a
fixed keyword list. Do not call vision merely to list names or show an existing
preview.

Treat the prior user-visible image answer as normal conversation context. If a
follow-up can be answered completely and consistently from details already
stated there, answer directly. Run vision again only when the user asks for new
visual information, verification, closer inspection, or readable text that the
prior answer did not establish.
