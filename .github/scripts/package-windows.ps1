$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$tag = $env:DEFT_TAG
if ($tag -cnotmatch '^v(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?<build>[1-9][0-9]?))?$') {
    throw 'Use a release tag of the form vA.B.C or vA.B.C-D, with D between 1 and 99.'
}
$major = [int]$Matches.major
$minor = [int]$Matches.minor
$patch = [int]$Matches.patch
$build = if ($Matches.ContainsKey('build')) { [int]$Matches.build } else { 0 }
$version = "$major.$minor.$patch"
$msiPatch = ([long]$patch * 100) + $build
if ($major -gt 255 -or $minor -gt 255 -or $msiPatch -gt 65535) {
    throw "Release $tag exceeds Windows Installer version limits."
}

$root = (Resolve-Path "$PSScriptRoot/../..").Path
Push-Location $root
try {
    $nodeVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $lock = Get-Content package-lock.json -Raw | ConvertFrom-Json -AsHashtable
    $tauriVersion = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
    $cargoInfo = cargo metadata --locked --no-deps --format-version 1 | ConvertFrom-Json
    $desktop = $cargoInfo.packages | Where-Object name -eq 'deft-desktop'
    $core = $cargoInfo.packages | Where-Object name -eq 'deft-core'
    $versions = @($nodeVersion, $lock.version, $lock.packages[''].version, $tauriVersion, $desktop.version, $core.version)
    if (@($versions | Where-Object { $_ -ne $version }).Length -ne 0) {
        throw "Tag $tag requires version $version in package.json, package-lock.json, src-tauri/tauri.conf.json and Cargo.toml/Cargo.lock."
    }

    # MSI compares three fields. Encoding the desktop build counter in the third
    # keeps vA.B.C-D installers upgradeable without changing the app's semver.
    $windows = @{ wix = @{ version = "$major.$minor.$msiPatch" } }
    $temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
    $configFile = Join-Path $temp "deft-tauri-$([guid]::NewGuid()).json"
    if ($env:DEFT_SIGNING_PFX) {
        if (-not $env:DEFT_SIGNING_PASSWORD) { throw 'Set DEFT_SIGNING_PASSWORD with DEFT_SIGNING_PFX.' }
        $pfx = Join-Path $temp "deft-$([guid]::NewGuid()).pfx"
        try {
            [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:DEFT_SIGNING_PFX))
            $password = ConvertTo-SecureString $env:DEFT_SIGNING_PASSWORD -AsPlainText -Force
            $certificate = Import-PfxCertificate -FilePath $pfx -Password $password -CertStoreLocation Cert:\CurrentUser\My |
                Where-Object HasPrivateKey | Select-Object -First 1
            if (!$certificate) { throw 'No signing certificate with a private key found.' }
            $windows.certificateThumbprint = $certificate.Thumbprint
            $windows.digestAlgorithm = 'sha256'
            $windows.timestampUrl = 'http://timestamp.digicert.com'
            $windows.tsp = $true
        } finally {
            Remove-Item $pfx -ErrorAction SilentlyContinue
        }
    }

    $target = 'x86_64-pc-windows-msvc'
    try {
        @{ bundle = @{ windows = $windows } } | ConvertTo-Json -Depth 6 | Set-Content $configFile
        npm run tauri build -- --target $target --bundles nsis,msi --ci --config $configFile -- --locked
    } finally {
        Remove-Item $configFile -ErrorAction SilentlyContinue
    }

    $compiled = Join-Path $cargoInfo.target_directory "$target/release"
    $nsis = @(Get-ChildItem "$compiled/bundle/nsis" -File -Filter '*-setup.exe')
    $msi = @(Get-ChildItem "$compiled/bundle/msi" -File -Filter '*.msi')
    $binary = @('deft-desktop.exe', 'Deft.exe') | ForEach-Object { Join-Path $compiled $_ } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($nsis.Length -ne 1 -or $msi.Length -ne 1 -or !$binary) {
        throw "Expected one NSIS installer, one MSI and the Deft executable in $compiled."
    }
    if ($windows.certificateThumbprint) {
        foreach ($file in @($nsis[0].FullName, $msi[0].FullName, $binary)) {
            $signature = Get-AuthenticodeSignature -LiteralPath $file
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $windows.certificateThumbprint) {
                throw "The expected Authenticode signature is missing or invalid on $file."
            }
        }
    }

    $prefix = "deft-$tag-windows-x64"
    $release = New-Item -ItemType Directory -Path 'release' -Force
    $setup = Join-Path $release.FullName "$prefix-setup.exe"
    $installer = Join-Path $release.FullName "$prefix.msi"
    $zip = Join-Path $release.FullName "$prefix-portable.zip"
    Copy-Item -LiteralPath $nsis[0].FullName -Destination $setup -Force
    Copy-Item -LiteralPath $msi[0].FullName -Destination $installer -Force

    $portable = New-Item -ItemType Directory -Path (Join-Path $temp "deft-portable-$([guid]::NewGuid())")
    try {
        Copy-Item -LiteralPath $binary -Destination (Join-Path $portable.FullName 'Deft.exe')
        Copy-Item -LiteralPath LICENSE -Destination (Join-Path $portable.FullName 'LICENSE.txt')
        $loader = Join-Path $compiled 'WebView2Loader.dll'
        if (Test-Path -LiteralPath $loader -PathType Leaf) {
            Copy-Item -LiteralPath $loader -Destination $portable.FullName
        }
        'Portable data directory enabled.' | Set-Content (Join-Path $portable.FullName 'portable.flag')
        @'
Deft Portable for Windows x64

Extract the entire ZIP into a folder you can write to, then open Deft.exe.
Keep portable.flag beside the executable. Deft stores its database, cache
and WebView2 profile in the DeftData folder next to the executable.
Close the installed edition before opening the portable edition.

The portable edition needs Microsoft Edge WebView2 Runtime. On a computer
without WebView2, use the bundled NSIS/MSI installer or install the runtime
from https://developer.microsoft.com/microsoft-edge/webview2/.
'@ | Set-Content (Join-Path $portable.FullName 'README.txt')
        Compress-Archive -Path "$($portable.FullName)/*" -DestinationPath $zip -Force
    } finally {
        Remove-Item -LiteralPath $portable.FullName -Recurse -Force
    }

    @($setup, $installer, $zip) | ForEach-Object {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_).Hash.ToLowerInvariant()
        "$hash  $([IO.Path]::GetFileName($_))"
    } | Set-Content -Encoding ascii (Join-Path $release.FullName 'SHA256SUMS.txt')
} finally {
    Pop-Location
}
