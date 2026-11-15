# Deft — Design

*Status: approved design, ready for implementation planning. Date: 2026-11-13.*

> deft — read like you mean it.

Deft is an offline, accountless Android ebook reader with a built-in reading tracker. It reads the user's local ebook files with Lithium-level simplicity and turns every minute of reading into accurate, personal data: states, time, sessions, ratings, categories, series, and stats.

This document is the source of truth for *what* Deft is and the decisions already made about *how*. The roadmap (`plans/2026-11-13-deft-roadmap.md`) breaks it into milestones; each milestone has its own task-level plan in `plans/`.

---

## 1. Why Deft exists

The author reads a lot. Their reading life was spread across three tools:

- **Lithium** for reading, with series and lists maintained by hand.
- **Bookmory** for timing reading sessions — with constant app-switching and forgotten timers that ruin the data.
- **bookledger** (a personal Python catalog) built to keep track of what had been read — a stopgap that still needed manual entry for every new book.

Tracking matters to them for two reasons: to see their own reading behavior, and to feed sites like Goodreads / StoryGraph / Hardcover whose recommendation algorithms depend on accurate history and ratings ("Letterboxd for books").

**Deft puts the reader and the tracker in the same app**, so tracking is accurate by default: opening a book starts the clock, leaving it stops it, finishing it records it. Nothing to remember.

**Audience:** first the author (a heavy reader with a large local library), then the portfolio, then any stranger who wants the same thing. Strangers are welcome but do not drive the design.

**What success looks like:** the author stops using Lithium, Bookmory and bookledger, reads only in Deft, and can at any time export an accurate history to Goodreads/StoryGraph/Hardcover.

## 2. Goals, non-goals, anti-goals

### Goals (v1)
1. A fast, minimal reader for: **EPUB, MOBI, AZW, AZW3, FB2, TXT** (reflowable) and **PDF, DjVu, CBZ** (fixed-layout). Nine formats (the original list of twelve counted `.djv` and `.djvu` separately); RTF and LIT are out of scope (§19).
2. A library built automatically from user-chosen folders and file types.
3. Automatic, accurate reading-time tracking and reading-state management.
4. User-defined categories with user-defined types (Series is a built-in type), automatic authors.
5. Ratings (half-stars), favorites, short reviews; category ratings computed with override.
6. Rich stats: per book, category, author, series, and overall; a yearly goal; a year-in-review.
7. Highlights, notes, bookmarks, TOC, in-book search.
8. Opt-in matching of local books to recognized editions (ISBN / work IDs) so history can be exported.
9. Export to Goodreads-format CSV (accepted by Goodreads, StoryGraph, Hardcover) and to a documented Deft JSON profile.
10. Local backup/restore as a zip.
11. Open source, GPL-3.0.

### Non-goals (v1)
- **The social app.** Profiles, follows, friends, book clubs, chat and voice messages will live in a **separate, future app**. Deft only provides a stable, documented export contract it can consume (§12). Do not build any social feature, server, or account into Deft.
- Adding books that don't exist as files (no manual "I read this paperback" entries; that was bookledger's model and is explicitly rejected).
- Cloud sync, accounts, multi-device sync.
- Opening DRM-protected files (see §6.5).
- Audiobooks, OPDS catalogs, store integrations, TTS, translation, AI features.
- Editing or writing to the user's book files — **Deft never modifies a book file**.
- Home-screen widgets, Wear OS, tablets-specific layouts beyond what Compose gives for free.
- iOS / desktop.
- Importing reading history from any other app (bookledger, Bookmory, Lithium, Goodreads, StoryGraph). Deft starts fresh; history begins with the first session read in Deft.
- The landing page (it will live in `docs/` for GitHub Pages later; not part of this build).

### Anti-goals (failure even if it "works")
- **Settings sprawl.** Lithium's appeal is restraint. If the reader grows a page of knobs, it failed. Every reader option must earn its place.
- **Inaccurate time.** If sessions count idle time, forgotten-open books, or double-count, the core promise is broken. Better to undercount than overcount.
- **Losing history.** Deleting, moving, or renaming a file must never destroy reading data.
- **Silent network.** Deft must never contact the network except when the user explicitly asks for edition matching or cover download.
- **Mandatory metadata chores.** The library must be useful with zero manual tagging; matching and categorizing are optional improvements.

## 3. Constraints

