#Requires -Version 5.1
<#
.SYNOPSIS
  Install the portable AI drawing workbench plugin into a DSH Desktop profile.

.DESCRIPTION
  Copy plugin/ to a stable install root, write deployment-owned config values,
  link the package into the chosen profile, register it as a bundle dependency,
  and keep timestamped backups of everything it edits.

  The script never restarts DSH. Restart DSH normally after it succeeds.

.PARAMETER DshHome
  DSH home directory (contains profiles/).

.PARAMETER Profile
  Profile name that owns the bundle. Default: desktop.

.PARAMETER WorkspaceRoot
  Absolute directory the drawing plugin may read user images from.

.PARAMETER ComfyUrl
  Bare http(s) origin of the ComfyUI worker, for example http://127.0.0.1:8188.

.PARAMETER DataRoot
  Optional data directory (workbench SQLite, sessions, ledger, results).
  Default: <WorkspaceRoot>/private/workspace/moss-draw

.PARAMETER DesktopDir
  Official Desktop install directory. Default: $env:LOCALAPPDATA\Programs\DeepSeek Harness

.PARAMETER InstallRoot
  Where the plugin sources are copied. Default: <DshHome>/plugins/dsh-moss-draw

.PARAMETER Force
  Replace an existing install root / real directory link after backing it up.

.PARAMETER AllowUnverifiedVersion
  Continue when the Desktop DSH version is outside the verified matrix. This is a
  knowing override: compatibility is not claimed until cold-load passes there.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DshHome,
  [string]$Profile = 'desktop',
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$ComfyUrl,
  [string]$DataRoot,
  [string]$DesktopDir,
  [string]$InstallRoot,
  [string]$NodeExe,
  [switch]$Force,
  [switch]$AllowUnverifiedVersion,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pluginId = '@dsh-external/dsh-moss-draw'
$kitRoot = Split-Path -Parent $PSScriptRoot
$pluginSource = Join-Path $kitRoot 'plugin'
$adaptScript = Join-Path $PSScriptRoot 'adapt.mjs'
$probeScript = Join-Path $PSScriptRoot 'probe.mjs'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Step([string]$Message) { Write-Host "[install] $Message" }
function Read-Json([string]$Path) { [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
function Restore-NodeMode {
  if ($null -ne $script:previousElectronRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $script:previousElectronRunAsNode }
  else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
}
function Fail([int]$Code, [string]$Message) {
  Write-Host "[install] ERROR: $Message" -ForegroundColor Red
  Restore-NodeMode
  exit $Code
}
$script:previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE

# ---------------------------------------------------------------- validations
if (-not (Test-Path -LiteralPath $DshHome -PathType Container)) { Fail 3 "DshHome does not exist: $DshHome" }
$DshHome = (Resolve-Path -LiteralPath $DshHome).Path
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$profilePackageFile = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profilePackageFile -PathType Leaf)) { Fail 3 "Profile package.json not found: $profilePackageFile" }
# Validate the profile shape BEFORE touching anything, so a malformed profile
# cannot leave a junction plus a copied install root behind (exit 6 first).
$profilePackage = Read-Json $profilePackageFile
if (-not $profilePackage.PSObject.Properties['dsh'] -or $null -eq $profilePackage.dsh) { Fail 6 'Profile package.json has no dsh.profile section.' }
if (-not $profilePackage.dsh.PSObject.Properties['profile'] -or $null -eq $profilePackage.dsh.profile) { Fail 6 'Profile package.json has no dsh.profile section.' }
if (-not (Test-Path -LiteralPath $pluginSource -PathType Container)) { Fail 3 "Kit plugin/ directory not found: $pluginSource (run this script from inside the kit)" }
if (-not (Test-Path -LiteralPath $adaptScript -PathType Leaf)) { Fail 3 "install/adapt.mjs not found next to this script" }
if (-not (Test-Path -LiteralPath $probeScript -PathType Leaf)) { Fail 3 "install/probe.mjs not found next to this script" }

if (-not $DesktopDir) {
  if ($env:DSH_DESKTOP_DIR) { $DesktopDir = $env:DSH_DESKTOP_DIR }
  elseif ($env:LOCALAPPDATA) { $DesktopDir = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness' }
}
if (-not $DesktopDir) { Fail 3 'DesktopDir is required (pass -DesktopDir or set DSH_DESKTOP_DIR).' }
$desktopExe = Join-Path $DesktopDir 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) { Fail 3 "Desktop executable not found: $desktopExe" }

if (-not $InstallRoot) { $InstallRoot = Join-Path $DshHome 'plugins\dsh-moss-draw' }
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

