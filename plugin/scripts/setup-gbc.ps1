# Creates a NEW standalone environment only on explicit -Install. Never touches Comfy/global Python.
[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [string]$PythonPath,
    [string]$UvPath,
    [string]$ArchivePath,
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$Commit = '2983c00ba7226643f7f3bf5f15fe8c771383f9ca'
$ArchiveSha256 = '1265653b9c083af6f4052060518d90a7dfb1b08a3e3567f67cd94a5ae6b7e3d6'
$ArchiveUrl = "https://codeload.github.com/KohakuBlueleaf/KohakuGBC/zip/$Commit"
$Lock = Join-Path $PSScriptRoot '../worker/gbc/requirements.lock.txt'
$BuildLock = Join-Path $PSScriptRoot '../worker/gbc/build-requirements.lock.txt'
$stage = 'validate'
$createdRoot = $false
$rootStamp = $null

function Build-Arguments([string]$Source, [string]$Wheels, [string]$Cache = '<owned-cache-dir>') {
    return @('-B','-I','-m','pip','--isolated','--cache-dir',$Cache,'wheel','--no-build-isolation','--no-deps','--no-index','--wheel-dir',$Wheels,$Source)
}

function Write-NewJson([string]$Path, $Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Compress -Depth 6))
    $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}

function Absolute-LocalPath([string]$Value) {
    if (-not $Value -or -not [IO.Path]::IsPathFullyQualified($Value) -or $Value.StartsWith('\\') -or $Value.StartsWith('//')) {
        throw 'An explicit absolute local path is required.'
    }
    $full = [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $node = $full
    while ($node) {
        if (Test-Path -LiteralPath $node) {
            $item = Get-Item -LiteralPath $node -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse paths are not accepted.' }
        }
        $parent = Split-Path -Parent $node
        if ($parent -eq $node) { break }
        $node = $parent
    }
    return $full
}

function Check-Archive([string]$Path) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -ne $ArchiveSha256) {
        throw 'Pinned GBC archive SHA256 mismatch; nothing will be installed.'
    }
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $total = [long]0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            $total += $entry.Length
            if (-not $name.StartsWith("KohakuGBC-$Commit/", [StringComparison]::Ordinal) -or
                $name.Contains('\') -or $name.Contains(':') -or
                @($name.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count -gt 0 -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'Unsafe archive entry; extraction refused.'
            }
        }
        if ($total -gt 1GB -or $zip.Entries.Count -gt 20000) { throw 'Archive exceeds extraction limits.' }
    } finally { $zip.Dispose() }
}

function Run-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Environment setup subprocess failed; existing environments were not changed.' }
}

