#Requires -Version 5.1
<#
.SYNOPSIS
  One-stop acceptance run for the portable AI drawing workbench kit.

.DESCRIPTION
  Runs, in order:
    1. install/probe.mjs        (DSH Desktop / Node / SDK version matrix)
    2. plugin unit tests        (official Electron Node, MOSS_SDK_PACKAGE from app.asar)
    3. verify/cold-load.cjs     (real official loader, fake profile, zero network)
    4. verify/client-load.cjs   (real official browser module runtime, in-memory transport)
    5. verify/sanitize-scan.mjs (personal/private data scan of the shipped source)
    6. dist package integrity   (tarball hash + extracted tree vs package-manifest.json)
  Evidence JSON + logs are written to -OutDir (default: <KitRoot>/verification).
  Nothing here restarts DSH, submits GPU work, or touches the user's real profile.

.PARAMETER KitRoot
  Kit root (the directory that contains plugin/, install/, verify/, dist/). Default: parent of this script.

.PARAMETER DesktopDir
  Official Desktop install directory. Default: $env:LOCALAPPDATA\Programs\DeepSeek Harness or $env:DSH_DESKTOP_DIR.

.PARAMETER DshHome
  Optional DSH home for the probe's profile summary. The probe works without it.

.PARAMETER Profile
  Profile name used only to report what the probe sees. Default: desktop.

.PARAMETER OutDir
  Evidence directory. Default: <KitRoot>\verification.

.PARAMETER SkipPackage
  Skip step 6 when dist/ has not been rebuilt yet.

.PARAMETER RequireVerifiedVersion
  Fail when the probe reports a DSH version outside the verified matrix.
