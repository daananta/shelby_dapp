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