try {
    if (-not (Test-Path -LiteralPath $Lock -PathType Leaf)) { throw 'The hash-locked core requirements are missing.' }
    if (-not (Test-Path -LiteralPath $BuildLock -PathType Leaf)) { throw 'The hash-locked build backend requirements are missing.' }
    $buildLockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BuildLock).Hash.ToLowerInvariant()
    $root = if ($RuntimeRoot) { Absolute-LocalPath $RuntimeRoot } else { $null }
    if (-not $Install) {
        [ordered]@{
            mode = 'plan'; installRequested = $false; runtimeRoot = $root
            targetAlreadyExists = [bool]($root -and (Test-Path -LiteralPath $root))
            sourceCommit = $Commit; sourceArchiveSha256 = $ArchiveSha256
            requirementsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Lock).Hash.ToLowerInvariant()
            pythonRequired = 'CPython 3.13 x64; explicit -PythonPath'
            build = [ordered]@{environment='separate_new_venv'; requirementsSha256=$buildLockHash;
                               arguments=@(Build-Arguments '<verified-source>' '<owned-wheel-dir>')}
            actions = @('Create a new venv', 'Install binary-only hash-locked core dependencies',
                        'Verify/extract pinned source and build/install pure-Python GBC without runtime dependencies',
                        'Write installation provenance; never download model weights')
            note = 'Plan only. No network, environment creation, installation, or model loading.'
        } | ConvertTo-Json -Depth 4
        exit 0
    }
    if (-not $root) { throw '-Install requires an explicitly approved -RuntimeRoot.' }
    if (Test-Path -LiteralPath $root) { throw 'RuntimeRoot already exists: no upgrade, overwrite, or deletion is allowed.' }
    $python = Absolute-LocalPath $PythonPath
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'The selected Python executable is missing.' }
    Run-Checked $python @('-B','-I', '-c', 'import sys,struct; assert sys.version_info[:2]==(3,13) and struct.calcsize("P")==8, "CPython 3.13 x64 required"')
    $uv = $null
    if ($UvPath) {
        $uv = Absolute-LocalPath $UvPath
        if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) { throw 'The selected uv executable is missing.' }
    } else {
        $found = Get-Command uv -ErrorAction SilentlyContinue
        if ($found -and $found.CommandType -eq 'Application') { $uv = $found.Source }
    }
    # An operator-supplied archive is checked BEFORE creating any new environment or directory.
    if ($ArchivePath) {
        $archive = Absolute-LocalPath $ArchivePath
        Check-Archive $archive
    }
    New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
    $createdRoot = $true
    $rootStamp = (Get-Item -LiteralPath $root).CreationTimeUtc.Ticks
    $stage = 'create_directories'
    $tempDir = Join-Path $root 'temp'
    $sourceDir = Join-Path $root 'source'
    $wheelDir = Join-Path $root 'wheels'
    New-Item -ItemType Directory -Path $tempDir,$sourceDir,$wheelDir | Out-Null
    $saved = @{}
    foreach ($key in @('TEMP','TMP','UV_CACHE_DIR','PIP_CACHE_DIR','HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','HF_HUB_DISABLE_TELEMETRY')) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
    try {
        $env:TEMP = $tempDir; $env:TMP = $tempDir
        $env:UV_CACHE_DIR = Join-Path $root 'uv-cache'
        $pipCache = Join-Path $root 'pip-cache'
        $env:PIP_CACHE_DIR = $pipCache
        $env:HF_HUB_OFFLINE = '1'; $env:TRANSFORMERS_OFFLINE = '1'; $env:HF_HUB_DISABLE_TELEMETRY = '1'
        if (-not $ArchivePath) {
            $stage = 'download_source'
            $archive = Join-Path $root 'source.zip'
            Invoke-WebRequest -Uri $ArchiveUrl -OutFile $archive
            $stage = 'verify_source'
            Check-Archive $archive
        }
        $stage = 'extract_source'
        # Paths and symlink bits were checked above; the destination is new and never force-replaced.
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $sourceDir)
        $source = Join-Path $sourceDir "KohakuGBC-$Commit"
        $venv = Join-Path $root 'venv'
        $buildEnv = Join-Path $root 'build-venv'
        $stage = 'create_runtime_env'
        Run-Checked $python @('-B','-I', '-m', 'venv', $venv)
        $runnerPython = Join-Path $venv 'Scripts/python.exe'
        $stage = 'install_runtime_lock'
        if ($uv) {
            Run-Checked $uv @('--no-config','pip','install','--python',$runnerPython,'--index-url','https://pypi.org/simple','--only-binary',':all:','--require-hashes','-r',$Lock)
        } else {
            Run-Checked $runnerPython @('-B','-I','-m','pip','--isolated','--cache-dir',$pipCache,'install','--index-url','https://pypi.org/simple','--only-binary=:all:','--require-hashes','-r',$Lock)
        }
        $stage = 'create_build_env'
        Run-Checked $python @('-B','-I','-m','venv',$buildEnv)
        $buildPython = Join-Path $buildEnv 'Scripts/python.exe'
        $stage = 'install_build_lock'
        Run-Checked $buildPython @('-B','-I','-m','pip','--isolated','--cache-dir',$pipCache,'install','--index-url','https://pypi.org/simple','--only-binary=:all:','--require-hashes','-r',$BuildLock)
        $buildProvenance = Join-Path $root 'build-provenance.json'
        $buildInfoCode = @'