$probeRunner = $desktopExe
if (-not $NodeExe) { $NodeExe = $desktopExe }
# The probe always runs through the Desktop binary, so this must be set no matter
# which NodeExe the operator chose for adapt.mjs (a GUI-mode launch would hang).
$env:ELECTRON_RUN_AS_NODE = '1'

Step "kit:            $kitRoot"
Step "DSH home:       $DshHome"
Step "profile:        $Profile ($profileDir)"
Step "desktop:        $desktopExe"
Step "workspaceRoot:  $([System.IO.Path]::GetFullPath($WorkspaceRoot))"
Step "comfyUrl:       $ComfyUrl"
Step "installRoot:    $InstallRoot"
Step "node runner:    $NodeExe (probe always uses the Desktop Electron binary)"
if ($DryRun) { Step 'DRY RUN: no files will be changed' }

# ---------------------------------------------------------------- probe
# The probe reads resources/app.asar, which only Electron's Node mode can do, so
# it always runs through the official Desktop executable.
$probeOut = Join-Path ([System.IO.Path]::GetTempPath()) "moss-probe-$stamp.json"
$probeArgs = @($probeScript, '--desktop-dir', $DesktopDir, '--dsh-home', $DshHome, '--profile', $Profile, '--json', '--out', $probeOut)
if ($AllowUnverifiedVersion) { $probeArgs += '--allow-unverified-version' }
Step 'probing DSH Desktop version and SDK packages'
& $probeRunner @probeArgs | Out-Host
$probeExit = $LASTEXITCODE
if ($probeExit -eq 1) { Fail 3 "Probe failed; see output above. Probe report: $probeOut" }
if ($probeExit -eq 2) { Fail 2 "DSH version is outside the verified matrix. Re-run with -AllowUnverifiedVersion only after you accept that compatibility is unverified. Probe report: $probeOut" }
if (-not (Test-Path -LiteralPath $probeOut -PathType Leaf)) { Fail 3 'Probe did not write a report.' }
$probe = Read-Json $probeOut

# ---------------------------------------------------------------- backups
$backupDir = Join-Path $DshHome (Join-Path 'system\backups' "portable-moss-draw-$stamp")
if ($DryRun) {
  Step "would back up profile package.json and any existing install root to $backupDir"
} else {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item -LiteralPath $profilePackageFile -Destination (Join-Path $backupDir 'package.json') -Force
  $profilePatchFile = Join-Path $profileDir 'cordis.patch.yml'
  if (Test-Path -LiteralPath $profilePatchFile -PathType Leaf) { Copy-Item -LiteralPath $profilePatchFile -Destination (Join-Path $backupDir 'cordis.patch.yml') -Force }
  Copy-Item -LiteralPath $probeOut -Destination (Join-Path $backupDir 'probe.json') -Force
  if (Test-Path -LiteralPath $InstallRoot) {
    $existing = Get-Item -LiteralPath $InstallRoot
    Step "backing up existing install root ($($existing.FullName))"
    Move-Item -LiteralPath $InstallRoot -Destination (Join-Path $backupDir 'install-root') -Force
  }
  Step "backup: $backupDir"
}

# ---------------------------------------------------------------- copy plugin
if ($DryRun) {
  Step "would copy $pluginSource -> $InstallRoot"
} else {
  Step 'copying plugin sources'
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  & robocopy $pluginSource $InstallRoot /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  $copyExit = $LASTEXITCODE
  if ($copyExit -ge 8) { Fail 4 "robocopy failed with exit code $copyExit while copying $pluginSource -> $InstallRoot" }
}

# ---------------------------------------------------------------- adapt config
# In -DryRun the install root is not created, so adapt the kit's pristine source
# instead: adapt's --dry-run mode only validates and never writes the file.
$adaptTarget = if ($DryRun) { $pluginSource } else { $InstallRoot }
$receiptFile = if ($DryRun) { Join-Path ([System.IO.Path]::GetTempPath()) "moss-adapt-$stamp.json" } else { Join-Path $backupDir 'adapt-receipt.json' }
$adaptArgs = @($adaptScript, '--plugin-dir', $adaptTarget, '--workspace-root', $WorkspaceRoot, '--comfy-url', $ComfyUrl, '--receipt', $receiptFile)
if ($DataRoot) { $adaptArgs += @('--data-root', $DataRoot) }
if ($DryRun) { $adaptArgs += '--dry-run' }
Step 'writing deployment config placeholders'
& $NodeExe @adaptArgs | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 4 'adapt.mjs failed; cordis.patch.yml was not adapted.' }