- **Platform:** Android, Kotlin, Jetpack Compose, Material 3 (custom-themed), `minSdk 26`, target the latest stable SDK.
- **Offline & accountless.** No analytics, no crash reporting that phones home, no ads.
- **License:** GPL-3.0-only for all Deft code. All dependencies must be GPL-3.0-compatible (Apache-2.0, BSD, MIT, LGPL, GPL-2.0-or-later are fine; GPL-2.0-only, AGPL-incompatible combos, and proprietary SDKs are not in the core build).
- **Storage access:** Storage Access Framework (SAF) persisted tree URIs. Do **not** request `MANAGE_EXTERNAL_STORAGE`.
- **Legal:** no DRM circumvention code, ever, in any branch.
- **Application ID / root package:** `com.kmab.deft` (permanent once released).
- **Git authorship:** commits are authored as `Samuel Worash Getaneh <samuelworash.com>`; repo is `github.com/kmab5/deft`.
- **Versioning:** tags `vA.B.C-D` — A major release, B feature release, C fix, D build (rebuild of the same A.B.C with only build/CI/packaging changes; resets to 1 when A, B or C changes; max 99). `versionName = "A.B.C"`, `versionCode = A*1_000_000 + B*10_000 + C*100 + D`. Pre-1.0: each milestone bumps B (M1 → `v0.1.0-1`); M10's public release is `v1.0.0-1`. Every merge to `main` is tagged; every tag publishes a GitHub Release. F-Droid submission at `v1.0.0`.
- **Distribution:** GitHub Releases (signed APK) and **F-Droid**. F-Droid requires every native dependency (PDFium, djvulibre, libmobi) to build from source reproducibly, no proprietary dependencies, no Google Play Services, no non-free network services enabled by default. Design the native build (NDK + CMake, sources as git submodules or fetched by pinned hash) for this from phase 1. Google Play is a possible later channel, not a v1 target.

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | **Readium Kotlin Toolkit for reflowable text + in-app converters** that turn MOBI/AZW/AZW3/FB2/TXT into EPUB; a custom fixed-layout viewer for PDF (PDFium), DjVu (djvulibre), CBZ (images). | We write and maintain converters (legacy MOBI is the hard one). In return every reflowable format gets identical theming, fonts, pagination, highlights and search. | **Chosen.** |
| B | MuPDF for most formats. | Less code up front, but EPUB renders as fixed pages with weak CSS/theme control (no Lithium-quality typography), AGPL, still missing DjVu/AZW3, highlights at a low level. | Rejected. |
| C | crengine (KOReader's engine) via JNI. | Great coverage and typography, but a large e-ink-oriented C++ codebase with its own rendering model; heavy to bridge into Compose. | Rejected. |

Refinement of A decided during design: Readium is used **only for reflowable content**. PDF, DjVu and CBZ go through one Deft-owned fixed-layout viewer backed by a `PageSource` interface, so all three behave identically (fit modes, zoom, inversion, page notes).

## 5. Architecture

### 5.1 Stack (decided)
- Kotlin, Coroutines/Flow, Jetpack Compose, Material 3, Navigation Compose.
- **Room** (SQLite) for all reading data; **DataStore (Proto or Preferences)** for settings.
- **Hilt** for DI.
- **WorkManager** for library scanning and conversion jobs.
- **Readium Kotlin Toolkit** (latest stable 3.x) — streamer, shared, navigator (EPUB), search, decorations.
- **PDFium** for PDF, via an Android binding the builder can **build from source in CI** (F-Droid requirement, see §3). Prebuilt-`.so` bindings are only acceptable if the same binaries can be reproduced from source in the F-Droid build recipe.
- **djvulibre** via NDK/JNI for DjVu (GPL-2.0-or-later → compatible).
- **libmobi** (LGPL-3.0, C) via JNI is the recommended base for MOBI/AZW/AZW3 → EPUB; a pure-Kotlin parser is acceptable if the builder finds libmobi impractical.
- `juniversalchardet` (or equivalent) for TXT encoding detection.
- OkHttp/Ktor client + kotlinx.serialization, used **only** by the matching module.
- Testing: JUnit5/Kotest for JVM tests, Robolectric where needed, Compose UI tests, Room migration tests.

### 5.2 Module layout (Gradle)
```
app/                      # Application, navigation graph, DI wiring
core/model/               # Pure Kotlin domain types (no Android)
core/database/            # Room entities, DAOs, migrations
core/datastore/           # Settings
core/common/              # Dispatchers, time, result types, hashing
core/designsystem/        # Theme, typography, components
feature/library/          # Books, Authors, Categories screens
feature/book/             # Book detail page
feature/reader/           # Reader shell: reflowable (Readium) + fixed-layout
feature/notes/            # Highlights/notes/bookmarks lists
feature/stats/            # Stats, goals, year in review
feature/settings/         # Settings screens
library/scanner/          # SAF walking, fingerprinting, metadata extraction
format/epub/              # Readium wiring
format/convert/           # Converter API + TXT, FB2 converters (Kotlin)
format/mobi/              # MOBI/AZW/AZW3 converter (JNI to libmobi)
format/pdf/               # PDFium PageSource
format/djvu/              # djvulibre PageSource (NDK)
format/cbz/               # Image PageSource
tracking/                 # Session tracker, state machine
data/matching/            # Edition matching providers (only networked module)
data/exchange/            # Backup zip, CSV export, Deft profile export
```
Builder may merge small modules; the boundaries that matter are: **domain types have no Android deps; only `data/matching` touches the network; format modules expose a common interface and know nothing about the database.**

### 5.3 Format interfaces
```kotlin
// Reflowable formats other than EPUB
interface BookConverter {
    val formats: Set<BookFormat>
    val version: Int                       // bump when output changes
    suspend fun convert(input: InputStream, out: File): ConversionResult // writes an EPUB 3 file
}

// Fixed-layout formats
interface PageSource : Closeable {
    val pageCount: Int
    suspend fun pageSize(index: Int): Size
    suspend fun render(index: Int, target: Bitmap, region: Rect, scale: Float)
    suspend fun tableOfContents(): List<TocEntry>   // empty if none
}

// Every format
interface MetadataExtractor {
    suspend fun extract(input: InputStream): ExtractedMetadata // title, authors, series+index, language, isbn, publisher, description, cover bytes, drm flag
}
```
Converted EPUBs are cached in app-private storage keyed by `(contentHash, converterVersion)`. The cache is evictable (size limit in settings, default 1 GB, LRU) and regenerated on demand. Conversion runs on first open with a progress indicator, or ahead of time via a WorkManager job when the book is added (setting: "Prepare books in background", default **on**).

**Locator stability:** reading positions for converted books are Readium `Locator`s against the converted EPUB. Always store `totalProgression` alongside; if the converter version changes and a locator can't be resolved, fall back to `totalProgression`.

## 6. Library

### 6.1 Sources
Settings → Library:
- **Folders:** list of SAF tree URIs, add/remove. Subfolders are included unless **excluded**: each folder has an optional list of excluded subfolders. Excluding a subfolder treats its books like removed files (marked missing, history kept); un-excluding reattaches them.
- **File types:** checkboxes for each of the 9 formats (all on by default).
- **Rescan** button; automatic rescan on app start (debounced, at most once per 6 h) and pull-to-refresh on the Books screen.

### 6.2 Book identity
- A **Book** is identified by the **SHA-256 of its file content**. Scanning first compares `(uri, size, lastModified)` to skip unchanged files, then hashes new/changed files.
- The same content found at several paths → **one Book with several BookFile rows**.
- Different files of the same work (an EPUB and a PDF of the same title) → **separate Books** in v1. Edition matching can link them to the same work ID; merging is a future feature.
- **A changed file is a different Book.** If a file is edited in place (e.g. Calibre writes metadata into it) or replaced by a corrected edition, its new content hash makes it a new Book with fresh stats; the old Book becomes missing and keeps its history. This is intentional (decided by the author): separate files have separate stats. No "is this the same book?" heuristics, no history transfer.
- A file that disappears → its BookFile is marked missing. A Book with no present files is **missing**: hidden from the Books screen by default (filter "Show missing"), but still counted everywhere in stats, history, categories and exports, shown with a "File missing" badge.
- A missing Book whose hash reappears (new path, restored backup) **reattaches automatically** with all history intact.
- **Ignore:** any book can be ignored ("Not a book": manuals, receipts, papers). An ignored book is hidden from every list and excluded from every stat, progress bar, export and series auto-fill; its history is kept. Un-ignore from Settings → Library → Ignored books restores everything. Ignore survives rescans (it's keyed to the Book, i.e. the content hash).
- **Forget** ("Remove from Deft and forget history") is the only permanent deletion, with confirmation.

### 6.3 Metadata
Extracted per format on scan: title, authors, series name + index, language, publisher, published date, description, ISBN(s), page count (fixed-layout) and cover image (saved as a thumbnail in app storage). Sources:
- EPUB: OPF metadata; series from `belongs-to-collection` (EPUB3) or `calibre:series`/`calibre:series_index`.
- MOBI/AZW/AZW3: EXTH records (title 503, author 100, ISBN 104, publisher 101, cover).
- FB2: `title-info` (`book-title`, `author`, `sequence name/number`, `coverpage`).
- PDF: Info dict / XMP. DjVu: metadata annotations if present. CBZ: `ComicInfo.xml` if present.
- TXT: filename heuristics (`Series - 01 - Title`, `Title (Series #1)`, `Author - Title`).

Users can **edit** title, authors, series and cover inside Deft. Edits are stored in the database as overrides (`*_override` columns or a separate table) — the original extracted values remain, and **files are never modified**.

### 6.4 Authors
- Created automatically from book metadata. Names normalized: "Sanderson, Brandon" → "Brandon Sanderson"; whitespace/case collapsed for matching.
- Users can **merge** authors (aliases) and rename. A book can have several authors.
- Author page: books, state breakdown, progress (finished/total), total time, average rating of the author's rated books.
- A co-authored book belongs fully to each of its authors: it appears on every author page, counts in each author's progress, and its reading time is credited **in full** to each author (never split).

### 6.5 DRM
- During metadata extraction, detect DRM: EPUB `META-INF/encryption.xml` with non-font-obfuscation algorithms or `rights.xml`/`license.lcpl`; MOBI/AZW encryption type ≠ 0; KFX containers; PDF encryption dictionary that blocks opening (password-protected PDFs: prompt for password — that's not DRM).
- DRM books appear in the library with a **"Protected"** badge. Tapping "Read" shows a short explanation ("This file is DRM-protected. Deft can't open it.").
- They can still be categorized, rated, favorited, matched and exported. They have no reading sessions.
- **Readium LCP** is a possible future, separately licensed build flavor. Not in v1. No other DRM will ever be supported.

## 7. Categories, types, and series

- A **Category** is a user-created named collection of books: name, optional description, optional cover (defaults to a collage of member covers), an ordering mode, and a set of **types**.
- A **CategoryType** is a user-created label (e.g. "TBR", "Book club", "Self-help"). One type, **Series**, is built-in and cannot be deleted. A category can have zero or more types; the Categories screen can filter/group by type.
- **Ordering:** every category supports manual ordering (drag to reorder) or a sort (title, author, date added, rating). A **Series**-typed category is always ordered by a **decimal position** per member (1, 2, 2.5, …), editable.
- **Names are not unique.** Categories are identified by ID; two categories may share a name.
- **No nesting in v1.** The schema carries a nullable `parentId` (FK to Category, `ON DELETE SET NULL`) from the first schema version that contains categories (M4), always null in v1, so nesting can be added later as UI + rules (SQLite recursive CTEs) without a data migration.
- **Auto-fill:** when scanning finds series metadata, Deft adds the book (at the given position) to a Series-typed category **that auto-fill itself created** (`autoCreated = true`) whose name matches the series name case-insensitively; if none exists it creates one. Auto-fill never attaches to a category the user created. If the user merges an auto-created series into one of their own categories, the series name is recorded as an alias on the target (`CategorySeriesAlias`) and auto-fill uses that category from then on. Auto-added memberships are flagged `suggested` until the user edits or confirms them; the category shows a small "review" indicator while any member is suggested. Users can disable auto-fill in settings.
- Book page shows **"Next in series"** (the lowest-positioned member after this one that is not finished).
- **Category progress:** finished members ÷ total members (missing books included, ignored books excluded). **Abandoned books are unresolved:** they stay in the denominator, so a category containing an abandoned book never shows 100%. The bar shows finished, reading/paused, and abandoned as distinct segments. The same rule applies to author and series progress.
- Users can merge two categories (members are unioned; on position conflicts the target's positions win).
- **Category rating:** by default the average of its rated books, shown with one decimal. The user can **override** with their own rating; a reset returns to the computed average. UI shows which one is in effect.

## 8. Reading states, read-throughs and sessions

### 8.1 States
`NOT_STARTED` (displayed "Not read"), `READING`, `FINISHED`, `PAUSED`, `ABANDONED`.

### 8.2 Read-throughs
A **ReadThrough** is one attempt at reading a book: `startedAt`, `endedAt?`, `outcome` (`IN_PROGRESS`, `FINISHED`, `PAUSED`, `ABANDONED`), and its sessions. A book's state is derived from its latest read-through (`NOT_STARTED` if none). This gives re-reads, read counts, and per-month finish stats for free.

### 8.3 Transitions
| From | Event | Result |
|---|---|---|
| Not read | first session recorded | new read-through, `READING` |
| Reading | reaches end (last page / ≥ 99% progression) | prompt "Mark as finished?" (Yes → `FINISHED`, sets `endedAt`; also offers rating) — prompt only once per read-through |
| Reading | user marks Paused / Abandoned / Finished | as chosen |
| Paused | opened & session recorded | resume same read-through → `READING` |
| Abandoned | opened | prompt: "Resume" (same read-through → `READING`) or "Start over" (new read-through) |
| Finished | opened | prompt: "Re-read" (new read-through, position reset to start) or "Just browsing" (no state change; sessions are recorded with `browsing = true` and appear in the book's own session list, but are **excluded** from daily reading time, the heatmap, streaks, goals and all aggregate stats) |
| any | user sets state manually on book page | allowed; manual finish asks for finish date (default now) |

Users can edit read-through dates and delete read-throughs from the book page.

### 8.4 Session tracking (the core promise)
- A session is active while the reader screen is **resumed and visible** and the screen is on.
- **Idle pause:** if there is no page turn, scroll, or selection for the idle timeout, the session stops accruing; the next interaction resumes it. Idle time is never counted. Two user-adjustable timeouts (any whole number of minutes 1–60, plus **Off**): reflowable default **5 min**, fixed-layout default **10 min**.
- **Idle timeout Off safety net:** when the applicable timeout is Off, "keep screen on" is released after **15 min** without interaction, so the screen sleeps normally and the session ends on screen-off. Nothing is counted after the screen turns off. *Exception:* fixed-layout pages with a zoom/pan in the last idle window count as interaction.
- Session **ends** when the reader is left, the app goes to background, or the screen turns off.
- Sessions with < 60 s of active time are discarded.
- Each session stores: book, read-through, `startedAt`, `endedAt`, `activeSeconds`, `startLocator`, `endLocator`, `startProgression`, `endProgression`, and `pagesTurned` (count of page-turn/scroll-step events).
- **Pages read** for stats: fixed-layout → distinct page delta; reflowable → delta in Readium *positions* (≈1024 chars each), labelled "pages" in UI.
- Sessions are written incrementally (update the open row every ~30 s) so a crash loses at most 30 s.
- A quiet in-reader indicator is optional (setting, default off).

## 9. Ratings, favorites, reviews
- **Rating:** 0.5–5.0 in half-star steps, optional, per book (not per read-through in v1).
- **Favorite:** boolean heart.
- **Review:** optional plain text, per book. Private by default (it's an offline app); flagged as exportable in the profile export only if the user chooses.
- Authors get a computed average, no manual rating. Categories: §7.

## 10. The reader

### 10.1 Reflowable (EPUB and converted formats, via Readium)
- **Layout:** paged (tap zones left/right/center, swipes; page-turn animation: none/slide) or continuous scroll.
- **Typography:** font family (a small bundled set — e.g. a serif, a sans, a dyslexia-friendly font, "Publisher default" — plus user-imported TTF/OTF copied into app storage), **font size**, **line spacing**, **margins**, **text alignment** (start/justified), hyphenation (on/off).
- **Themes:** Light, Sepia, Dark, Black (AMOLED), plus user-created custom themes (background, text, link/accent colors). Option: follow system day/night (pick a light theme and a dark theme).
- **Brightness:** a slider in the reader quick panel (window brightness, not system), with "use system brightness" toggle; default in settings. **No brightness gesture.**
- **Other:** keep screen on (default on while reading), volume keys turn pages (default off), status bar line (clock, battery, chapter progress / book %, toggleable), full-screen/immersive.
- **Navigation:** TOC, bookmarks list, progress slider with chapter ticks, "go back" after a jump.
- **Selection:** highlight in 4 colors, add note, copy, share text, **define** (hands off via `ACTION_PROCESS_TEXT`/`ACTION_DEFINE` to an installed dictionary app), search in book.
- **Search:** Readium search service; results list with context.
- Reader settings are **global** (apply to all books). Exception: fixed-layout settings are per-book (fit/zoom/inversion).

### 10.2 Fixed-layout (PDF, DjVu, CBZ — Deft's own viewer)
- Page-by-page (horizontal) or continuous vertical scroll.
- Fit width / fit page / fit height; pinch zoom; double-tap zoom; crop margins (auto-detect, PDF/DjVu).
- Dark mode by plain color inversion.
- Right-to-left reading toggle for CBZ (manga).
- TOC (PDF outline, DjVu bookmarks; none for CBZ), bookmarks, **page notes** (a note attached to a page; no text highlighting in v1).
- Password-protected PDFs prompt for a password (not stored).

### 10.3 Reader quick panel
One tap in the center opens: top bar (back, title, TOC, bookmark toggle, search, more) and bottom bar (progress slider, Aa typography sheet, theme, brightness). Kept minimal — this is the place settings sprawl would show up first.

## 11. Notes, bookmarks, highlights
- **Bookmark:** locator + auto-generated label (chapter + snippet), optional custom name.
- **Highlight:** locator range, color, selected text, optional note, created/updated timestamps.
- **Page note** (fixed-layout): page index + note.
- **Notes screen** (global): every highlight/note/bookmark across books, filter by book/color/type, search, tap to jump into the book.
- Per-book notes tab on the book page. Export a book's notes as Markdown (share sheet).
- Notes survive file deletion like all other data.

## 12. Data exchange

### 12.1 Edition matching (opt-in, the only networked feature)
- Purpose: attach a recognized identity (ISBN-10/13, Open Library work/edition IDs, Google Books ID, Hardcover ID) to a local book so exports are importable elsewhere.
- Entry points: book page "Match edition", bulk "Match selected" in the library, and Settings → Matching (enable providers; Hardcover needs a user-supplied API token).
- Providers, in order: **Open Library** (no key) → **Google Books** (no key needed at low volume) → **Hardcover** (if token). Query by ISBN from file metadata when present; otherwise title + first author.
- UI shows candidates (cover, title, author, year, ISBN); user confirms one or "No match". Bulk mode auto-accepts only exact ISBN hits and queues the rest for review.
- Matching stores the identifiers and canonical title/authors in a separate `EditionMatch` record. It **does not overwrite** local metadata unless the user taps "Use matched metadata" (which writes overrides, never the file). Cover download is a separate explicit action.
- No network call happens anywhere else in the app. Make this testable (single HTTP client provided only to `data/matching`).

### 12.2 Export: Goodreads-format CSV
- One CSV that Goodreads, StoryGraph and Hardcover all import. Columns follow the Goodreads library export header exactly (`Book Id, Title, Author, Author l-f, Additional Authors, ISBN, ISBN13, My Rating, Average Rating, Publisher, Binding, Number of Pages, Year Published, Original Publication Year, Date Read, Date Added, Bookshelves, Bookshelves with positions, Exclusive Shelf, My Review, Spoiler, Private Notes, Read Count, Owned Copies`). Builder verifies against a current Goodreads export and each target's import docs.
- Mapping: `FINISHED` → `read`; `READING`/`PAUSED` → `currently-reading`; `NOT_STARTED` → `to-read`; `ABANDONED` → shelf `did-not-finish` (StoryGraph/Hardcover recognize DNF shelves — verify). Categories → `Bookshelves` (slugified). Rating → rounded to nearest whole star for Goodreads compatibility (half-up), with the exact value kept in the JSON export. Date Read = latest finished read-through. Read Count = finished read-throughs.
- Options: include only matched books (default) or all; include unmatched books by title/author with a warning count; include reviews (default off).

### 12.3 Export: Deft Reading Profile (JSON) — contract for the future social app
- A versioned, documented JSON file (`deft-profile.json`, `"schemaVersion": 1`) containing: app version, export time, books (local ID, title, authors, edition match identifiers, format, state, rating, favorite, review if opted-in, read-throughs with dates, total active time), categories (name, types, members with positions, rating/override), authors, and aggregate stats. **Excludes** file paths, notes/highlights (opt-in toggle), and sessions' locators.
- Schema is committed as `plans/deft-profile.schema.json` (JSON Schema) during implementation, with a sample.
- Delivered via the Android share sheet (MIME `application/json`, filename `deft-profile-YYYY-MM-DD.json`). Deft only *sends*; the future social app will *receive*. A permission-gated `ContentProvider` for one-tap import is a **future** item; leave a seam (`ProfileExporter` producing the model) so it can be added without refactoring.

### 12.4 Backup & restore (local zip)
- `deft-backup-YYYY-MM-DD.zip`: `manifest.json` (schemaVersion, app version, DB version, created at, list of library folder display paths), consistent SQLite copy (checkpoint WAL first, or Room-safe copy), settings, imported fonts, custom covers/thumbnails. **Never book files.**
- Restore: replaces all Deft data after confirmation; runs migrations if the backup's DB version is older; refuses newer. Afterwards the user re-grants folders (SAF permissions don't survive reinstall; the manifest's folder list is shown as a checklist), rescans, and books reattach by hash.
- Optional automatic backup: weekly into a user-chosen SAF folder, keeping the last N (default 4). Default off.

## 13. Stats

All stats are computed from sessions and read-throughs; nothing is stored redundantly except optional cached aggregates.

- **Per book:** total active time, sessions count, average session length, average speed (pages/hour), estimated time left (remaining pages ÷ the user's speed on this book, falling back to overall speed), started/finished dates per read-through, read count.
- **Per category / author / series:** finished/total progress bar, time spent, average rating, state breakdown.
- **Overall (with range selector: week / month / year / all time / custom):**
  - books finished per period (bar chart);
  - reading time per day (calendar heatmap);
  - current & longest streak (a day counts if ≥ 1 session; streak threshold configurable, default 1 min);
  - time-of-day and day-of-week distribution;
  - format distribution, book length distribution;
  - rating distribution;
  - abandoned rate (abandoned / (finished + abandoned));
  - pages read, average speed.
- **Goals:** yearly books-finished goal with progress & pace ("3 ahead of schedule"); optional daily minutes goal.
- **Year in review:** a scrollable summary screen per calendar year: totals, top-rated, longest book, most-read author, busiest month, favorite time of day.
- "This month" style counts use the **device time zone at the time of the session** (store session timestamps as UTC instant + zone offset).

## 14. Screens and navigation

Bottom navigation (5): **Books · Categories · Authors · Notes · Stats**. Settings from the top-bar overflow on every top-level screen. "Continue reading" card pinned at the top of Books (last opened book, one tap to resume).

```
Books
┌──────────────────────────────┐
│ Deft            🔍  ⇅  ⋮     │
│ ┌──────────────────────────┐ │
│ │ ▶ Continue: Mistborn 2   │ │
│ │   43% · 2h 10m left      │ │
│ └──────────────────────────┘ │
│ [All][Reading][Not read][…]  │  ← state chips
│ ┌───┐ ┌───┐ ┌───┐            │
│ │cov│ │cov│ │cov│  grid/list │
│ └───┘ └───┘ └───┘            │
├──────────────────────────────┤
│ Books Categories Authors Notes Stats │
└──────────────────────────────┘
```
- **Books:** grid/list, sort (title, author, recently read, date added, rating, progress), filter (state, format, favorite, category, rating, missing, protected, matched). Multi-select → add to category, set state, match editions.
- **Book page:** cover, title/author (tap author → author page), state control, rating/favorite, progress, "Read"/"Continue", categories (with positions), next in series, read-throughs, stats, notes tab, edition match, file info (paths, format, size, missing/protected).
- **Categories:** list/grid grouped or filtered by type; each with progress bar and rating. Category page: ordered members, progress, stats, rating override, edit types, merge.
- **Authors:** list with progress and counts; author page.
- **Notes:** §11. **Stats:** §13. **Reader:** §10.
- **Settings:** Library (folders + excluded subfolders, file types, rescan, series auto-fill, ignored books), Reader (defaults for §10), Tracking (idle timeouts reflowable/fixed incl. Off, min session, streak threshold), Goals, Appearance (app theme light/dark/system, accent), Matching (providers, Hardcover token), Backup & export, Storage (conversion cache size, clear), About (version, license, source link, third-party licenses).

Visual design: **`plans/2026-11-13-deft-visual-design.md`** (colours, type, components, every screen, motion, celebrations, copy). The sketches above are layout only; the visual doc wins on look and copy.

## 15. Data model (Room, logical)

```
Book(id, contentHash UNIQUE, format, ignored, title, sortTitle, titleOverride?, language, publisher, publishedDate,
     description, isbn10?, isbn13?, pageCount?, coverPath?, coverOverridePath?, drmProtected,
     addedAt, lastOpenedAt?, favorite, rating?, review?, currentLocator?, currentProgression,
     readerPrefsJson? /*fixed-layout per-book*/, convertedVersion?)
BookFile(id, bookId, uri, displayPath, size, lastModified, missing, lastSeenAt)
Author(id, name, sortName, normalizedName UNIQUE)
AuthorAlias(aliasNormalizedName UNIQUE, authorId)
BookAuthor(bookId, authorId, position, overridden)
CategoryType(id, name UNIQUE, builtIn /*Series*/)
Category(id, name /*not unique*/, description?, parentId? /*FK ON DELETE SET NULL; always null in v1*/, autoCreated, coverPath?, orderMode, sortField?, ratingOverride?, createdAt)
CategorySeriesAlias(normalizedSeriesName UNIQUE, categoryId)
CategoryTypeLink(categoryId, typeId)
CategoryMember(categoryId, bookId, position REAL, suggested, addedAt)
ReadThrough(id, bookId, startedAt, endedAt?, outcome, finishPromptShown)
ReadingSession(id, bookId, readThroughId, browsing, startedAtUtc, endedAtUtc, zoneOffsetMinutes, activeSeconds,
     startLocator?, endLocator?, startProgression, endProgression, startPosition?, endPosition?, pagesTurned)
Bookmark(id, bookId, locator, label, createdAt)
Highlight(id, bookId, locator, text, color, note?, createdAt, updatedAt)
PageNote(id, bookId, pageIndex, note, createdAt, updatedAt)
EditionMatch(bookId PK, provider, isbn10?, isbn13?, openLibraryWorkId?, openLibraryEditionId?,
     googleBooksId?, hardcoverId?, matchedTitle, matchedAuthors, publishedYear?, pages?, confirmedAt)
Goal(year, booksTarget?, dailyMinutesTarget?)
LibraryFolder(treeUri UNIQUE, displayName, addedAt)
ExcludedFolder(treeUri, documentId /*SAF document id of the subfolder*/, displayPath, PRIMARY KEY(treeUri, documentId))
```
Rules: deleting a `BookFile` never cascades to `Book`. A `Book` is only deleted by explicit user action ("Remove from Deft and forget history"), with confirmation. Room schema export is on; every schema change ships a migration and a migration test.

## 16. Quality bar
- **Tests:** unit tests for every converter and metadata extractor against fixture files in `testdata/` (public-domain books, e.g. Project Gutenberg, Standard Ebooks; small synthetic files for edge cases); session tracker and state machine with a fake clock; stats calculators with fixed datasets; CSV/JSON exporters against golden files; Room migration tests; Compose UI tests for library and reader shell flows.
- **Performance targets:** library of 5 000 books scrolls at 60 fps on a mid-range device; cold start to Books < 1.5 s; opening an already-converted book < 1 s; initial scan of 1 000 files completes in the background without blocking UI.
- **Accessibility:** TalkBack labels, 48 dp touch targets, dynamic font scaling in app chrome, sufficient contrast in all built-in themes.
- **CI:** GitHub Actions — build, ktlint/detekt, unit tests, assembleRelease on every push to any branch; every version tag builds a signed APK and publishes a GitHub Release (pre-release while major = 0). Signing key from repository secrets. See §3 for versioning.
- **Privacy check:** a test asserting no module other than `data/matching` depends on the HTTP client; `INTERNET` permission is required only for matching (document this in the README).

## 17. Implementation order (summary — full plan in the implementation plan doc)
1. Repo skeleton, Gradle modules, CI, license, design system.
2. Database, settings, SAF folders, scanner (EPUB first), Books screen.
3. Readium EPUB reader with settings, TOC, bookmarks, progress.
4. Session tracking, read-throughs, states, book page.
5. Categories, types, series auto-fill, authors.
6. Highlights, notes, search, Notes screen.
7. Stats, goals, year in review.
8. Fixed-layout viewer: PDF, CBZ, then DjVu.
9. Converters: TXT, FB2, then MOBI/AZW/AZW3.
10. Edition matching, CSV export, profile export, backup/restore.
11. Polish, accessibility, performance pass, first release.

## 18. Left to the builder
- Exact libraries where the doc names candidates (PDFium binding, libmobi vs pure Kotlin, charset detector, chart library or hand-drawn Compose charts).
- TXT chapter-detection heuristics.
- Cache eviction details, WorkManager constraints.
- Exact wording of prompts and empty states.

## 19. Future (explicitly not v1)
- Separate social app (profiles, follows, current read, book clubs with text + short voice chat) consuming the Deft profile.
- ContentProvider for one-tap profile import.
- Readium LCP build flavor.
- Importing history from Goodreads/StoryGraph CSV onto matched local books.
- RTF and LIT support (LIT needs a clean-room LZX/LIT parser; existing references contain DRM-removal code that must not be reused).
- Merging different-format files of the same work into one Book.
- Per-read-through ratings, TTS, widgets, landing page in `docs/`.

## 20. Decision log
Record every decision made or changed after approval: date, decision, reason.

| Date | Decision | Reason |
|---|---|---|
| 2026-11-13 | Book identity is pure content hash; a modified file is a new Book with separate stats. | Author: separate files have separate stats. |
| 2026-11-13 | No import of history from other apps (bookledger, Bookmory, Lithium, Goodreads). | Author: Deft is a fresh, separate app. |
| 2026-11-13 | RTF and LIT dropped from v1. | Author: not needed; LIT has no clean, DRM-free reference implementation. |
| 2026-11-13 | Distribution: GitHub Releases + F-Droid. | Author. Requires reproducible from-source native builds. |
| 2026-11-13 | Planning docs live in `plans/`, not `docs/`. | `docs/` is reserved for the GitHub Pages landing page. |
| 2026-11-13 | "Ignore book" (hidden, excluded from stats, history kept, reversible) and excluded subfolders (books marked missing, reattach on un-exclude). | Grilling: scanned folders contain non-books. |
| 2026-11-13 | Abandoned books are unresolved in category/author/series progress; never 100% with a DNF. | Author. |
| 2026-11-13 | Co-authored books credit full time to each author. | Grilling. |
| 2026-11-13 | Idle timeouts adjustable (1–60 min or Off): reflowable 5, fixed-layout 10; Off releases keep-screen-on after 15 min idle. | Author: reading speeds differ. |
| 2026-11-13 | "Just browsing" sessions excluded from daily time, heatmap, streaks, goals, aggregates. | Author. |
| 2026-11-13 | No category nesting in v1; nullable `parentId` (ON DELETE SET NULL) present from the categories table's first version. Category names not unique. Series auto-fill only uses auto-created Series categories (+ merge aliases). | Author. |
| 2026-11-13 | App ID `com.kmab.deft`; tags `vA.B.C-D`, versionCode `A·10⁶+B·10⁴+C·10²+D`; planning commit `v0.0.0-1`. | Author. |
| 2026-11-13 | No PRs: branch per milestone/fix, local debug APK + test checklist handover, merge commit to `main` after author confirms, then tag. | Author: single device/repo. |
| 2026-11-13 | Visual design agreed: kmab-derived structure (ink neutrals, Space Grotesk/Mono, square-capped Lucide, colour = meaning) + Deft's own paper light mode, Literata, and book mark; purple = accent and "reading"; Material You off; lowercase UI copy. Full spec in `plans/2026-11-13-deft-visual-design.md`. | Design grilling with the author. |
| 2026-11-13 | Celebrations (full-screen, smooth, skippable; toggle "celebrations", default on) for book finished, goal, series, streak milestones, personal bests. | Author: "a bit more hurrah", but switchable. |
| 2026-11-13 | Visual feedback is gathered at each milestone handover, not at separate checkpoints; the visual design is a living doc. | Author. |
| 2026-11-14 | Visual feedback round 1: mark (b) reworked (thicker, softened corners, 1:1.2, ribbon on top); accent one step lighter (`#C373FF` ink / `#B24BFF` paper); app is sans only (Literata moves to the reader); reader adds original/publisher font, PT Serif, Bitter, Lato, Open Sans (budget 3 MB); smaller type scale; calmer books screen with one filter & sort sheet; all reader settings behind one button; new full-screen, self-ending finish (~2.8 s). | Author feedback on the preview. |
| 2026-11-14 | Final mark: closed book (b), off-white strokes (stroke 11) and purple ribbon on ink. Literata stays the reader default. OpenDyslexic ships in the app. Settings → reader exposes every in-book reader setting plus app-wide ones (fonts, custom themes, fixed-layout defaults); both edit the same global values. Design phase closed. | Author feedback round 2. |