#>
[CmdletBinding()]
param(
  [string]$KitRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$DesktopDir,
  [string]$DshHome,
  [string]$Profile = 'desktop',
  [string]$OutDir,
  [switch]$SkipPackage,
  [switch]$RequireVerifiedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$kit = (Resolve-Path -LiteralPath $KitRoot).Path
if (-not $OutDir) { $OutDir = Join-Path $kit 'verification' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

if (-not $DesktopDir) {
  if ($env:DSH_DESKTOP_DIR) { $DesktopDir = $env:DSH_DESKTOP_DIR }
  elseif ($env:LOCALAPPDATA) { $DesktopDir = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
}
if (-not $DesktopDir) { throw 'DesktopDir is required (pass -DesktopDir or set DSH_DESKTOP_DIR).' }
$desktopExe = Join-Path $DesktopDir 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { throw "Desktop executable not found: $desktopExe" }
$asarPackage = Join-Path $DesktopDir 'resources\app.asar\dsh\package.json'
# app.asar is an archive: PowerShell cannot Test-Path inside it, so only check the archive itself.
if (-not (Test-Path -LiteralPath (Join-Path $DesktopDir 'resources\app.asar') -PathType Leaf)) { throw "app.asar not found under: $DesktopDir\resources" }

$env:ELECTRON_RUN_AS_NODE = '1'
$env:MOSS_SDK_PACKAGE = $asarPackage
$steps = [ordered]@{}
$startedAt = (Get-Date).ToString('o')

function Read-Json([string]$Path) { [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
function Invoke-Tool([string[]]$Arguments, [string]$Log, [string]$WorkDir) {
  $previous = (Get-Location).Path
  try {
    if ($WorkDir) { Set-Location -LiteralPath $WorkDir }
    # The Desktop binary is a GUI-subsystem executable: capturing "& exe" in a
    # variable can detach before exit. Piping through Out-String makes PowerShell
    # wait, so $LASTEXITCODE and the full stdout/stderr are reliable.
    $output = (& $desktopExe @Arguments 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
    if ($Log) { [System.IO.File]::WriteAllText($Log, ($output -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false)) }
    return [pscustomobject]@{ exitCode = $exitCode; output = $output }
  } finally {
    Set-Location -LiteralPath $previous
  }
}

function Add-Step([string]$Name, [bool]$Pass, $Data) {
  $steps[$Name] = [pscustomobject]@{ pass = $Pass; data = $Data }
  if ($Pass) { Write-Host "[verify] PASS $Name" -ForegroundColor Green }
  else { Write-Host "[verify] FAIL $Name" -ForegroundColor Red }
}

# ---------------------------------------------------------------- 1. probe
if ($steps.Count -eq 0) { Write-Host "[verify] kit: $kit" }
$probeLog = Join-Path $OutDir 'probe.log'
$probeOut = Join-Path $OutDir 'probe.json'
$probeArgs = @((Join-Path $kit 'install\probe.mjs'), '--desktop-dir', $DesktopDir, '--json', '--out', $probeOut)
if ($DshHome) { $probeArgs += @('--dsh-home', $DshHome, '--profile', $Profile) }
$probeRun = Invoke-Tool $probeArgs $probeLog
$probePass = $probeRun.exitCode -eq 0
$probeDecision = 'unknown'
if (Test-Path -LiteralPath $probeOut -PathType Leaf) {
  $probe = Read-Json $probeOut
  $probeDecision = $probe.decision
  if ($probeRun.exitCode -eq 2 -and -not $RequireVerifiedVersion) {
    Write-Host "[verify] WARN DSH $($probe.dshPackage.version) is outside the verified matrix ($($probe.verifiedDshVersions -join ' / ')); not failing without -RequireVerifiedVersion" -ForegroundColor Yellow
    $probePass = $true
  }
  if ($probeRun.exitCode -eq 2 -and $RequireVerifiedVersion) { $probePass = $false }
}
Add-Step 'probe' $probePass ([pscustomobject]@{ exitCode = $probeRun.exitCode; decision = $probeDecision; evidence = $probeOut })

# ---------------------------------------------------------------- 2. unit tests
$unitLog = Join-Path $OutDir 'unit-tests.log'
$testRun = Invoke-Tool @('--test', (Join-Path $kit 'plugin\tests\*.test.mjs')) $unitLog (Join-Path $kit 'plugin')
$counts = [ordered]@{ tests = 0; pass = 0; fail = 0; skipped = 0; cancelled = 0; todo = 0 }
# Node 24's spec reporter prefixes summary lines with the info glyph U+2139, older
# output uses "#"; accept both.
foreach ($match in [regex]::Matches($testRun.output, '(?m)^(?:#|\u2139)\s+(tests|pass|fail|skipped|cancelled|todo)\s+(\d+)\s*$')) {
  $counts[$match.Groups[1].Value] = [int]$match.Groups[2].Value
}
$unitPass = ($testRun.exitCode -eq 0) -and ($counts.fail -eq 0) -and ($counts.tests -gt 0)
Add-Step 'unit-tests' $unitPass ([pscustomobject]@{ exitCode = $testRun.exitCode; counts = $counts; evidence = $unitLog })

# ---------------------------------------------------------------- 3. cold load
$coldOut = Join-Path $OutDir 'cold-load.json'
$coldLog = Join-Path $OutDir 'cold-load.log'
$coldRun = Invoke-Tool @((Join-Path $kit 'verify\cold-load.cjs'), '--kit', $kit, '--desktop-dir', $DesktopDir, '--work', (Join-Path $kit '.verify-work'), '--out', $coldOut) $coldLog
$coldPass = $coldRun.exitCode -eq 0 -and (Test-Path -LiteralPath $coldOut -PathType Leaf)
$coldSummary = $null
if ($coldPass) {
  $coldSummary = Read-Json $coldOut
  $coldPass = [bool]$coldSummary.pass
}
Add-Step 'cold-load' $coldPass ([pscustomobject]@{ exitCode = $coldRun.exitCode; evidence = $coldOut; summary = $coldSummary })

# ---------------------------------------------------------------- 4. client load
$clientOut = Join-Path $OutDir 'client-load.json'
$clientLog = Join-Path $OutDir 'client-load.log'
$clientRun = Invoke-Tool @((Join-Path $kit 'verify\client-load.cjs'), '--kit', $kit, '--desktop-dir', $DesktopDir, '--work', (Join-Path $kit '.verify-work'), '--out', $clientOut) $clientLog
$clientPass = $clientRun.exitCode -eq 0 -and (Test-Path -LiteralPath $clientOut -PathType Leaf)
$clientSummary = $null
if ($clientPass) {
  $clientSummary = Read-Json $clientOut
  $clientPass = [bool]$clientSummary.pass
}
Add-Step 'client-load' $clientPass ([pscustomobject]@{ exitCode = $clientRun.exitCode; evidence = $clientOut; summary = $clientSummary })

# ---------------------------------------------------------------- 5. sanitize scan
$scanOut = Join-Path $OutDir 'sanitize-scan.json'
$scanLog = Join-Path $OutDir 'sanitize-scan.log'
$scanRun = Invoke-Tool @((Join-Path $kit 'verify\sanitize-scan.mjs'), '--dir', (Join-Path $kit 'plugin'), '--out', $scanOut) $scanLog
$scanPass = $scanRun.exitCode -eq 0
$scanSummary = $null
if (Test-Path -LiteralPath $scanOut -PathType Leaf) { $scanSummary = Read-Json $scanOut }
Add-Step 'sanitize-scan' $scanPass ([pscustomobject]@{ exitCode = $scanRun.exitCode; evidence = $scanOut; hits = $scanSummary.hitCount })

# ---------------------------------------------------------------- 6. package integrity
if ($SkipPackage) {
  Add-Step 'package-integrity' $true ([pscustomobject]@{ skipped = $true })
} else {
  $tgz = Get-ChildItem -LiteralPath (Join-Path $kit 'dist') -Filter '*.tgz' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $tgz) {
    Add-Step 'package-integrity' $false ([pscustomobject]@{ error = 'no dist/*.tgz found; run dist/build-package.mjs first' })
  } else {
    $extractDir = Join-Path $OutDir 'tgz-extract'
    if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
    $tarExit = 0
    try {
      & tar -xzf $tgz.FullName -C $extractDir 2>&1 | Out-Null
      $tarExit = $LASTEXITCODE
    } catch {
      Write-Host "[verify] WARN tar extraction failed: $($_.Exception.Message)" -ForegroundColor Yellow
      $tarExit = 1
    }
    $pkgOut = Join-Path $OutDir 'package-integrity.json'
    $pkgLog = Join-Path $OutDir 'package-integrity.log'
    $pkgArgs = @((Join-Path $kit 'verify\verify-package.mjs'), '--kit', $kit, '--tgz', $tgz.FullName, '--out', $pkgOut)
    if ($tarExit -eq 0) { $pkgArgs += @('--extract', $extractDir) }
    $pkgRun = Invoke-Tool $pkgArgs $pkgLog
    $pkgPass = $pkgRun.exitCode -eq 0
    $pkgSummary = $null
    if (Test-Path -LiteralPath $pkgOut -PathType Leaf) { $pkgSummary = Read-Json $pkgOut }
    $scanTgzOut = Join-Path $OutDir 'sanitize-scan-tgz.json'
    $scanTgzPass = $false
    if ($tarExit -eq 0) {
      $scanTgzRun = Invoke-Tool @((Join-Path $kit 'verify\sanitize-scan.mjs'), '--dir', (Join-Path $extractDir 'package'), '--out', $scanTgzOut) (Join-Path $OutDir 'sanitize-scan-tgz.log')
      $scanTgzPass = $scanTgzRun.exitCode -eq 0
    }
    Add-Step 'package-integrity' ($pkgPass -and $scanTgzPass) ([pscustomobject]@{ exitCode = $pkgRun.exitCode; evidence = $pkgOut; tarExit = $tarExit; tgzScanPass = $scanTgzPass; summary = $pkgSummary })
  }
}

# ---------------------------------------------------------------- summary
$failed = @($steps.Keys | Where-Object { -not $steps[$_].pass })
$summary = [pscustomobject]@{
  schema = 1
  kit = $kit
  desktopDir = $DesktopDir
  dshHome = $DshHome
  profile = $Profile
  asarPackage = $asarPackage
  startedAt = $startedAt
  finishedAt = (Get-Date).ToString('o')
  host = [pscustomobject]@{ node = (Get-Item $desktopExe).VersionInfo.FileVersion; electronNode = $null }
  pass = ($failed.Count -eq 0)
  failedSteps = $failed
  steps = $steps
}
$summaryFile = Join-Path $OutDir 'verify-summary.json'
[System.IO.File]::WriteAllText($summaryFile, ($summary | ConvertTo-Json -Depth 30) + "`n", (New-Object System.Text.UTF8Encoding $false))
Write-Host ''
if ($summary.pass) {
  Write-Host "[verify] ALL CHECKS PASSED -> $summaryFile" -ForegroundColor Green
  exit 0
} else {
  Write-Host "[verify] FAILED steps: $($failed -join ', ') -> $summaryFile" -ForegroundColor Red
  exit 1
}
