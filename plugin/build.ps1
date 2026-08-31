# Builds obs-lowerthirds.dll against the locally installed OBS Studio.
# Requires: VS Build Tools 2022 (C++ workload) and OBS Studio 28+ installed.

$ErrorActionPreference = "Stop"
$P = $PSScriptRoot
$OBSBIN = "C:\Program Files\obs-studio\bin\64bit"

if (-not (Test-Path "$OBSBIN\obs.dll")) { throw "OBS not found at $OBSBIN" }

if (-not (Test-Path "$P\deps\obs\libobs\obs-module.h") -or -not (Test-Path "$P\vendor\civetweb\civetweb.c") -or -not (Test-Path "$P\vendor\json\json.hpp")) {
    Write-Output "Fetching build dependencies (first run)..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$P\deps\fetch-deps.ps1"
    if ($LASTEXITCODE -ne 0) { throw "fetch-deps.ps1 failed" }
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsroot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsroot) { throw "MSVC toolchain not found (install VS Build Tools C++ workload)" }
$vcvars = "$vsroot\VC\Auxiliary\Build\vcvars64.bat"

$build = "$P\build"
$dist = "$P\dist\obs-lowerthirds"
New-Item -ItemType Directory -Force "$build", "$P\deps\lib", "$dist\bin\64bit", "$dist\data" | Out-Null

# ---------------------------------------------------------------- def files
function Make-ImportLib([string]$dllName, [string]$outBase) {
    $expFile = "$P\deps\lib\$outBase.exports.txt"
    $defFile = "$P\deps\lib\$outBase.def"
    cmd /c "call `"$vcvars`" >nul 2>nul && dumpbin /nologo /exports `"$OBSBIN\$dllName`" > `"$expFile`""
    if ($LASTEXITCODE -ne 0) { throw "dumpbin failed for $dllName" }
    $names = @()
    foreach ($line in Get-Content $expFile) {
        if ($line -match '^\s+\d+\s+[0-9A-Fa-f]+\s+(?:[0-9A-Fa-f]{8}\s+)?(\S+)') {
            $n = $Matches[1]
            if ($n -ne 'name' -and $n -notmatch '^\[') { $names += $n }
        }
    }
    if ($names.Count -lt 10) { throw "suspiciously few exports parsed from $dllName ($($names.Count))" }
    $def = "LIBRARY $dllName`r`nEXPORTS`r`n" + (($names | ForEach-Object { "    $_" }) -join "`r`n") + "`r`n"
    [IO.File]::WriteAllText($defFile, $def)
    cmd /c "call `"$vcvars`" >nul 2>nul && lib /nologo /def:`"$defFile`" /machine:x64 /out:`"$P\deps\lib\$outBase.lib`""
    if ($LASTEXITCODE -ne 0) { throw "lib.exe failed for $dllName" }
    Write-Output "  import lib: $outBase.lib ($($names.Count) exports)"
}

if (-not (Test-Path "$P\deps\lib\obs.lib")) { Make-ImportLib "obs.dll" "obs" }
if (-not (Test-Path "$P\deps\lib\obs-frontend-api.lib")) { Make-ImportLib "obs-frontend-api.dll" "obs-frontend-api" }

# ------------------------------------------------------------------ compile
$inc = "/I`"$P\deps\obs\libobs`" /I`"$P\deps\obs\config`" /I`"$P\deps\obs\frontend`" /I`"$P\vendor\civetweb`" /I`"$P\vendor\json`""
$defs = "/DWIN32_LEAN_AND_MEAN /DNOMINMAX /D_CRT_SECURE_NO_WARNINGS /DUNICODE /D_UNICODE"
$cwdefs = "/DUSE_WEBSOCKET /DNO_SSL /DNO_CGI"

$bat = @"
@echo off
call "$vcvars" >nul 2>nul
cd /d "$build"
echo === compiling civetweb (C)...
cl /nologo /c /O2 /MD /W2 $defs $cwdefs /I"$P\vendor\civetweb" "$P\vendor\civetweb\civetweb.c" /Fo"$build\civetweb.obj"
if errorlevel 1 exit /b 1
echo === compiling plugin (C++)...
cl /nologo /c /O2 /MD /EHsc /std:c++17 /utf-8 /W3 $defs $cwdefs $inc "$P\src\lt-state.cpp" "$P\src\lt-server.cpp" "$P\src\lt-source.cpp" "$P\src\plugin-main.cpp"
if errorlevel 1 exit /b 1
echo === linking...
link /nologo /DLL /OUT:"$dist\bin\64bit\obs-lowerthirds.dll" civetweb.obj lt-state.obj lt-server.obj lt-source.obj plugin-main.obj "$P\deps\lib\obs.lib" "$P\deps\lib\obs-frontend-api.lib" ws2_32.lib shell32.lib advapi32.lib user32.lib gdi32.lib
if errorlevel 1 exit /b 1
echo === build ok
"@
$batFile = "$build\build.bat"
[IO.File]::WriteAllText($batFile, $bat)
cmd /c "`"$batFile`""
if ($LASTEXITCODE -ne 0) { throw "BUILD FAILED" }

# ---------------------------------------------------------------- data tree
Remove-Item "$dist\data\public" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$P\..\public" "$dist\data\public" -Recurse -Force
Write-Output "dist ready: $dist"
Get-ChildItem "$dist\bin\64bit" | Select-Object Name, Length | Format-Table -AutoSize
