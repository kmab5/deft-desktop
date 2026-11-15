# Data exchange

## Goodreads CSV

The export uses the 24 columns listed in the Deft design, in their original order. Goodreads exports also contain optional purchase and recommendation columns. Dates use `YYYY/MM/DD`. Half-star ratings round up to a whole star, and the latest finish date and total number of finished read-throughs represent repeat reads. Source examples and import docs are linked below.

- [Goodreads import and export](https://www.goodreads.com/review/import)
- [Example Goodreads library export](https://github.com/bgstieber/files_for_blog/blob/master/goodreads-data-analysis/goodreads_library_export.csv)
- [StoryGraph import FAQ](https://thestorygraph.com/#faq)
- [Hardcover imports](https://hardcover.app/account/imports)

Deft exports abandoned books on `did-not-finish`. StoryGraph documents that shelf explicitly. Hardcover also accepts Goodreads imports, though its handling of custom abandoned shelf names can vary. Differently named local categories with the same CSV shelf slug share a shelf in the export.

## Reading Profile

The [v1 JSON Schema](deft-profile.schema.json) defines the [sample profile](deft-profile.example.json). Times use UTC RFC 3339 timestamps and durations are in active seconds. Book IDs are local SHA-256 content identifiers and identify a particular file version. Category member IDs refer to entries in the same profile. A co-authored book contributes its full time to each author and contributes once to overall time.

An edition match is a separate identity record. Its provider assigns the external identifiers. Include reviews and Include notes control whether those fields appear. The profile excludes book paths, files, settings, credentials, and per-session locators. The export is a portable summary and cannot restore a Deft library.

## Backup

A local backup ZIP contains `manifest.json` and a consistent copy of the SQLite library at `library.sqlite3`. The database includes reading history, notes, settings, imported fonts, cover images, and the list of source paths. The original books stay in their folders. Keep backups private if the library contains private notes or a Hardcover API token.

Restore replaces the current Deft library. Source files must still be available on the computer. After restore, adjust drive letters and folders if needed and rescan to reattach the files by content hash. Automatic backups use `deft-weekly-YYYY-MM-DD.zip` and rotate separately from manually created backups.
