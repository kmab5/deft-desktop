# M1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable Deft app that scans user-chosen folders, identifies books by content hash, extracts EPUB metadata, survives deleted/moved/duplicated files, and lists books on a Books screen.

**Architecture:** Gradle multi-module Android project (convention plugins in `build-logic/`). Pure-Kotlin domain in `core/model`; Room in `core/database`; DataStore in `core/datastore`; the scanner in `library/scanner` works against a `DocumentTree` abstraction so its logic is JVM-testable, with a SAF implementation for the device. Compose UI in `feature/*`, wired by Hilt in `app`.

**Tech Stack:** Kotlin, Jetpack Compose + Material 3, Navigation Compose, Hilt, Room (KSP), DataStore (Preferences), WorkManager, Coil 3 (no network artifact), JUnit 5 (pure JVM modules), JUnit 4 + Robolectric (Android modules), Compose UI tests, ktlint + detekt, GitHub Actions. Use the latest **stable** version of each, pinned in `gradle/libs.versions.toml`.

**Spec:** `plans/2026-11-13-deft-design.md` (sections §3, §5, §6, §14, §15, §16). Roadmap: `plans/2026-11-13-deft-roadmap.md`.

## Global Constraints

- Application ID and root package: `com.kmab.deft`. Module packages: `com.kmab.deft.<module path with dots>` (e.g. `com.kmab.deft.core.model`).
- `minSdk = 26`; `compileSdk`/`targetSdk` = latest stable; JVM toolchain 17.
- License GPL-3.0-only. Every dependency must be GPL-3.0-compatible (Apache-2.0, BSD, MIT, LGPL, GPL-2.0-or-later). No Google Play Services, Firebase, analytics, or crash reporters (F-Droid).
- No network: the merged app manifest must **not** contain `android.permission.INTERNET` in M1 (remove it with `tools:node="remove"` if a library adds it). No module may depend on an HTTP client (OkHttp, Ktor client, Retrofit, Volley, coil-network-*).
- Storage via SAF persisted tree URIs only; never request `MANAGE_EXTERNAL_STORAGE` or `READ_EXTERNAL_STORAGE`.
- Deft never writes to, renames, or deletes a book file.
- The 9 formats, exactly: EPUB, MOBI, AZW, AZW3, FB2, TXT (reflowable); PDF, DJVU, CBZ (fixed). Extensions: `epub`; `mobi`, `prc`; `azw`; `azw3`, `kf8`; `fb2`, `fb2.zip`; `txt`; `pdf`; `djvu`, `djv`; `cbz`. RTF and LIT are not recognized.
- Deleting a `BookFile` never deletes a `Book`. A `Book` is identified only by the SHA-256 of its content; a changed file is a different Book.
- Commits: author `Samuel Worash Getaneh <samuelworash@gmail.com>`, Conventional Commits style (`feat:`, `fix:`, `test:`, `build:`, `docs:`, `refactor:`).

## Review Focus

1. **Removable storage / revoked permission:** a root folder that can't be opened (SD card unmounted, permission revoked) must not mark its books missing; the scan reports it as unavailable. → test in Task 7 (`unavailableRootDoesNotMarkFilesMissing`).
2. **Corrupt or non-EPUB file with `.epub` extension, zero-byte files:** scanning must not crash or abort the scan; the book is added with filename-derived metadata and the error is counted. → tests in Task 5 (`malformedZipThrowsMetadataException`) and Task 7 (`corruptFileStillAddedWithFilenameMetadata`).
3. **Same content in two folders, then one deleted:** one Book, never missing while one copy exists. → Task 7 (`duplicateContentIsOneBook`, `deletingOneCopyKeepsBookPresent`).
4. **File moved between folders:** history-bearing Book reattaches, stale BookFile pruned. → Task 7 (`movedFileReattachesSameBook`).
5. **Large libraries:** 5 000 entries scan without loading all hashes into memory at once and the Books list stays a lazy list. → Task 7 (`scanOf5000UnchangedFilesHashesNothing`), Task 10 uses `LazyVerticalGrid`/`LazyColumn` with stable keys.

---

### Task 1: Project skeleton, design system, CI

**Files:**
- Create: `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/libs.versions.toml`, Gradle wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`)
- Create: `build-logic/convention/build.gradle.kts`, `build-logic/settings.gradle.kts`, convention plugins `deft.android.application`, `deft.android.library`, `deft.android.compose`, `deft.android.hilt`, `deft.android.room`, `deft.jvm.library` under `build-logic/convention/src/main/kotlin/`
- Create: `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `app/src/main/kotlin/com/kmab/deft/DeftApplication.kt`, `.../MainActivity.kt`
- Create: `core/designsystem/` module: `DeftTheme.kt`, `Color.kt`, `Type.kt`
- Create: `config/detekt/detekt.yml`, `.editorconfig`
- Create: `.github/workflows/ci.yml`
- Test: `app/src/test/kotlin/com/kmab/deft/SmokeTest.kt`

