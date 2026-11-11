# OVA Atlas

A free, local image archive and masked color-preview studio. Published on GitHub Pages at https://jackstanleyy-lang.github.io/Ova-atlas/.

## Use

- Import PNG, JPEG, or WebP images from Photos, Files, or the camera.
- Keep originals in Archive or Collection; neither import re-encodes their bytes.
- In Studio, paint, erase, or draw rectangle/ellipse masks; undo, redo, and export a full-resolution PNG mask.
- Create four local color previews, compare against the source, and save selected results with their original and series ID.
- Add manual appearance, outfit, pose, and camera labels; combine filters or review exact SHA-256 byte matches.
- Export an editable project to preserve its active image, root original, mask, and notes outside browser storage.
- Back up the entire Collection to one private `.ova-collection` file. Restore verifies every file before adding images and never overwrites an existing take.
- Load an `ova94-curation-1.1` visual-review JSON catalog privately. Browse art, photographic references, and source sheets separately; combine descriptive search, recorded tags, and suggested scene groups. Link each image explicitly from your device. Known SHA-256 fingerprints reject the wrong file.
- Compare side by side, open the preserved original, or accept a saved revision and continue from it. Saved results retain their root original, edit base, parent revision, and series. Rejecting a revision keeps its files and history.
- Choose the original reference or recorded edit base when comparing. Hold-to-compare, side-by-side and a wipe slider operate on unchanged local files. Revision history opens other takes in the same series and shows recorded parent links; missing parents are identified without inventing a relationship.

Studio accepts sources up to 35 MB and 16 megapixels. Four full-resolution previews require a working copy no larger than 6 megapixels. Larger originals can remain unchanged in Collection. No silent resizing is performed in free local mode. These are color transformations, not AI generation.

## Privacy and preservation

The public repository contains application code and app icons only. Images, drafts, imported catalogs, and labels remain in the browser's IndexedDB database. Private Library paths are metadata, not public image URLs. No paid provider or backend is enabled. Exact-copy review never automatically deletes images.

The existing `ova-atlas-6` database upgrades in place, retaining IDs, originals, and saved edits. Safari may evict local storage; export important projects and keep source files backed up. Privacy settings offer a deliberate local erase action.

An editable project includes its active image, root original, mask, notes, and saved parent/series identifiers. Use **Back up Collection** to preserve every saved take, its original/edit-base files, labels and recorded series links. Archive images, private catalogs and active Studio drafts are separate; Collection backup does not include those stores.

## Verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
python3 -m unittest discover -s tests -p 'test_release_audit.py' -v
```

The app has no runtime dependencies or build step. Development-only dependencies exercise the real backup UI and IndexedDB transactions in CI. The source remains self-contained HTML; npm files are not loaded by the app. GitHub Pages serves `main` from the repository root. Static integrity runs on pushes and pull requests; the existing native-app workflow is preserved separately. Local tests and Chromium checks do not establish physical iPhone Safari behavior.

## Collection backup format and restore

**Back up Collection** snapshots all available Collection records regardless of filters. Tap **Save Collection backup** after preparation. The file contains private images and metadata and is not encrypted or uploaded. Keep it in trusted storage.

Version 1 uses an 8-byte `OVA94B01` marker, a 4-byte little-endian manifest length, a 32-byte SHA-256 manifest checksum, UTF-8 JSON metadata, and concatenated raw image bytes. Identical byte payloads are stored once; independent records, their MIME types and lineage remain distinct. Verification rejects changed metadata, changed images, missing assets, invalid identifiers, circular parent links and unexpected trailing bytes.

Restore previews the exact add/skip counts. Re-importing the same unchanged backup skips records already present. If an identifier conflicts with a changed local record, the incoming snapshot receives consistent new identifiers so all branches remain together and local accepted revisions stay intact. Missing parents stay missing rather than linking to a different local image. A repeated import of that isolated snapshot is also skipped.

The final restore is one append-only IndexedDB transaction. A quota error or insertion collision aborts the whole transaction; there is no memory-only success fallback. A Collection change detected after preview requires updated review.

Limits: 10,000 records, 8 MB of metadata, 64 MB per unique image and a 2 GB total file. Images are never resized to meet a limit. Hashing processes one image at a time, and restore uses file slices instead of decoding a whole library. These bounds do not guarantee sufficient device memory or Safari storage quota.
