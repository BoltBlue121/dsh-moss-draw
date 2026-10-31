#Requires -Version 5.1
<#
.SYNOPSIS
  Roll back an install made by install/install.ps1.

.DESCRIPTION
  Restores the profile package.json from the newest (or a specified) backup,
  removes the profile junction, and optionally removes the copied install root.
  It never deletes the drawing data root (workbench SQLite / artwork).

.PARAMETER DshHome
  DSH home directory (contains profiles/ and system/backups/).

.PARAMETER Profile
  Profile name. Default: desktop.

.PARAMETER BackupDir
  Explicit backup directory. Default: newest system/backups/portable-moss-draw-*.

.PARAMETER RemoveInstallRoot
  Also move the copied install root into the backup directory instead of leaving it.
  The root is resolved from -InstallRoot, else from the profile dependency's
  link: value, else the default <DshHome>/plugins/dsh-moss-draw.

.PARAMETER InstallRoot
  Explicit install root to remove with -RemoveInstallRoot (useful when install.ps1
  was run with a custom -InstallRoot).

.PARAMETER Force
  Remove a real directory at the profile link path after moving it into the backup.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DshHome,
  [string]$Profile = 'desktop',
  [string]$BackupDir,
  [string]$InstallRoot,
  [switch]$RemoveInstallRoot,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$pluginId = '@dsh-external/dsh-moss-draw'

function Step([string]$Message) { Write-Host "[rollback] $Message" }
function Read-Json([string]$Path) { [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
function Fail([int]$Code, [string]$Message) { Write-Host "[rollback] ERROR: $Message" -ForegroundColor Red; exit $Code }

if (-not (Test-Path -LiteralPath $DshHome -PathType Container)) { Fail 3 "DshHome does not exist: $DshHome" }
$DshHome = (Resolve-Path -LiteralPath $DshHome).Path
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$profilePackageFile = Join-Path $profileDir 'package.json'

if (-not $BackupDir) {
  $backupsRoot = Join-Path $DshHome 'system\backups'
  if (Test-Path -LiteralPath $backupsRoot -PathType Container) {
    $BackupDir = Get-ChildItem -LiteralPath $backupsRoot -Directory -Filter 'portable-moss-draw-*' |
      Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $BackupDir) { Fail 3 'No portable-moss-draw-* backup found; pass -BackupDir explicitly.' }
$BackupDir = (Resolve-Path -LiteralPath $BackupDir).Path
Step "backup: $BackupDir"

$backupPackage = Join-Path $BackupDir 'package.json'
if (-not (Test-Path -LiteralPath $backupPackage -PathType Leaf)) { Fail 3 "Backup does not contain package.json: $backupPackage" }
if (-not (Test-Path -LiteralPath $profilePackageFile -PathType Leaf)) { Fail 3 "Profile package.json missing: $profilePackageFile" }

# Remember where the dependency points before the restore removes it, so the
# (possibly custom) install root can still be cleaned up with -RemoveInstallRoot.
$linkInstallRoot = $null
try {
  $currentProfilePackage = Read-Json $profilePackageFile
  if ($currentProfilePackage.PSObject.Properties['dependencies'] -and $currentProfilePackage.dependencies) {
    $dependency = $currentProfilePackage.dependencies
    if ($dependency.PSObject.Properties[$pluginId]) {
      $linkValue = [string]$dependency.$pluginId
      if ($linkValue.StartsWith('link:', [System.StringComparison]::OrdinalIgnoreCase)) {
        $linkInstallRoot = [System.IO.Path]::GetFullPath($linkValue.Substring(5))
      }
    }
  }
} catch { Write-Host "[rollback] note: could not read the current profile dependency: $($_.Exception.Message)" }

# Safety copy of the current profile before restoring anything.
$safety = Join-Path $BackupDir ('rollback-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $safety | Out-Null
Copy-Item -LiteralPath $profilePackageFile -Destination (Join-Path $safety 'package.json') -Force
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $profilePatch -PathType Leaf) { Copy-Item -LiteralPath $profilePatch -Destination (Join-Path $safety 'cordis.patch.yml') -Force }

Step 'restoring profile package.json'
Copy-Item -LiteralPath $backupPackage -Destination $profilePackageFile -Force
$backupPatch = Join-Path $BackupDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $backupPatch -PathType Leaf) {
  Copy-Item -LiteralPath $backupPatch -Destination $profilePatch -Force
} elseif (Test-Path -LiteralPath $profilePatch -PathType Leaf) {
  # The install did not have a profile patch before; keep the current one but
  # report it so the operator can inspect a leftover override.
  Step 'note: backup had no profile cordis.patch.yml; existing profile patch left unchanged'
}

$linkPath = Join-Path $profileDir 'node_modules\@dsh-external\dsh-moss-draw'
if (Test-Path -LiteralPath $linkPath) {
  $existingLink = Get-Item -LiteralPath $linkPath -Force
  if ($existingLink.LinkType -in @('Junction', 'SymbolicLink')) {
    Step "removing junction: $linkPath"
    $existingLink.Delete()
  } elseif ($Force) {
    Step "moving real directory into backup: $linkPath"
    Move-Item -LiteralPath $linkPath -Destination (Join-Path $safety 'node-modules-existing') -Force
  } else {
    Fail 5 "Refusing to remove a real directory at $linkPath; re-run with -Force to move it into the backup."
  }
} else {
  Step "no junction at $linkPath (already removed?)"
}

# NOTE: never assign to $InstallRoot — parameter names are case-insensitive and
# a local $installRoot would silently shadow the -InstallRoot parameter.
$backedUpInstallRoot = $null
if (Test-Path -LiteralPath (Join-Path $BackupDir 'install-root')) {
  $backedUpInstallRoot = (Get-Item -LiteralPath (Join-Path $BackupDir 'install-root')).FullName
}
$removedInstallRoot = $null
if ($RemoveInstallRoot) {
  # Active root first: explicit -InstallRoot, then the profile dependency link,
  # then the default path. The backup copy is evidence, never a removal target.
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($InstallRoot) { $candidates.Add([System.IO.Path]::GetFullPath($InstallRoot)) }
  if ($linkInstallRoot) { $candidates.Add($linkInstallRoot) }
  $candidates.Add((Join-Path $DshHome 'plugins\dsh-moss-draw'))
  $removable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
  if ($removable) {
    Step "moving install root into backup: $removable"
    Move-Item -LiteralPath $removable -Destination (Join-Path $safety 'install-root') -Force
    $removedInstallRoot = $removable
  } else {
    Step 'note: -RemoveInstallRoot found no active install root (already removed, or pass -InstallRoot <dir>)'
  }
}

Write-Host ''
Write-Host 'Rollback finished.' -ForegroundColor Green
Write-Host "  restored profile: $profilePackageFile"
Write-Host "  safety copy     : $safety"
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart DSH normally; the AI drawing preset should disappear.'
Write-Host '  2. If the official Plugin Manager still lists the plugin, disable/remove it there.'
Write-Host '  3. The drawing data root (workbench SQLite/artwork) was not touched.'
Write-Host '  4. If you kept the install root, you can re-install later with install.ps1.'
exit 0
