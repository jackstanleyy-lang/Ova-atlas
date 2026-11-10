# OVA Atlas

A free, local image archive and masked color-preview studio. Published on GitHub Pages at https://jackstanleyy-lang.github.io/Ova-atlas/.

## Use

- Import PNG, JPEG, or WebP images from Photos, Files, or the camera.
- Keep originals in Archive or Collection; neither import re-encodes their bytes.
- In Studio, paint, erase, or draw rectangle/ellipse masks; undo, redo, and export a full-resolution PNG mask.
- Create four local color previews, compare against the source, and save selected results with their original and series ID.
- Add manual appearance, outfit, pose, and camera labels; combine filters or review exact SHA-256 byte matches.
- Export an editable project to preserve its source image, mask, and notes outside browser storage.
- Load an `ova94-curation-1.1` visual-review JSON catalog privately. Browse art, photographic references, and source sheets separately; combine descriptive search, recorded tags, and suggested scene groups. Link each image explicitly from your device. Known SHA-256 fingerprints reject the wrong file.
- Compare side by side, open the preserved original, or accept a saved revision and continue from it. Saved results retain their root original, edit base, parent revision, and series. Rejecting a revision keeps its files and history.

Studio accepts sources up to 35 MB and 16 megapixels. Four full-resolution previews require a working copy no larger than 6 megapixels. Larger originals can remain unchanged in Collection. No silent resizing is performed in free local mode. These are color transformations, not AI generation.

## Privacy and preservation

The public repository contains application code and app icons only. Images, drafts, imported catalogs, and labels remain in the browser's IndexedDB database. Private Library paths are metadata, not public image URLs. No paid provider or backend is enabled. Exact-copy review never automatically deletes images.

The existing `ova-atlas-6` database upgrades in place, retaining IDs, originals, and saved edits. Safari may evict local storage; export important projects and keep source files backed up. Privacy settings offer a deliberate local erase action.

## Verification

```sh
node --test tests/atlas-integrity.test.mjs
python3 -m unittest discover -s tests -p 'test_release_audit.py' -v
```

The app has no package dependencies or build step. GitHub Pages serves `main` from the repository root. Static integrity runs on pushes and pull requests; the existing native-app workflow is preserved separately. Local tests and Chromium checks do not establish physical iPhone Safari behavior.
