# Windows acceptance checklist

Use a Windows 10/11 x64 test computer and copies of your ebooks. Keep the original folders intact. The repository's automated fixtures cover representative parser and workflow cases, while this checklist exercises WebView2 and Windows dialogs.

## Installation and sources

- [ ] Install and launch both the NSIS and MSI packages on a Windows test machine. Verify that each installer can set up WebView2 offline.
- [ ] Extract the portable ZIP to a writable folder and launch Deft.exe on a machine with WebView2. Verify that its database, cache and WebView2 profile live under DeftData beside the executable. Close Deft, move the extracted folder, and verify that the library data opens from the moved folder.
- [ ] Compare each downloaded package against SHA256SUMS.txt.
- [ ] Start Deft again and verify that it focuses the existing window. Check narrow and maximized window sizes, system light/dark mode, display scaling and keyboard focus.
- [ ] Add a folder with nested EPUB, TXT, FB2, MOBI, AZW, AZW3, PDF, DjVu and CBZ fixtures. Include a Unicode filename and a duplicate with a different name.
- [ ] Exclude and re-include a subfolder. Move a book, edit a copy in place, delete a copy, disconnect a drive and rescan. Verify that duplicates share history, missing books retain it, and changed content creates a separate Book.
- [ ] Record file hashes before and after changing book details, cover, rating and notes. They should match.

## Reading and organization

- [ ] Open each test format. Verify TOCs and links, reflow fonts/themes, search, page controls and saved position after reopening. Test fixed fit modes, crop, invert, note and zoom, and CBZ right-to-left navigation.
- [ ] Open a password-protected PDF with an incorrect password and then the correct password. Verify that a protected EPUB or Kindle file is labelled and its reader stays closed.
- [ ] Read for over a minute, switch windows, wait, then return. Verify that the inactive segment is excluded. Test idle cutoff, screen lock, brief visits, crash checkpoint recovery and a browse session on a finished book.
- [ ] Mark a book finished with a date, edit the read-through, and re-read it. Test bookmarks, all highlight colors, Markdown note export and jumping from Notes into a book.
- [ ] Create same-named categories, add a custom type, merge authors/categories, confirm or dismiss suggested series entries, set a decimal position, and check the next book.
- [ ] Check stats across two date ranges, yearly and daily goals, a missing book and an ignored book. Verify that browsing time appears only on the book's session list.

## Transfer and release

- [ ] Export a backup; restore into a clean app data directory. Re-add the source folders and rescan. Verify that notes, ratings, reader preferences, covers/fonts, and reading history survive.
- [ ] Try invalid and newer-schema ZIPs and verify that restore leaves the current library intact. Enable weekly backup and verify retention in the target folder.
- [ ] With an internet connection, match a known ISBN and a title-only book. Confirm a candidate, optionally download a cover, and try a CSV in your chosen import service. Disconnect again and verify that regular reading works.
- [ ] Export a default profile and one with opted-in reviews and notes. Check that neither contains file paths, provider tokens, or session locators.
- [ ] For a signed release, verify package and executable signatures on Windows with `Get-AuthenticodeSignature`.
