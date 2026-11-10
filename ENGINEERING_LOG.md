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
- Released through PR #1 on `release/v8.8-reconciled`; merge `a0dc3b77bc9a85abcd0b30ed731e02edb57841dc`. GitHub static CI passed, Pages deployment completed, and the live browser title confirmed v8.8. The public HTML, worker and manifest match the tested checkout.
- Canonical private visual catalog validated separately: 150 unique records and paths, 117 illustrations, 21 photo references, 12 source sheets, 15 review-only similarity pairs. Catalog contents and imagery are excluded from this repository.

The catalog and revision milestone follows below.

## 2026-11-10 — visual catalog and revision continuity

- Added private import of `ova94-curation-1.1` JSON; rejects duplicate IDs/keys/paths, malformed records and dangling duplicate references. Private paths never become public image URLs. Existing legacy snapshots remain supported.
- Catalog browsing keeps artwork, photo references and source sheets distinct; combines text, recorded tags and suggested scene groups. Groups never assert identity or source-to-edit relationships.
- Local image linking requires explicit selection and confirmation, verifies known fingerprints, and creates another preserved attachment rather than overwriting an existing one.
- Added side-by-side comparison, accept-and-continue, original reopening, and non-destructive rejection. Root originals, edit bases, parent IDs and series persist through drafts and portable projects.
- Extended the separate canonical private catalog from 150 to 174 reviewed files, correcting three stale paths. Checked all 15 historical copy suggestions: 13 pairs byte-identical, two nonidentical. No originals changed or deleted; no catalog records or imagery committed here.
- Live v8.8 checks: three synthetic imports became two unique images; rectangle masks, undo/redo, four previews, saving and PNG exports worked. Downloaded preview and mask retained 2400×800; all 1,591,680 unmasked pixels matched the source exactly.
- Verification: 18 JavaScript tests plus five Python release-audit tests pass. DOM integration checks cover canonical catalog import, 36-item pagination, media filters, side-by-side comparison and preserved revision lineage in autosave.
- Remaining: physical iPhone Safari camera, Photos and installed-PWA testing; continue unreviewed archive collections. No paid generation or infrastructure enabled.

## 2026-11-10 — published release verification

- PR #1 merged as `a0dc3b77bc9a85abcd0b30ed731e02edb57841dc`; PR #2 merged as `f63f0178f2d1ce4e13dfd6da356a614e03c0eaea`. Both Pages deployments succeeded. The published v8.8.1 HTML and worker match the tested checkout.
- Latest release CI: 18 JavaScript tests and five release-audit tests passed on GitHub.
- The private canonical catalog loaded all 174 records in the live browser; photo-reference filtering returned 25. Existing Collection still contained all three synthetic test images after the upgrade.
- At 337 CSS pixels, Archive and side-by-side comparison had equal viewport/content width with no horizontal overflow. This is a Chromium responsive-width check, not physical iPhone Safari certification.
- Live accept-and-continue exported a project whose root-original bytes exactly match the untouched source and whose active-image bytes exactly match the accepted preview. Parent and series IDs are present.
- Follow-up labels distinguish photo references from confirmed originals, expose only cataloged media types for the visual index, and identify legacy saved outputs as revisions.
- Cost boundary maintained: no paid infrastructure, generation credits, provider keys, archive exports or user images published. Every original remains preserved.

Next milestone: physical iPhone Safari acceptance for camera/Photos import, touch masking, offline reload and Home Screen PWA; then continue the unreviewed archive collections toward the next canonical review batch.