# ---------------------------------------------------------------- link + profile
$linkParent = Join-Path $profileDir 'node_modules\@dsh-external'
$linkPath = Join-Path $linkParent 'dsh-moss-draw'
$linkValue = "link:$($InstallRoot -replace '\\', '/')"

if ($DryRun) {
  Step "would link $linkPath -> $InstallRoot"
  Step "would add dependency $pluginId = $linkValue"
  Step "would append $pluginId to dsh.profile.bundles in $profilePackageFile"
} else {
  Step 'linking plugin into profile node_modules'
  New-Item -ItemType Directory -Force -Path $linkParent | Out-Null
  if (Test-Path -LiteralPath $linkPath) {
    $existingLink = Get-Item -LiteralPath $linkPath -Force
    if ($existingLink.LinkType -in @('Junction', 'SymbolicLink')) {
      $existingLink.Delete()
    } elseif ($Force) {
      Move-Item -LiteralPath $linkPath -Destination (Join-Path $backupDir 'node-modules-existing') -Force
    } else {
      Fail 5 "Refusing to replace a real directory at $linkPath; re-run with -Force to back it up and replace it."
    }
  }
  $junction = New-Item -ItemType Junction -Path $linkPath -Target $InstallRoot
  if (-not $junction) { Fail 5 "Failed to create junction $linkPath -> $InstallRoot" }

  Step 'registering bundle dependency in profile package.json'
  $profilePackage = Read-Json $profilePackageFile
  if (-not $profilePackage.PSObject.Properties['dependencies'] -or $null -eq $profilePackage.dependencies) {
    $profilePackage | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $dependencies = $profilePackage.dependencies
  if ($dependencies.PSObject.Properties[$pluginId]) { $dependencies.$pluginId = $linkValue }
  else { $dependencies | Add-Member -NotePropertyName $pluginId -NotePropertyValue $linkValue -Force }
  # dsh.profile was validated before any write; keep the guard for -Force edits.
  if (-not $profilePackage.PSObject.Properties['dsh'] -or $null -eq $profilePackage.dsh) { Fail 6 'Profile package.json has no dsh.profile section.' }
  if (-not $profilePackage.dsh.PSObject.Properties['profile'] -or $null -eq $profilePackage.dsh.profile) { Fail 6 'Profile package.json has no dsh.profile section.' }
  $bundles = @($profilePackage.dsh.profile.bundles)
  if ($bundles -notcontains $pluginId) { $bundles = @($bundles) + $pluginId }
  $profilePackage.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  [System.IO.File]::WriteAllText($profilePackageFile, ($profilePackage | ConvertTo-Json -Depth 100) + "`n", (New-Object System.Text.UTF8Encoding $false))
  Step "profile updated: $profilePackageFile"
}

# ---------------------------------------------------------------- summary
$installedBefore = if ($probe.PSObject.Properties['profile'] -and $probe.profile) { $probe.profile.installedVersion } else { $null }
$dshVersion = if ($probe.PSObject.Properties['dshPackage'] -and $probe.dshPackage) { $probe.dshPackage.version } else { 'unknown' }
$installedAfter = try {
  if (Test-Path -LiteralPath (Join-Path $InstallRoot 'package.json') -PathType Leaf) {
    (Read-Json (Join-Path $InstallRoot 'package.json')).version
  } else { $null }
} catch { 'unknown' }
Write-Host ''
Write-Host 'Install finished.' -ForegroundColor Green
if ($null -eq $installedBefore) { Write-Host "  installed before : not installed" } else { Write-Host "  installed before : $installedBefore" }
if ($null -eq $installedAfter) { Write-Host "  installed after  : not copied (-DryRun)" } else { Write-Host "  installed after  : $installedAfter" }
Write-Host "  DSH version    : $dshVersion ($($probe.decision))"
Write-Host "  install root   : $InstallRoot"
Write-Host "  profile link   : $linkPath"
if (-not $DryRun) { Write-Host "  backup         : $backupDir" }
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart DSH normally (do not force-kill a running Host).'
Write-Host '  2. New session -> Agent preset "AI 画画" -> pick an image-capable model channel.'
Write-Host '  3. Open the AI drawing workbench entry in the right sidebar and create a page.'
Write-Host '  4. Run verify/run-verify.ps1 to collect source/cold-load/sanitize evidence.'
Write-Host 'Rollback: install/rollback.ps1 -DshHome <home> -Profile <profile> [-BackupDir <dir>]'
Restore-NodeMode
exit 0
