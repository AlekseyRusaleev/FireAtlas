$ErrorActionPreference = "Stop"

if ($env:TAURI_ENV_PLATFORM -and $env:TAURI_ENV_PLATFORM -ne "windows") {
    exit 0
}

if ($env:CARGO_TARGET_DIR) {
    $targetRoot = if ([System.IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
        $env:CARGO_TARGET_DIR
    } else {
        Join-Path (Get-Location) $env:CARGO_TARGET_DIR
    }
} else {
    $targetRoot = Join-Path $PSScriptRoot "target"
}

$arch = switch ($env:TAURI_ENV_ARCH) {
    "x86" { "x86" }
    "i686" { "x86" }
    "aarch64" { "arm64" }
    default { "x64" }
}

$releaseDir = Join-Path $targetRoot "release"
$buildDir = Join-Path $releaseDir "build"
$loader = Get-ChildItem $buildDir -Filter "WebView2Loader.dll" -File -Recurse |
    Where-Object { $_.DirectoryName -like "*\out\$arch" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $loader) {
    throw "WebView2Loader.dll ($arch) not found under $buildDir"
}

$destination = Join-Path $releaseDir "WebView2Loader.dll"
Copy-Item $loader.FullName $destination -Force
Write-Host "WebView2Loader.dll copied to $destination"
