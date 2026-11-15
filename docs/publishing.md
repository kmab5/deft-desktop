# Publishing Deft Desktop

## Windows release

The Windows workflow runs the TypeScript checks, frontend tests, Rust format check and core tests on branch pushes and pull requests. It builds the production frontend and links the desktop executable with x64 MSVC. Version tags run the same checks and package a release build. Actions labels branch runs **Windows CI** and tag runs **Windows release**. The release run summary links to the published packages.

Use tags `vA.B.C` or `vA.B.C-D`, with `D` between 1 and 99. Before tagging a changed app version, commit matching versions in `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` and `src-tauri/tauri.conf.json`. A packaging-only revision can use a new `D` without changing the app version. The MSI uses its third numerical version field to encode both the patch version and the packaging revision, so a packaging-only release can upgrade an earlier MSI. These tags must fit the Windows Installer version bounds.

For example, with version `0.1.0` committed to the release branch:

```sh
git tag -a v0.1.0-1 -m "Deft Desktop 0.1.0, build 1"
git push origin v0.1.0-1
```

After the checks and build pass, the workflow publishes these files to [GitHub Releases](https://github.com/kmab5/deft-desktop/releases).

| Asset | Usage |
| --- | --- |
| `deft-vA.B.C[-D]-windows-x64-setup.exe` | Current-user NSIS setup with offline WebView2 installation |
| `deft-vA.B.C[-D]-windows-x64.msi` | Windows Installer package with offline WebView2 installation |
| `deft-vA.B.C[-D]-windows-x64-portable.zip` | Extract and run on a computer with WebView2 installed |
| `SHA256SUMS.txt` | SHA-256 hashes for the three downloadable packages |

Releases with major version zero are marked as prereleases. Browse the full Releases list to find them. The product page links to the newest release that contains all three Windows packages and the checksum file. The workflow verifies the checksums and publishes the draft after the assets upload. A rerun preserves an already-published release that has all four assets.

Configure `DEFT_SIGNING_PFX` (base64 PFX) and `DEFT_SIGNING_PASSWORD` as repository Actions secrets to sign Windows binaries. When configured, the packaging step checks the Authenticode signatures before uploading. Without the secrets, the artifacts are unsigned. Use the [native Windows checklist](windows-acceptance.md) to test installation and first launch.

### Portable edition

Extract the ZIP to a writable folder and open `Deft.exe`. Keep `portable.flag` beside it. The database, cache and WebView2 profile are stored under `DeftData` in that folder. Installed Deft still uses its normal application data directory. Close the installed edition before starting portable Deft because they share the single-instance lock. Ebook locations remain absolute paths. If drive letters change, add the new source folder and rescan to reconnect books to their history.

## Product site

The static landing page and its assets are in `docs/`. On GitHub, select **Settings → Pages → Build and deployment → Source → GitHub Actions** once. The **Product site** workflow then deploys changes under `docs/` from `main`. Run it manually from the Actions tab for the first deployment if Pages was enabled after merging the workflow.

The published site is [kmab5.github.io/deft-desktop](https://kmab5.github.io/deft-desktop/). To preview locally from the project root, run `python -m http.server 8080 --directory docs` and open `http://localhost:8080/`.
