# Deft Roadmap

> **For agentic workers:** This is the milestone map, not a task plan. Before starting a milestone, write its task-level plan as `plans/YYYY-MM-DD-mN-<name>.md` with the superpowers:writing-plans skill, using `plans/2026-11-13-deft-design.md` (the spec) and this roadmap. Then execute it with superpowers:subagent-driven-development or superpowers:executing-plans. M1 is already planned: `plans/2026-11-13-m1-foundation.md`.

**Spec:** `plans/2026-11-13-deft-design.md` — every milestone argues from it. **Visual design:** `plans/2026-11-13-deft-visual-design.md` (+ `plans/design/preview.html`) — every screen, component and animation follows it. Section references below (§n) point there.

**Rule for every milestone:** it ends with an installable app that is better than the previous milestone's, all tests green, CI green, and the design doc updated if a decision changed (add a row to the design doc's Decision log, §20).

## Branching, handover, tagging
1. Work on `feat/mN-<name>` (fixes: `fix/<topic>`), branched from `main`. Push the branch so CI runs.
2. When the milestone's acceptance criteria pass, build a debug APK (`./gradlew assembleDebug`) and write `plans/mN-test-checklist.md`: the roadmap acceptance criteria plus anything risky the milestone touched, as tickable device steps, ending with a **"how does it look"** section for every screen or animation the milestone touched (visual feedback happens here, not at separate checkpoints). Give the author the APK path and the checklist in chat. Visual feedback updates the visual design doc + preview and is logged in §20.
3. Merge only after the author explicitly says the checklist passed: `git merge --no-ff` into `main` (merge commit; history is not squashed).
4. Tag every merge to `main` (§3 of the design): milestone → bump B (M1 = `v0.1.0-1`), fix → bump C, build/CI/packaging-only → bump D. Push the tag; CI publishes a GitHub Release (pre-release while A = 0).

---

## M1 — Foundation: scan folders, list books
**Spec:** §3, §5, §6.1–6.4 (incl. excluded subfolders; the `ignored` column exists but its UI arrives in M2), §6.5 (EPUB DRM detection only), §14 (Books screen, Settings → Library), §15 (library tables), §16 (CI, privacy check).
**Delivers:** Gradle multi-module skeleton, CI, versioning (`versionCode` from the tag scheme), the full design system from the visual design doc §2–§7, §9 (colours incl. reader themes, fonts subset + size budget, type scale, shapes, motion tokens, icons, core components, `ContrastTest`, screenshot tests, app icon with mark (b)), Room database (library tables), settings, SAF folder management with excluded subfolders, scanner with content-hash identity, missing/reattach, EPUB metadata extraction (other formats: filename heuristics), Books screen.
**Acceptance:** pick a folder of EPUBs → Books screen shows covers/titles/authors; delete a file → it disappears (visible under "Show missing"); put it back elsewhere → same Book reattaches; same file in two folders → one Book.
**Produces for later:** `BookFormat`, `ContentHash`, `BookRepository`, `LibraryScanner`, `MetadataExtractor` + `MetadataExtractorRegistry`, `AppDatabase` with migrations, `DeftTheme`.

## M2 — EPUB reader
**Spec:** §10.1, §10.3, §11 (bookmarks only), §15 (`currentLocator`, `Bookmark`).
**Delivers:** Readium-based reader shell (Compose host around the Readium EPUB navigator fragment), paged/scroll, themes (Light/Sepia/Dark/Black + custom), fonts (bundled + imported TTF/OTF), size, line spacing, margins, alignment, hyphenation, brightness slider (quick panel + settings default), keep screen on, volume keys, status line, TOC, bookmarks, progress slider, position restore. Reader settings in DataStore (global). "Continue reading" card on Books. Book detail page (visual §11.2 layout; basic: cover, metadata, Read/Continue, file info, Ignore/Un-ignore, Forget). Settings → Library → Ignored books.
**Acceptance:** open any EPUB from the library, change every typography option, leave and come back to the same position; bookmarks persist.
**Produces:** `ReaderLauncher.open(bookId)`, `ReaderPreferences`, `ReadingPosition(locatorJson, totalProgression)`, a `ReaderEvents` flow (page turn, scroll step, selection, visibility) that M3 consumes.

## M3 — Tracking: sessions, read-throughs, states
**Spec:** §8 (all), §9, §15 (`ReadThrough`, `ReadingSession`).
**Delivers:** `SessionTracker` driven by `ReaderEvents` + lifecycle (two idle timeouts incl. Off + the 15-min keep-screen-on safety net, `browsing` sessions, min 60 s, 30 s incremental writes, screen-off/background end), read-through state machine with all §8.3 prompts, manual state changes and date editing on the book page, ratings (half-star), favorite, review, haptics (visual §10), the finish celebration + quiet version and the `celebrations` setting (visual §8.1), `feature/celebrate`. Books screen state chips become real. Settings → Tracking.
**Acceptance:** fake-clock tests cover every row of §8.3 and every idle/background edge; reading for 3 min with a 6-min idle gap records exactly 3 min.
**Produces:** `SessionRepository`, `ReadThroughRepository`, `BookState` derivation query used by stats and library filters.

