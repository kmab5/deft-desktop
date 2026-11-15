# Desktop implementation

The original design and roadmap are preserved under [plans](../plans). This document records the desktop choices for the same reading and library workflows.

| Android milestone | Desktop implementation |
| --- | --- |
| M1 · foundation | Native folder pickers, exclusions, file-type filters, six-hour startup scan debounce, manual scan, read-only SHA-256 identity, SQLite storage, book listing and search. Unavailable roots preserve their previous entries. |
| M2 · EPUB reader | Rust normalizes spine content, metadata, links and TOC. The React reader applies sanitization, bookmarks, resume, position fallback, fonts, themes, layout and keyboard navigation. |
| M3 · tracking | Foreground/focus and idle sampling, persisted checkpoints, sub-minute filtering, read-throughs, finish prompts, manual state/date changes and browse sessions. |
| M4 · organization | Author normalization and aliases, rename/merge, categories and types, decimal series, suggestions and auto-fill, ordering, ratings and next-in-series. |
| M5 · annotations | Highlights, notes and bookmarks, in-book search, global and per-book filters, fixed page notes, location jumps and Markdown export. |
| M6 · statistics | Date ranges, charts, heatmaps, timezone-aware sessions, streaks, goals, author/category/book summaries and year in review. |
| M7 · fixed layout | Local PDF.js worker, DjVu WASM worker and CBZ image source. Fit modes, scroll/paged view, zoom, inversion, page notes, PDF passwords, PDF/DjVu outlines and CBZ RTL. |
| M8 · conversion | TXT decoding, FB2/FB2 ZIP and Kindle MOBI/KF8 processing, using the same text reader. The cache is versioned by content hash with size and LRU limits. |
| M9 · exchange | Explicit matching and cover download, Goodreads CSV, Deft Reading Profile schema/sample, SQLite backup/restore and configurable weekly rotation. |
| M10 · packaging | Windows x64 NSIS installer workflow, optional certificate signing, tag-based releases, keyboard navigation, reduced-motion support and first-run guidance. |

## Desktop decisions

| Decision | Reason |
| --- | --- |
| Tauri 2, Rust and React | Keep file access, network and durable data in Rust. Support desktop controls on the platform WebView. |
| Keep `com.kmab.deft` | Preserve the product identity from the approved design. |
| SQLite records by collection | Save related state in one transaction and keep backups consistent. The schema version is checked during restore. |
| Native local directories and file dialogs | Replace Android's Storage Access Framework and share sheet. On a different Windows computer or drive letter, add the new folders and rescan after restore. |
| PDF.js and DjVu-rs | Bundle offline decoders and PDF password support with the same viewer controls. |
| Normalized local reflow | Render structurally sanitized content and keep reading controls shared across EPUB, FB2, TXT and Kindle. Store an offset and normalized book progression so reopening survives layout changes. |
| Automatic backup while Deft runs | Avoid a privileged background service. An overdue backup runs after launch when the chosen folder is available. |
| App-level reader brightness and native Windows display-awake | Brightness changes the reader surface. Keep-awake applies while the reader is focused; DPI and appearance use the platform WebView. |

## Limits and verification

- The EPUB reader preserves text, structure, local links and supported raster images. Original publisher styles and embedded fonts, SVG-only illustrations, and fixed-layout EPUB fidelity are limited. PDF and DjVu use generated covers unless the user supplies a cover. DjVu needs a bundled file, since indirect DjVu uses separately linked files.
- Kindle conversion is cached on first open. EPUB, TXT and FB2 can prewarm in the background. Very large publications are limited by parser and WebView memory bounds.
- PDF and DjVu are rendered offline. In-book search uses searchable PDF text where available. Deft does not perform OCR for image-only pages.
- Reading time uses foreground samples, a configurable idle cutoff, and 30-second checkpoints. Timer gaps caused by sleep or throttling are skipped. A session that contains idle intervals and spans midnight is allocated proportionally for date/time charts using its captured UTC offset.
- Large-library startup and scrolling targets have yet to be benchmarked on Windows.
- The desktop checks cover the Rust core with local format fixtures, SQLite migration/backup, state/session tracking, export and network isolation. React checks cover type safety, production bundling, text navigation and statistics. The Windows target was cross-checked. Installer launch, signing and SmartScreen behavior require the [native acceptance checklist](windows-acceptance.md).
- Third-party matching depends on live provider access and a user-supplied token for Hardcover. The importer determines how an external custom shelf such as `did-not-finish` is mapped.
