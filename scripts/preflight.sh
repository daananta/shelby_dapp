#!/usr/bin/env bash
set -euo pipefail

npm run lint
npm run typecheck
npm test
npm run test:rag
npm run build
npm run test:e2e
node scripts/check-production-audit.mjs
git diff --check