**Interfaces:**
- Produces: `@Composable fun DeftTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit)`; convention plugin IDs above; `@HiltAndroidApp class DeftApplication`; `@AndroidEntryPoint class MainActivity` hosting a `NavHost` (start destination `"books"`).

- [ ] **Step 1:** Create the root Gradle files, version catalog, and convention plugins. Declare modules in `settings.gradle.kts`: `:app`, `:core:model`, `:core:common`, `:core:database`, `:core:datastore`, `:core:designsystem`, `:format:epub`, `:library:scanner`, `:feature:library`, `:feature:settings`. Create empty modules as needed so the build configures.
- [ ] **Step 2:** `DeftTheme` from `plans/2026-11-13-deft-visual-design.md`: `DeftColors` ink/paper exactly per its §2.2 (no dynamic colour), `DeftTypography` per §3.1 with Space Grotesk and Space Mono bundled as subset `res/font` resources (§3; reader fonts arrive in M2), `DeftShapes` per §4, `DeftMotion` tokens per §9. Test: `ContrastTest` asserts every text/background pair in §2.2 ≥ 4.5:1 and every state colour ≥ 3:1 on `bg` in both themes.
- [ ] **Step 2b:** App icon: adaptive + monochrome layers using mark (b), colourway 1 unless the author has picked, per visual design §6.
- [ ] **Step 3:** `MainActivity` shows `DeftTheme { Text("Deft") }` inside the NavHost placeholder.
- [ ] **Step 4:** Write `SmokeTest` (Robolectric): launching `MainActivity` doesn't crash and displays "Deft".
- [ ] **Step 5:** Run `./gradlew :app:testDebugUnitTest`. Expected: PASS.
- [ ] **Step 6:** Configure ktlint and detekt in convention plugins, wired into `check`. Run `./gradlew check`. Expected: BUILD SUCCESSFUL.
- [ ] **Step 7:** `ci.yml`: on push to any branch, run on `ubuntu-latest` with JDK 17: `./gradlew check assembleDebug assembleRelease` (release unsigned until M10 adds signing + the tag-triggered GitHub Release job). Cache Gradle.
- [ ] **Step 7b:** Versioning: `app/build.gradle.kts` reads `deft.version=A.B.C-D` from `gradle.properties` (start at `0.1.0-1`), sets `versionName = "A.B.C"` and `versionCode = A*1_000_000 + B*10_000 + C*100 + D`; a `VersionTest` in `build-logic` asserts `0.1.0-1 → 10001` and `1.2.3-4 → 1020304`, and rejects D outside 1..99.
- [ ] **Step 8:** Commit `build: scaffold multi-module project, theme and CI`.

### Task 2: Domain model

**Files:**
- Create: `core/model/src/main/kotlin/com/kmab/deft/core/model/BookFormat.kt`, `ContentHash.kt`, `AuthorNames.kt`, `SortTitle.kt`, `ExtractedMetadata.kt`
- Test: `core/model/src/test/kotlin/.../BookFormatTest.kt`, `AuthorNamesTest.kt`, `SortTitleTest.kt`

**Interfaces:**
- Produces:
  - `enum class LayoutKind { REFLOWABLE, FIXED }`
  - `enum class BookFormat(val displayName: String, val extensions: List<String>, val layout: LayoutKind) { EPUB, MOBI, AZW, AZW3, FB2, TXT, PDF, DJVU, CBZ }` with the extensions from Global Constraints (settings shows one checkbox per entry); `companion fun fromFileName(name: String): BookFormat?` (case-insensitive, `fb2.zip` matched before `zip`-less forms).
  - `@JvmInline value class ContentHash(val hex: String)` — 64 lowercase hex chars, validated in `init`.
  - `object AuthorNames { fun display(raw: String): String; fun normalizedKey(raw: String): String; fun sortName(display: String): String }`
  - `fun sortTitle(title: String): String`
  - `enum class BookSort { TITLE, AUTHOR, DATE_ADDED }`
  - `data class ExtractedMetadata(val title: String?, val authors: List<String>, val seriesName: String?, val seriesIndex: Double?, val language: String?, val publisher: String?, val publishedDate: String?, val description: String?, val isbn10: String?, val isbn13: String?, val pageCount: Int?, val coverImage: ByteArray?, val drmProtected: Boolean)` with a `companion val EMPTY`.

