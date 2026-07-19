---
"@dg-kit/protocol": patch
---

`OPOSSUM_VIBRATION_PATTERNS` was added in 1.8.0 but never re-exported from the package's public `index.ts` — every downstream consumer importing from `@dg-kit/protocol` (rather than reaching into `dist/opossum.js` directly) couldn't actually access it despite it being documented as part of the new vibration-pattern API. Fixed; added a public-API-surface test to catch this class of gap going forward.
