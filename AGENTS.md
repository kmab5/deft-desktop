# Deft Desktop contributor guide

The Android plans under `plans/` describe product behavior and the original visual system. The [desktop scope](docs/desktop-implementation.md) records Windows-specific choices.

- Read source books in place, read-only. Separate editable metadata and history from the files.
- Identify books by exact SHA-256 content. Missing files preserve reading history. Explicitly forgetting a Book is the only permanent deletion of its history.
- Keep HTTP access in `crates/deft-core/src/matching.rs`. Lookups and cover downloads are initiated by a user.
- Detect protected formats and never decrypt DRM. PDF user passwords are handled locally.
- Keep native file access inside the Tauri boundary. Sanitize imported publication HTML before rendering it.
- Run `npm run check`, `npm test`, `npm run build`, `cargo fmt --all -- --check` and `cargo test --locked -p deft-core`. Use the Windows workflow and native acceptance checklist for release work.