## M4 — Categories, types, series, authors
**Spec:** §6.4, §7, §14 (Categories, Authors pages).
**Delivers:** categories (no nesting in v1, non-unique names, types, built-in Series type, manual order, decimal series positions, merge), series auto-fill into auto-created Series categories only (+ merge aliases) with `suggested` flag + review indicator, "Next in series", category/author/series progress with abandoned = unresolved, computed/overridden rating, author pages, author merge/rename, multi-select "Add to category" on Books.
**Acceptance:** scanning a series of EPUBs with `calibre:series` creates one ordered Series category; overriding a category rating and resetting it works; merging two authors combines their books.

## M5 — Highlights, notes, search
**Spec:** §10.1 (selection, search, define), §11, §15 (`Highlight`, `PageNote`).
**Delivers:** text selection actions (4 colors, note, copy, share, define via `ACTION_PROCESS_TEXT`), Readium decorations, in-book search, per-book notes tab, global Notes screen with filters/search, export a book's notes as Markdown.
**Acceptance:** highlights render on reopen at the same text; deleting the file keeps notes visible on the Notes screen.

## M6 — Stats, goals, year in review
**Spec:** §13, §14 (Stats).
**Delivers:** pure-Kotlin stats calculators over sessions/read-throughs (timezone-correct per §13), per-book/category/author/series stats on their pages, overall Stats screen with range selector, heatmap, streaks, distributions, goals (yearly books, daily minutes), year in review (visual §11.7), personal bests and the remaining celebrations (visual §8.2–8.3).
**Acceptance:** golden-dataset tests for every metric, including sessions crossing midnight and zone changes.

## M7 — Fixed-layout viewer: PDF, CBZ, DjVu
**Spec:** §5.3 (`PageSource`), §10.2, §6.5 (PDF encryption vs password), §3 (F-Droid native builds).
**Delivers:** Deft's own fixed-layout viewer (paged/continuous, fit modes, zoom, crop, inversion, RTL for CBZ, per-book prefs), PDFium and djvulibre built from source via NDK/CMake, CBZ image source, page notes, TOC, metadata extractors for PDF/DjVu/CBZ (ComicInfo.xml), sessions/progress integrated with M3.
**Acceptance:** large PDFs (500+ pages) scroll smoothly; DjVu opens; CBZ RTL works; native libs build in CI from source.

## M8 — Converters: TXT, FB2, MOBI/AZW/AZW3
**Spec:** §5.3 (`BookConverter`, conversion cache, locator fallback), §6.3, §6.5 (MOBI/AZW DRM detection).
**Delivers:** converter framework + cache (LRU, size setting, background preparation), TXT (encoding detection, chapter heuristics), FB2 (incl. `.fb2.zip`), MOBI/AZW/AZW3 via libmobi (built from source) or pure Kotlin; metadata extractors for each; "Protected" handling for DRM files (badge, explanation, still categorizable/ratable).
**Acceptance:** fixture books in each format open with identical reader features to EPUB; bumping a converter version falls back to `totalProgression` without losing position.

## M9 — Data exchange: matching, exports, backup
**Spec:** §12 (all).
**Delivers:** `data/matching` (Open Library → Google Books → Hardcover with token), single and bulk matching UI, "Use matched metadata", cover download; Goodreads-format CSV export (verify against current Goodreads/StoryGraph/Hardcover import docs); Deft Reading Profile JSON + committed `plans/deft-profile.schema.json` + sample; backup zip + restore with migration and folder re-grant checklist; optional weekly auto-backup.
**Acceptance:** golden-file tests for CSV/JSON; backup → wipe app → restore → rescan restores everything; network isolation test still passes (only `data/matching` has HTTP).

## M10 — Polish and first release
**Spec:** §14 (visual direction), §16 (performance, accessibility), §3 (distribution).
**Delivers:** performance pass against §16 targets (5 000-book library), accessibility audit, empty states and copy, app icon, About/third-party licenses screen, release signing via GitHub Actions secrets, GitHub Release workflow on tags, F-Droid metadata (`fastlane/metadata/android/...`, reproducible build notes), README with screenshots and privacy statement.
**Acceptance:** tagged build produces a signed APK on a GitHub Release; F-Droid build recipe builds from a clean checkout.

---

## Dependency order
M1 → M2 → M3 → (M4, M5, M6 in any order; M6 is most useful after M4) → M7 → M8 → M9 → M10. M7 and M8 only depend on M3 and can be swapped.
