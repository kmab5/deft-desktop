# Third-party components

Deft Desktop is GPL-3.0-only. Dependency versions and transitive packages are listed in the checked-in npm and Cargo lockfiles.

| Component | License |
| --- | --- |
| Tauri | Apache-2.0 or MIT |
| React, Foliate format parser, fflate, djvu-rs / djvu-bzz | MIT |
| PDF.js, including local rendering workers | Apache-2.0 |
| Lucide icons | ISC |
| DOMPurify | Apache-2.0 or MPL-2.0 |
| SQLite | Public domain |
| Space Grotesk, Space Mono and bundled reader fonts | SIL Open Font License 1.1 |

The frontend build preserves PDF.js CMap/font/decoder resource notices and font and renderer licenses under `reader-support/`. The build installs dependencies from their package registries; running the installed app uses local assets.
