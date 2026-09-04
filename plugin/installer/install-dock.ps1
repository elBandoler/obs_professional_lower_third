# Registers (or removes, with -Remove) the "Lower Thirds" browser dock in OBS
# by editing ExtraBrowserDocks in %APPDATA%\obs-studio\user.ini.
# Safe: skips silently when OBS is running or the file layout is unexpected —
# the plugin's Tools -> "Lower Thirds Panel" menu item works regardless.
param(
    [switch]$Remove,
    [int]$Port = 3620
)

$ErrorActionPreference = "Stop"
$title = "Lower Thirds"
$url = "http://127.0.0.1:$Port/control"
# the redesigned dock, registered alongside the classic one
$title2 = "Lower Thirds Studio"
$url2 = "http://127.0.0.1:$Port/studio"

try {
    if (Get-Process obs64 -ErrorAction SilentlyContinue) {
        Write-Output "OBS is running - skipping dock registration (use Tools > Lower Thirds Panel, or re-run installer with OBS closed)."
        exit 0
    }

    $ini = Join-Path $env:APPDATA "obs-studio\user.ini"
    if (-not (Test-Path $ini)) {
        Write-Output "user.ini not found - skipping dock registration."
        exit 0
    }

    Copy-Item $ini "$ini.lowerthirds.bak" -Force

    $lines = [System.Collections.ArrayList]@(Get-Content $ini -Encoding UTF8)
    $inBW = $false
    $bwStart = -1
    $edLine = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]
        if ($l -match '^\[(.+)\]\s*$') {
            $inBW = ($Matches[1] -eq 'BasicWindow')
            if ($inBW) { $bwStart = $i }
            continue
        }
        if ($inBW -and $l -match '^ExtraBrowserDocks=(.*)$') { $edLine = $i }
    }

    # current dock list
    $docks = @()
    if ($edLine -ge 0) {
        $raw = ($lines[$edLine] -replace '^ExtraBrowserDocks=', '').Trim()
        if ($raw) {
            try { $docks = @((ConvertFrom-Json $raw)) } catch { $docks = @() }
        }
    }

    if ($Remove) {
        $docks = @($docks | Where-Object { $_.url -ne $url -and $_.title -ne $title -and $_.url -ne $url2 -and $_.title -ne $title2 })
    } else {
        foreach ($d in @(@{ title = $title; url = $url }, @{ title = $title2; url = $url2 })) {
            $exists = $docks | Where-Object { $_.url -eq $d.url }
            if (-not $exists) {
                $docks = @($docks) + [pscustomobject]@{
                    title = $d.title
                    url   = $d.url
                    uuid  = [guid]::NewGuid().ToString()
                }
            }
        }
    }

    $json = ConvertTo-Json -InputObject @($docks) -Compress -Depth 10
    if ($null -eq $json -or $docks.Count -eq 0) { $json = "[]" }
    $newLine = "ExtraBrowserDocks=$json"

    if ($edLine -ge 0) {
        $lines[$edLine] = $newLine
    } elseif ($bwStart -ge 0) {
        $lines.Insert($bwStart + 1, $newLine) | Out-Null
    } else {
        $lines.Add("") | Out-Null
        $lines.Add("[BasicWindow]") | Out-Null
        $lines.Add($newLine) | Out-Null
    }

    $text = ($lines -join "`r`n") + "`r`n"
    [IO.File]::WriteAllText($ini, $text, (New-Object System.Text.UTF8Encoding($false)))
    if ($Remove) { Write-Output "Dock entry removed." } else { Write-Output "Dock entry registered." }
} catch {
    Write-Output "Dock registration skipped: $($_.Exception.Message)"
    exit 0
}