- [ ] **Step 1: Write failing tests:**
  - `fromFileName("Book.EPUB") == EPUB`, `fromFileName("x.fb2.zip") == FB2`, `fromFileName("a.djv") == DJVU`, `fromFileName("a.prc") == MOBI`, `fromFileName("a.kf8") == AZW3`, `fromFileName("a.rtf") == null`, `fromFileName("a.lit") == null`, `fromFileName("noext") == null`.
  - `AuthorNames.display("Sanderson, Brandon") == "Brandon Sanderson"`; `display("  Brandon   Sanderson ") == "Brandon Sanderson"`; `display("Le Guin, Ursula K.") == "Ursula K. Le Guin"`; `display("Smith, Jr., John")` returns the input whitespace-collapsed unchanged (more than one comma ⇒ no flip).
  - `normalizedKey("Brandon Sanderson") == normalizedKey("SANDERSON, Brandon") == normalizedKey("Brandon  Sanderson")`; `normalizedKey("José Saramago") == normalizedKey("Jose Saramago")`.
  - `sortName("Brandon Sanderson") == "Sanderson, Brandon"`; `sortName("Plato") == "Plato"`.
  - `sortTitle("The Way of Kings") == "way of kings"`, `sortTitle("A Memory of Light") == "memory of light"`, `sortTitle("An Ember") == "ember"`, `sortTitle("Theory") == "theory"`.
  - `ContentHash("abc")` throws `IllegalArgumentException`.
- [ ] **Step 2:** Run `./gradlew :core:model:test`. Expected: FAIL (unresolved references).
- [ ] **Step 3:** Implement. `normalizedKey`: apply `display`, NFKD-normalize, strip combining marks, lowercase, replace runs of non-alphanumerics with one space, trim.
- [ ] **Step 4:** Run `./gradlew :core:model:test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(model): book formats, content hash, author and title normalization`.

### Task 3: Hashing and time

**Files:**
- Create: `core/common/src/main/kotlin/com/kmab/deft/core/common/ContentHasher.kt`, `TimeSource.kt`, `DispatchersModule.kt`
- Test: `core/common/src/test/kotlin/.../ContentHasherTest.kt`

**Interfaces:**
- Produces:
  - `class ContentHasher { fun hash(input: InputStream): ContentHash }` — streaming SHA-256, 64 KiB buffer, closes nothing (caller owns the stream).
  - `fun interface TimeSource { fun now(): Instant }` with `object SystemTimeSource : TimeSource`.
  - Hilt qualifiers `@IoDispatcher`, `@DefaultDispatcher` providing `CoroutineDispatcher`.

