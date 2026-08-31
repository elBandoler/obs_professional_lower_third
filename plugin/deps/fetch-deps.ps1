# Fetches the build-time dependencies that are not vendored in this repo:
#   - OBS Studio's libobs + obs-frontend-api headers (from the tagged source zip)
#   - civetweb 1.16 amalgamated source (already vendored under plugin/vendor —
#     re-run only if plugin/vendor/civetweb is missing)
# Run this once before build.ps1 on a fresh clone. Safe to re-run.

$ErrorActionPreference = "Stop"
$P = Split-Path $PSScriptRoot -Parent   # plugin/
$OBS_TAG = "32.1.0"
$dl = "$PSScriptRoot\dl"
New-Item -ItemType Directory -Force $dl, "$PSScriptRoot\obs\config" | Out-Null

if (-not (Test-Path "$PSScriptRoot\obs\libobs\obs-module.h")) {
    Write-Output "Downloading OBS Studio $OBS_TAG source (headers only are used)..."
    $zip = "$dl\obs-studio.zip"
    if (-not (Test-Path $zip)) {
        curl.exe -sL -o $zip "https://github.com/obsproject/obs-studio/archive/refs/tags/$OBS_TAG.zip"
    }
    Expand-Archive $zip "$dl\obs-x" -Force
    $src = "$dl\obs-x\obs-studio-$OBS_TAG"
    Copy-Item "$src\libobs" "$PSScriptRoot\obs\libobs" -Recurse -Force
    New-Item -ItemType Directory -Force "$PSScriptRoot\obs\frontend" | Out-Null
    Copy-Item "$src\frontend\api\obs-frontend-api.h" "$PSScriptRoot\obs\frontend\"
    Write-Output "  done."
} else {
    Write-Output "OBS headers already present, skipping."
}

if (-not (Test-Path "$P\vendor\civetweb\civetweb.c")) {
    Write-Output "Downloading civetweb 1.16 source..."
    $zip = "$dl\civetweb.zip"
    if (-not (Test-Path $zip)) {
        curl.exe -sL -o $zip "https://github.com/civetweb/civetweb/archive/refs/tags/v1.16.zip"
    }
    Expand-Archive $zip "$dl\cw-x" -Force
    New-Item -ItemType Directory -Force "$P\vendor\civetweb" | Out-Null
    $src = "$dl\cw-x\civetweb-1.16"
    Copy-Item "$src\include\civetweb.h" "$P\vendor\civetweb\"
    Copy-Item "$src\src\*.inl" "$P\vendor\civetweb\"
    Copy-Item "$src\src\civetweb.c" "$P\vendor\civetweb\"
    Write-Output "  done."
} else {
    Write-Output "civetweb source already present, skipping."
}

if (-not (Test-Path "$P\vendor\json\json.hpp")) {
    Write-Output "Downloading nlohmann/json single header..."
    New-Item -ItemType Directory -Force "$P\vendor\json" | Out-Null
    curl.exe -sL -o "$P\vendor\json\json.hpp" "https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp"
    Write-Output "  done."
} else {
    Write-Output "json.hpp already present, skipping."
}

Write-Output "`nAll dependencies ready. Next: powershell -ExecutionPolicy Bypass -File plugin\build.ps1"