import json,sys
from pathlib import Path
from importlib.metadata import version
info={'schema_version':1,'requirements_sha256':sys.argv[2],'python':sys.version.split()[0],
      'packages':{n:version(n) for n in ('pip','hatchling','packaging','pathspec','pluggy','trove-classifiers')},
      'build_isolation':False,'dependency_resolution':False,'pip_no_index':True}
with Path(sys.argv[1]).open('x',encoding='utf-8') as f: json.dump(info,f,allow_nan=False,separators=(',',':'))
'@
        Run-Checked $buildPython @('-B','-I','-c',$buildInfoCode,$buildProvenance,$buildLockHash)
        $stage = 'build_gbc'
        # Same command exposed by plan mode; backend exists only in the separate hash-locked build env.
        Run-Checked $buildPython @(Build-Arguments $source $wheelDir $pipCache)
        $wheels = @(Get-ChildItem -LiteralPath $wheelDir -Filter 'kohakugbc-*-py3-none-any.whl' -File)
        if ($wheels.Count -ne 1) { throw 'Expected exactly one pure-Python GBC wheel.' }
        $wheel = $wheels[0].FullName
        $stage = 'install_gbc'
        Run-Checked $runnerPython @('-B','-I','-m','pip','--isolated','--cache-dir',$pipCache,'install','--no-deps','--no-index',$wheel)
        $wheelHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $wheel).Hash.ToLowerInvariant()
        $lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Lock).Hash.ToLowerInvariant()
        $receiptCode = @'
import hashlib,json,sys
from pathlib import Path
from importlib.metadata import distribution,version
d=distribution('kohakugbc')
r={'schema_version':1,'source_commit':sys.argv[1],'source_archive_sha256':sys.argv[2],
   'wheel_sha256':sys.argv[3],'requirements_sha256':sys.argv[4],
   'build':json.loads(Path(sys.argv[5]).read_text(encoding='utf-8')),
   'installed_record_sha256':hashlib.sha256((d.read_text('RECORD') or '').encode('utf-8')).hexdigest(),
   'versions':{n:version(n) for n in ('kohakugbc','togeari','kohakugbc-data','kohakunode','kohakuvault')}}
p=Path(sys.prefix)/'gbc-install-receipt.json'
with p.open('x',encoding='utf-8') as f: json.dump(r,f,ensure_ascii=False,allow_nan=False,separators=(',',':'))
'@
        $stage = 'write_receipt'
        Run-Checked $runnerPython @('-B','-I','-c',$receiptCode,$Commit,$ArchiveSha256,$wheelHash,$lockHash,$buildProvenance)
        [ordered]@{mode='installed'; python=$runnerPython; sourceCommit=$Commit; modelWeightsInstalled=$false;
                   note='Run bridge --doctor using trusted configuration; replay is not live vision readiness.'} | ConvertTo-Json
    } finally {
        foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    }
} catch {
    $failure = $_
    if ($createdRoot) {
        try {
            # Never recurse/delete. Only mark the same new, non-reparse root created by this invocation.
            $verified = Absolute-LocalPath $root
            if ($verified -ne $root -or (Get-Item -LiteralPath $root).CreationTimeUtc.Ticks -ne $rootStamp) {
                throw 'Owned install root identity changed; marker not written.'
            }
            Write-NewJson (Join-Path $root 'setup.failed.json') ([ordered]@{
                schema_version=1; status='failed'; code='setup_failed'; stage=$stage; source_commit=$Commit
                message='Installation is incomplete. Do not reuse this root; inspect it and choose a new approved root.'
            })
            Write-Warning "Installation failed at stage '$stage'; the owned root is retained with setup.failed.json. No existing environment was removed."
        } catch {
            Write-Warning 'Installation failed; partial root retained. Marker could not be written safely. Operator inspection is required.'
        }
    }
    Write-Error -Message $failure.Exception.Message -ErrorAction Continue
    exit 1
}