- [ ] **Step 1: Failing test:** hash of empty stream == `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; hash of `"deft".toByteArray()` equals `MessageDigest` SHA-256 of the same bytes; a 10 MB stream hashes without `OutOfMemoryError` under a 64 MB test heap (use a generating `InputStream`).
- [ ] **Step 2:** Run `./gradlew :core:common:test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(common): streaming content hasher and time source`.

### Task 4: Library database

**Files:**
- Create in `core/database/src/main/kotlin/com/kmab/deft/core/database/`: `AppDatabase.kt`, `entity/BookEntity.kt`, `entity/BookFileEntity.kt`, `entity/AuthorEntity.kt`, `entity/AuthorAliasEntity.kt`, `entity/BookAuthorEntity.kt`, `entity/LibraryFolderEntity.kt`, `dao/BookDao.kt`, `dao/BookFileDao.kt`, `dao/AuthorDao.kt`, `dao/LibraryFolderDao.kt`, `model/BookListItem.kt`, `Converters.kt`, `DatabaseModule.kt`
- Create: `core/database/schemas/` (Room schema export, committed)
- Test: `core/database/src/test/kotlin/.../BookDaoTest.kt`, `BookFileDaoTest.kt`, `AuthorDaoTest.kt`

**Interfaces:**
- Consumes: `BookFormat`, `ContentHash` (Task 2).
- Produces (DB version 1):
  - `BookEntity(id: Long = 0, contentHash: String /*unique*/, format: BookFormat, title: String, sortTitle: String, titleOverride: String?, language: String?, publisher: String?, publishedDate: String?, description: String?, isbn10: String?, isbn13: String?, pageCount: Int?, coverPath: String?, coverOverridePath: String?, extractedSeriesName: String?, extractedSeriesIndex: Double?, drmProtected: Boolean, ignored: Boolean = false, metadataError: String?, addedAt: Instant, lastOpenedAt: Instant?)`
  - `BookFileEntity(id: Long = 0, bookId: Long /*FK, NO cascade delete from file to book*/, rootUri: String, uri: String /*unique*/, displayPath: String, size: Long, lastModified: Long, missing: Boolean, lastSeenAt: Instant)`
  - `AuthorEntity(id, name, sortName, normalizedName /*unique*/)`, `AuthorAliasEntity(aliasNormalizedName /*PK*/, authorId)`, `BookAuthorEntity(bookId, authorId, position: Int, overridden: Boolean)` PK `(bookId, authorId)`
  - `LibraryFolderEntity(treeUri: String /*PK*/, displayName: String, addedAt: Instant)`
  - `ExcludedFolderEntity(treeUri: String, documentId: String, displayPath: String)` PK `(treeUri, documentId)`, FK `treeUri` → `LibraryFolderEntity` ON DELETE CASCADE; `LibraryFolderDao` gains `observeExclusions(treeUri)`, `addExclusion`, `removeExclusion`.
  - `BookListItem(id, title /* = titleOverride ?: title */, sortTitle, authorsDisplay: String /* "A, B" in position order */, format, coverPath, addedAt, missing: Boolean, drmProtected)` — ignored books are **never** returned by `observeList` (spec §6.2).
  - `BookDao`: `suspend fun findByHash(hash: String): BookEntity?`, `suspend fun insert(book: BookEntity): Long`, `fun observeList(includeMissing: Boolean, formats: Set<BookFormat>, sort: BookSort): Flow<List<BookListItem>>`, `suspend fun isMissing(bookId: Long): Boolean`.
  - `BookFileDao`: `findByUri`, `insert`, `update`, `suspend fun markMissingUnderRootsExcept(rootUris: List<String>, seenUris: Set<String>)` (implement as two statements in a `@Transaction` using a temp table or chunked `IN` lists of ≤ 900 to respect SQLite variable limits), `suspend fun markMissingForRoot(rootUri: String)`, `suspend fun pruneMissingWherePresentCopyExists()`, `fun observeForBook(bookId: Long): Flow<List<BookFileEntity>>`.
  - `AuthorDao`: `suspend fun getOrCreate(rawName: String): Long` (`@Transaction`, resolves aliases by `AuthorNames.normalizedKey`), `suspend fun setBookAuthors(bookId: Long, rawNames: List<String>)`.
  - A Book is **missing** iff it has no `BookFileEntity` with `missing = 0`.

- [ ] **Step 1: Failing tests** (Robolectric, in-memory DB):
  - `deletingBookFileKeepsBook`: insert book + file, delete file row → `findByHash` still returns the book; `isMissing` is true.
  - `bookWithOnePresentCopyIsNotMissing`: two files, one `missing = true` → `isMissing == false`, `observeList(includeMissing=false, …)` contains the book once.
  - `missingBooksHiddenByDefault`: book whose only file is missing is absent from `observeList(includeMissing=false)` and present with `missing=true` when `includeMissing=true`.
  - `pruneRemovesStaleCopiesOnly`: book with present file A and missing file B → prune deletes B; book with only missing file C → C kept.
  - `markMissingUnderRootsExcept`: 2 000 files under root R, 1 999 seen → exactly one marked missing (proves chunking past 999 variables).
  - `authorAliasesResolve`: `getOrCreate("Sanderson, Brandon")` and `getOrCreate("Brandon Sanderson")` return the same id.
  - `titleOverrideWins`: list item title equals override when set.
  - `ignoredBooksNeverListed`: `ignored = true` → absent from `observeList` for both `includeMissing` values.
  - `sortByAuthorUsesFirstAuthorSortName`.
- [ ] **Step 2:** Run `./gradlew :core:database:testDebugUnitTest` → FAIL.
- [ ] **Step 3:** Implement entities, DAOs, `Converters` (Instant↔epoch millis, BookFormat↔name), `AppDatabase(version = 1, exportSchema = true)`, Hilt `DatabaseModule` (file name `deft.db`).
- [ ] **Step 4:** Run → PASS. Confirm `core/database/schemas/.../1.json` exists.
- [ ] **Step 5:** Commit `feat(database): library schema v1 with content-hash identity`.

### Task 5: EPUB metadata extractor

**Files:**
- Create: `format/epub/src/main/kotlin/com/kmab/deft/format/epub/EpubMetadataExtractor.kt`, `OpfParser.kt`
- Create: `core/model/src/main/kotlin/.../MetadataExtractor.kt` (interface)
- Test: `format/epub/src/test/kotlin/.../EpubMetadataExtractorTest.kt`, `format/epub/src/testFixtures/kotlin/.../TestEpubBuilder.kt` (builds EPUB bytes in memory: `mimetype`, `META-INF/container.xml`, OPF, optional cover, optional `encryption.xml`)

**Interfaces:**
- Produces:
  - In `core/model`: `interface MetadataExtractor { val formats: Set<BookFormat>; fun extract(input: InputStream, fileName: String): ExtractedMetadata }` and `class MetadataException(message: String, cause: Throwable? = null) : Exception(message, cause)`.
  - `class EpubMetadataExtractor : MetadataExtractor` (formats = `{EPUB}`). Pure JVM: `java.util.zip.ZipInputStream` (stream may not be seekable — buffer entries needed: container.xml, the OPF, the cover item, encryption.xml; skip others) and a namespace-aware XML pull parser (`org.xmlpull` via `kxml2`, or `javax.xml` — builder's choice; must run in JVM unit tests).
  - `TestEpubBuilder` fluent API: `.title(String) .creator(String, fileAs: String? = null) .calibreSeries(String, Double) .collection(String, Double) .isbn(String) .language(String) .cover(ByteArray) .encryption(algorithm: String) .build(): ByteArray`.

- [ ] **Step 1: Failing tests:**
  - EPUB2 with `dc:title "Mistborn"`, two `dc:creator`s → title and both authors in order.
  - `calibre:series "Mistborn"` + `calibre:series_index "2"` → `seriesName == "Mistborn"`, `seriesIndex == 2.0`.
  - EPUB3 `belongs-to-collection` "The Stormlight Archive" with `collection-type series` and `group-position 1.5` → series and 1.5.
  - `dc:identifier` `urn:isbn:9780765326355` → `isbn13 == "9780765326355"`; a 10-char ISBN → `isbn10`; a UUID identifier → both null.
  - Cover via EPUB3 `properties="cover-image"` and via EPUB2 `<meta name="cover" content="id">` → `coverImage` bytes equal input.
  - `encryption.xml` with algorithm `http://www.idpf.org/2008/embedding` or `http://ns.adobe.com/pdf/enc#RC` → `drmProtected == false` (font obfuscation); with `http://www.w3.org/2001/04/xmlenc#aes128-cbc` → `true`; presence of `META-INF/rights.xml` or `META-INF/license.lcpl` → `true`.
  - `malformedZipThrowsMetadataException`: random bytes and a zero-byte stream → `MetadataException`.
  - Missing OPF title → `title == null` (caller falls back to filename).
