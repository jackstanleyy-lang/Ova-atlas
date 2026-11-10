# OVA Atlas engineering log

## 2026-11-10 — v8.8 reconciliation

- Inspected `jackstanleyy-lang/Ova-atlas`, default branch `main`, base `dddb0c85ef1dae229dc1f83c2038d75ea118f9f5`.
- Confirmed owner account in GitHub's browser UI and existing Pages configuration: `main`, repository root, HTTPS.
- Confirmed the deployed web app was v8.4. All intervening repository changes affected only the native-app workflow; that workflow is preserved byte-for-byte.
- Recovered and audited the saved v8.8 candidate. Applied its reviewed web diff: Archive, camera import, rectangle/ellipse masks, mask PNG export, collection labels/filters/pagination, SHA-256 duplicate-aware importing and manual copy review.
- Retained the database name and migrated version 3 to version 5 by adding stores. Existing image records and originals are not cleared or rewritten.
- Corrected original preservation: Archive and linked-image imports keep original files; free Studio no longer resizes sources or unmasked preview areas. Oversized preview work is rejected explicitly.
- Made the five audit regressions portable; removed an obsolete machine-specific fixture path. Added them to static CI.
- Local verification: 12/12 JavaScript integrity tests and 5/5 release-audit tests passed.
- Release is prepared on `release/v8.8-reconciled`; remote CI, merge, deployment and browser verification are recorded after completion.
- Canonical private visual catalog validated separately: 150 unique records and paths, 117 illustrations, 21 photo references, 12 source sheets, 15 review-only similarity pairs. Catalog contents and imagery are excluded from this repository.

Next milestone: publish and verify v8.8, then add a validated browser-local visual-catalog importer with explicit local-image matching and source/revision comparison.
