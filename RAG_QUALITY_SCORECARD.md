# Shelby RAG Explorer — RAG Quality Scorecard

Last local run: 2026-07-29

## What this benchmark proves

The deterministic benchmark exercises the same browser-side functions used by
the product. It does not call Gemini, Aptos testnet, or Shelby RPC, so it can run
without spending API quota or creating external side effects.

| Gate | Cases | Result |
| --- | ---: | ---: |
| General vs user-document routing (EN/VI) | 26 | 26/26 |
| Untrusted Cloud router normalization | 8 | 8/8 |
| Citation selection and fail-closed grounding | 13 | 13/13 |
| File detection, MP4, chunking, and degradation states | 11 | 11/11 |
| Internal-guide and prompt isolation | 9 | 9/9 |
| Lexical retrieval relevance and no-evidence behavior | 11 | 11/11 |
| **Total** | **78** | **78/78** |

## Quality metrics

| Metric | Local result | Interpretation |
| --- | ---: | --- |
| General/document routing accuracy | 26/26 | Generic questions are not forced into RAG; explicit user-data questions are routed correctly. |
| Lexical top-1 relevance | 9/9 | The expected fixture document ranks first, including the embedding-failure fallback. |
| Unrelated-query abstention | 1/1 | A query with no relevant fixture returns no passage. |
| Citation and grounding guards | 13/13 | Valid citations survive; missing, invented, grouped, duplicate, and zero-evidence cases are handled deterministically. |
| Unsupported document answers exposed after the guard | 0/3 | Missing citations, invented citations, and zero-evidence retrieval all fail closed. |
| Live model hallucination rate | Not measured | Requires a real Gemini key, repeated model runs, and a human-checked answer rubric. |

## Before and after

The first frozen 52-case run scored **42/52 (80.8%)**:

- Routing: 19/26
- Cloud route normalization: 8/8
- Citation grounding: 5/8
- Retrieval relevance: 10/10

After the targeted fixes, the same 52 cases score **52/52**. The suite was then
expanded to 78 cases and remains green.

## Regressions fixed

1. Generic questions containing `blob`, `PDF`, `image`, `story`, or `summarize`
   were incorrectly classified as user-document requests.
2. `What does my PDF say ...?` was swallowed by inventory routing.
3. Page-count questions could be classified as inventory instead of metadata.
4. Existing or duplicate citation IDs could survive reassignment.
5. Common Gemini citation forms such as `[S1, S3]` and `[S1; S2]` lost all
   source cards.
6. A document answer with no valid citation could remain visible as if it were
   grounded.
7. Invalid Cloud router scopes retained a confident source reference instead of
   failing closed.
8. Internal `AGENT(S).md` and `SKILL(S).md` sources did not have a reusable,
   directly tested filter.
9. A document search with zero matching passages could still leave a speculative
   model answer visible instead of failing closed.

## Important limits

This score is not proof that every AI answer is correct.

- The suite proves deterministic routing, retrieval, citation bookkeeping,
  ingestion classification, and safety guards.
- Answer Receipt verifies the cited source and recorded excerpt according to
  its declared level. It does not cryptographically prove every model
  inference.
- Actual Gemini tool-calling, multilingual answer quality, image/video
  understanding, and quota behavior still require a live API-key evaluation.
- Actual Shelby range reads, uploaded bytes, Aptos transactions, indexer lag,
  and receipt verification against a real public blob still require a testnet
  integration run.
- The MP4 cases prove byte detection and pipeline routing, not the quality of a
  real Gemini video description.

## Commands

```bash
npx vitest run frontend/evals/ragQualityBenchmark.test.ts
npm run test
npm run lint
npm run build
npm run test:e2e
```

The deterministic hackathon gate is: all benchmark cases pass, the full local
test/build gates pass, and no live-integration claim is made without transaction
or network evidence.