- [ ] **Step 2:** Run `./gradlew :format:epub:test` → FAIL.
- [ ] **Step 3:** Implement. Description: strip HTML tags to plain text.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(epub): EPUB metadata extraction with series, ISBN, cover and DRM detection`.

### Task 6: Filename heuristics and extractor registry

**Files:**
- Create: `library/scanner/src/main/kotlin/com/kmab/deft/library/scanner/FilenameMetadata.kt`, `MetadataExtractorRegistry.kt`, `CoverStore.kt`
- Test: `library/scanner/src/test/kotlin/.../FilenameMetadataTest.kt`, `MetadataExtractorRegistryTest.kt`

**Interfaces:**
- Consumes: `MetadataExtractor`, `ExtractedMetadata`, `BookFormat`.
- Produces:
  - `object FilenameMetadata { fun parse(fileName: String): ExtractedMetadata }` — fills `title`, `authors`, `seriesName`, `seriesIndex` only.
  - `class MetadataExtractorRegistry(extractors: Set<MetadataExtractor>) { fun extract(format: BookFormat, input: InputStream, fileName: String): Pair<ExtractedMetadata, String?> }` — returns merged metadata (extractor fields win, filename fills nulls/empty) and an error message if the extractor threw; never throws. Formats without an extractor use filename heuristics only (M1: all but EPUB).
  - `interface CoverStore { suspend fun save(hash: ContentHash, image: ByteArray): String? }` with `FileCoverStore(dir: File)` — decodes, downscales to max 600 px on the long edge, writes `covers/<hex>.jpg` at quality 85, returns absolute path; returns null if undecodable. (Android `BitmapFactory`; test with Robolectric.)

- [ ] **Step 1: Failing tests** (`parse`):
  - `"Mistborn - 02 - The Well of Ascension.epub"` → series "Mistborn", index 2.0, title "The Well of Ascension".
  - `"The Final Empire (Mistborn #1).epub"` → title "The Final Empire", series "Mistborn", index 1.0.
  - `"Brandon Sanderson - Elantris.epub"` → author "Brandon Sanderson", title "Elantris".
  - `"elantris_[retail].epub"` → title "elantris".
  - `"Dune.fb2.zip"` → title "Dune".
  - Registry: EPUB extractor throws → result has filename title and non-null error; EPUB with null title → filename title used; PDF (no extractor) → filename metadata, null error.
- [ ] **Step 2:** Run `./gradlew :library:scanner:testDebugUnitTest` → FAIL.
- [ ] **Step 3:** Implement. Rule order for `parse`: strip extension (incl. `.fb2.zip`), replace `_` with space, remove bracket tags `[retail|epub|pdf|scan|ocr|v\d+|\d{4}]` case-insensitively, then try `Series - NN - Title`, then `Title (Series #N)`, then `Author - Title` (only when exactly one ` - `), else whole stem is title.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(scanner): filename metadata heuristics, extractor registry, cover store`.

### Task 7: Library scanner core

**Files:**
- Create: `library/scanner/src/main/kotlin/.../DocumentTree.kt`, `LibraryScanner.kt`, `ScanReport.kt`, `BookRepository.kt`
- Test: `library/scanner/src/test/kotlin/.../LibraryScannerTest.kt`, `FakeDocumentTree.kt`

**Interfaces:**
- Consumes: `ContentHasher`, `MetadataExtractorRegistry`, `CoverStore`, DAOs (Task 4), `TimeSource`.
- Produces:
  - `data class DocumentEntry(val uri: String, val rootUri: String, val displayPath: String, val name: String, val size: Long, val lastModified: Long)`
  - `interface DocumentTree { suspend fun isAccessible(rootUri: String): Boolean; fun walk(rootUri: String, excludedDocumentIds: Set<String>): Flow<DocumentEntry>; fun open(uri: String): InputStream }` (`walk` recurses all subfolders except excluded subtrees, emits files only)
  - `data class ScanReport(val added: Int, val updated: Int, val unchanged: Int, val reattached: Int, val markedMissing: Int, val errors: Int, val unavailableRoots: List<String>)`
  - `class LibraryScanner(tree, hasher, registry, coverStore, db: AppDatabase, time: TimeSource) { suspend fun scan(roots: List<String>, formats: Set<BookFormat>, removedRoots: List<String> = emptyList()): ScanReport }`
  - `class BookRepository(db) { fun observeBooks(includeMissing: Boolean, formats: Set<BookFormat>, sort: BookSort): Flow<List<BookListItem>> }` — thin wrapper used by UI.

- [ ] **Step 1: Failing tests** (`FakeDocumentTree` = in-memory map of root → entries with byte contents; real in-memory Room DB):
  - `newEpubIsAdded`: one EPUB → 1 book with extracted title/author, cover saved, report `added == 1`.
  - `disabledFormatIgnored`: `formats = {PDF}` → EPUB not added.
  - `unrecognizedExtensionsIgnored`: `.rtf`, `.lit`, `.jpg` → nothing added.
  - `unchangedFileIsNotRehashed`: second scan with same size/lastModified → hasher not called (spy), `unchanged == 1`.
  - `scanOf5000UnchangedFilesHashesNothing`: 5 000 pre-indexed entries → zero hash calls, completes.
  - `duplicateContentIsOneBook`: same bytes in two roots → 1 book, 2 files.
  - `deletingOneCopyKeepsBookPresent`: remove one copy, rescan → book not missing, stale file row pruned.
  - `deletedFileMarksBookMissing`: remove only copy → `isMissing == true`, `markedMissing == 1`; book row still exists.
  - `movedFileReattachesSameBook`: rescan with file at a new uri → same book id, `reattached == 1`, not missing, old file row pruned.
  - `restoredFileReattaches`: file missing after scan 1, reappears in scan 3 → same book id.
  - `changedContentIsNewBook`: same uri, different bytes/size → new book id; the old book is missing (spec §6.2); report `updated == 1`.
  - `unavailableRootDoesNotMarkFilesMissing`: `isAccessible == false` → files untouched, root listed in `unavailableRoots`.
  - `removedRootMarksItsFilesMissing`: passing it in `removedRoots` → its books missing.
  - `excludedSubfolderMarksItsFilesMissing`: exclude `root/manuals` after a scan → its books missing, siblings untouched; remove the exclusion and rescan → same book ids, present.
  - `ignoredBookStaysIgnoredAcrossRescans`: set `ignored` on a book, rescan (including after its file moves) → still ignored, same id.
  - `corruptFileStillAddedWithFilenameMetadata`: garbage `.epub` → added, title from filename, `metadataError` set, `errors == 1`, scan continues to next file.
  - `drmEpubFlagged`: EPUB with AES `encryption.xml` → `drmProtected == true`.
- [ ] **Step 2:** Run `./gradlew :library:scanner:testDebugUnitTest` → FAIL.
- [ ] **Step 3:** Implement `scan`:
  ```
  for root in roots:
    if !tree.isAccessible(root): unavailable += root; continue
    seen = mutableSet
    tree.walk(root, exclusionsFor(root)) filtered by BookFormat.fromFileName(name) in formats:
      existing = fileDao.findByUri(uri); seen += uri
      if existing != null && existing.size == size && existing.lastModified == lastModified:
        if existing.missing → set present (count reattached); else count unchanged; touch lastSeenAt; continue
      hash = tree.open(uri).use(hasher::hash)            // IO errors: count error, continue
      book = bookDao.findByHash(hash) ?: createBook(entry, hash)   // extract metadata, save cover, set authors
      if existing != null: update existing → bookId=book.id, size, lastModified, missing=false (count updated)
      else: insert file (count added if book new, else reattached if book was missing, else added-copy counts as unchanged)
    fileDao.markMissingUnderRootsExcept([root], seen)
  for r in removedRoots: fileDao.markMissingForRoot(r)
  fileDao.pruneMissingWherePresentCopyExists()
  ```
  Each file's DB writes run in one transaction. Never load all entries into a list.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(scanner): content-hash library scanner with missing and reattach handling`.

### Task 8: Settings, SAF folders, background scanning

**Files:**
- Create: `core/datastore/src/main/kotlin/com/kmab/deft/core/datastore/LibrarySettings.kt`, `LibrarySettingsRepository.kt`
- Create: `library/scanner/src/main/kotlin/.../SafDocumentTree.kt`, `LibraryFolderRepository.kt`, `ScanWorker.kt`, `ScanScheduler.kt`, `ScannerModule.kt`
- Test: `core/datastore/src/test/kotlin/.../LibrarySettingsRepositoryTest.kt`, `library/scanner/src/test/kotlin/.../ScanSchedulerTest.kt`, `ScanWorkerTest.kt`

**Interfaces:**
- Produces:
  - `data class LibrarySettings(val enabledFormats: Set<BookFormat> = BookFormat.entries.toSet(), val showMissing: Boolean = false, val sort: BookSort = BookSort.TITLE, val gridView: Boolean = true, val lastScanAt: Instant? = null)`
  - `class LibrarySettingsRepository { val settings: Flow<LibrarySettings>; suspend fun setFormatEnabled(f: BookFormat, enabled: Boolean); suspend fun setShowMissing(Boolean); suspend fun setSort(BookSort); suspend fun setGridView(Boolean); suspend fun setLastScanAt(Instant) }`
  - `class LibraryFolderRepository { val folders: Flow<List<LibraryFolderEntity>>; suspend fun add(treeUri: Uri) /* takePersistableUriPermission(READ) then insert */; suspend fun remove(treeUri: String) /* release permission, delete row, enqueue scan with removedRoots */ }`
  - `class SafDocumentTree(context) : DocumentTree` — uses `DocumentsContract` child-document queries (not `DocumentFile.listFiles()`, which is too slow for large trees); `displayPath` = folder display name + relative path.
  - `class ScanScheduler(workManager, settings, time) { fun scanNow(removedRoots: List<String> = emptyList()); suspend fun scanOnStartIfStale() /* only if lastScanAt is null or older than 6 h */ }` — unique work name `"library-scan"`, policy `KEEP` for automatic, `REPLACE` for manual.
  - `@HiltWorker class ScanWorker` runs `LibraryScanner.scan`, writes `lastScanAt`, outputs `ScanReport` fields as work data.
- [ ] **Step 1: Failing tests:** settings defaults (all 9 formats enabled, grid view, title sort); toggling a format persists; `scanOnStartIfStale` enqueues when `lastScanAt` is null or 7 h old and does not enqueue at 5 h (fake `TimeSource`, `WorkManagerTestInitHelper`); `ScanWorker` with a fake tree returns success and stores `lastScanAt`.
- [ ] **Step 2:** Run `./gradlew :core:datastore:testDebugUnitTest :library:scanner:testDebugUnitTest` → FAIL.
- [ ] **Step 3:** Implement. `DeftApplication` provides a Hilt `WorkerFactory`; `MainActivity.onCreate` calls `scanOnStartIfStale()`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(library): SAF folders, settings and background scanning`.

### Task 9: Settings → Library screen

**Files:**
- Create: `feature/settings/src/main/kotlin/com/kmab/deft/feature/settings/SettingsScreen.kt`, `LibrarySettingsScreen.kt`, `LibrarySettingsViewModel.kt`, `SettingsNavigation.kt`
- Test: `feature/settings/src/test/kotlin/.../LibrarySettingsViewModelTest.kt`, `feature/settings/src/androidTest/kotlin/.../LibrarySettingsScreenTest.kt`

**Interfaces:**
- Consumes: `LibraryFolderRepository`, `LibrarySettingsRepository`, `ScanScheduler`.
- Produces: routes `"settings"` and `"settings/library"`; `fun NavGraphBuilder.settingsGraph(navController: NavController)`.

Screen content (spec §6.1, §14): "Folders" list with display names and a remove (×) action with confirmation ("Books in this folder will be marked missing. Their history is kept."); "Add folder" launches `ActivityResultContracts.OpenDocumentTree`; each folder row expands to its **excluded subfolders** with "Exclude a subfolder" (opens `OpenDocumentTree` with the root as initial URI; reject a pick that isn't inside that root with "Pick a folder inside <root>") and a remove action per exclusion — adding or removing an exclusion schedules a scan; "File types" with one checkbox per `BookFormat` (labels: EPUB, MOBI/PRC, AZW, AZW3, FB2, TXT, PDF, DjVu, CBZ); "Rescan now" button showing a progress indicator while the unique work is running and the last `ScanReport` summary after ("Added 12 · Missing 1 · 0 errors"). The Settings root lists only "Library" in M1.

- [ ] **Step 1: Failing tests:** ViewModel — removing a folder calls repository `remove` and the scheduler with that root in `removedRoots`; toggling a format updates settings and schedules a scan. Exclusions — a pick outside the root is rejected with "Pick a folder inside <root>"; a valid pick is stored and schedules a scan. Compose test — 9 format checkboxes exist; tapping "Rescan now" calls `scanNow()`.
- [ ] **Step 2:** Run `./gradlew :feature:settings:testDebugUnitTest` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run unit tests → PASS; run `./gradlew :feature:settings:connectedDebugAndroidTest` on an emulator if available, otherwise run the Compose test under Robolectric.
- [ ] **Step 5:** Commit `feat(settings): library folders, file types and rescan`.

### Task 10: Books screen

**Files:**
- Create: `feature/library/src/main/kotlin/com/kmab/deft/feature/library/BooksScreen.kt`, `BooksViewModel.kt`, `BookCard.kt`, `BookRow.kt`, `LibraryNavigation.kt`
- Modify: `app/.../MainActivity.kt` (NavHost with `"books"` start + settings graph; top-bar overflow → Settings)
- Test: `feature/library/src/test/kotlin/.../BooksViewModelTest.kt`, `feature/library/src/androidTest/kotlin/.../BooksScreenTest.kt`

**Interfaces:**
- Consumes: `BookRepository.observeBooks`, `LibrarySettingsRepository`, `ScanScheduler`.
- Produces: `data class BooksUiState(val books: List<BookListItem>, val gridView: Boolean, val sort: BookSort, val showMissing: Boolean, val formatFilter: Set<BookFormat>, val isScanning: Boolean, val hasFolders: Boolean)`; route `"books"`.

Screen (spec §14; M1 subset): top bar "Deft" with sort menu (Title / Author / Date added), grid/list toggle, overflow (Show missing toggle, Settings). Format filter chips. `LazyVerticalGrid` (adaptive min 110 dp) or `LazyColumn`, keyed by book id. Card: cover via Coil from `coverPath` (placeholder: title on a tinted block), title, first author; badges "File missing" and "Protected". Pull-to-refresh → `scanNow()`. Empty states: no folders → "Add a folder to build your library" button to `settings/library`; folders but no books → "No books found in your folders" + Rescan. Books are not clickable in M1 (the reader and book page arrive in M2).

- [ ] **Step 1: Failing tests:** ViewModel combines settings + books (sort change re-queries; `showMissing` toggles inclusion; `hasFolders=false` when folder list empty). Compose: empty-state button navigates to `settings/library`; a missing book shows "File missing"; switching to list view shows rows.
- [ ] **Step 2:** Run `./gradlew :feature:library:testDebugUnitTest` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Then `./gradlew installDebug`, add a folder with a few EPUBs on a device/emulator, and verify the M1 acceptance list in the roadmap by hand.
- [ ] **Step 5:** Commit `feat(library): Books screen with grid/list, sort, filters and empty states`.

### Task 11: Network isolation guard

**Files:**
- Create: `build-logic/convention/src/main/kotlin/NetworkIsolationCheck.kt` (a task registered on the root project and wired into `check`)
- Modify: `app/src/main/AndroidManifest.xml` (`<uses-permission android:name="android.permission.INTERNET" tools:node="remove"/>`)
- Test: the task itself; a CI run.

**Interfaces:**
- Produces: Gradle task `:checkNetworkIsolation` — fails if any project other than `:data:matching` has a resolved runtime dependency in group `com.squareup.okhttp3`, `io.ktor` (client artifacts), `com.squareup.retrofit2`, `com.android.volley`, or `io.coil-kt.coil3:coil-network-*`; and fails if `app`'s merged release manifest contains `android.permission.INTERNET` while `:data:matching` is not a dependency of `:app`.

- [ ] **Step 1:** Add a temporary `implementation(libs.okhttp)` to `:core:common`; run `./gradlew checkNetworkIsolation`. Expected: FAIL naming `:core:common` and okhttp.
- [ ] **Step 2:** Implement until Step 1 fails as described, then remove the temporary dependency; run `./gradlew check`. Expected: PASS.
- [ ] **Step 3:** Commit `build: guard against network dependencies outside data/matching`.

---

## Done when
- `./gradlew check assembleRelease` passes locally and in CI.
- The roadmap's M1 acceptance list is verified on a device or emulator.
- The design doc's Decision log records any decision that changed during M1.
