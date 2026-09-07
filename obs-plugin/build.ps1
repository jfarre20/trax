# TRAX OBS plugin — build, install, update, uninstall and package.
#
#   .\build.ps1                 build the release DLL
#   .\build.ps1 install         build, then install (or update) into OBS
#   .\build.ps1 uninstall       remove the plugin from OBS
#   .\build.ps1 status          what is built, what is installed
#   .\build.ps1 package         staged tree + distributable zip (+ setup.exe if
#                               Inno Setup is available)
#
# Options: -DebugBuild (debug profile), -Force (close OBS if it is holding the DLL),
#          -Quiet (less output).
#
# Installing writes to %PROGRAMDATA%\obs-studio\plugins\trax, which is where OBS
# on Windows looks for third-party modules. That path needs an elevated shell.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'install', 'update', 'uninstall', 'status', 'package')]
    [string]$Action = 'build',

    [switch]$DebugBuild,
    [switch]$Force,
    [switch]$Elevate,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------- constants

$PluginName = 'trax'
$Root       = Split-Path $PSScriptRoot -Parent          # repo root
$BuildProfile = if ($DebugBuild) { 'debug' } else { 'release' }
$TargetDir  = Join-Path $PSScriptRoot "target\$BuildProfile"
$DistDir    = Join-Path $PSScriptRoot 'dist'
$StageDir   = Join-Path $DistDir 'stage'
$InstallDir = Join-Path $env:ProgramData "obs-studio\plugins\$PluginName"

# The overlay is authored in the repo root and shipped as the plugin's data.
$DataFiles = @('overlay.html', 'overlay.css', 'overlay.js')

function Say([string]$m) { if (-not $Quiet) { Write-Host $m } }
function Warn([string]$m) { Write-Warning $m }

# ------------------------------------------------------------------- helpers

function Get-PluginVersion {
    # The [package] version, not a dependency's.
    $inPackage = $false
    foreach ($line in Get-Content (Join-Path $PSScriptRoot 'Cargo.toml')) {
        $t = $line.Trim()
        if ($t -match '^\[package\]') { $inPackage = $true; continue }
        if ($t -match '^\[') { $inPackage = $false; continue }
        if ($inPackage -and $t -match '^version\s*=\s*"([^"]+)"') { return $Matches[1] }
    }
    throw "could not read version from Cargo.toml"
}

function Get-ObsProcess { Get-Process obs64 -ErrorAction SilentlyContinue }

function Assert-ObsClosed([string]$why) {
    $obs = Get-ObsProcess
    if (-not $obs) { return }

    if (-not $Force) {
        throw "OBS is running, so $why would fail (Windows locks a loaded DLL). Close OBS, or re-run with -Force."
    }

    Say "  closing OBS (-Force)..."
    $obs | ForEach-Object { $_.CloseMainWindow() | Out-Null }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-ObsProcess)) { return }
    }
    throw "OBS did not exit. Close it by hand and try again."
}

function Test-Elevated {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object System.Security.Principal.WindowsPrincipal $id).IsInRole(
        [System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Throw-NeedsElevation([string]$what) {
    # Files that setup.exe wrote grant plain users read-only, so replacing them
    # needs elevation even though creating the folder in the first place did not.
    throw @"
$what needs an elevated shell.

  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$PSCommandPath','$Action'

or re-run with -Elevate to do that for you.
"@
}

function Assert-Writable([string]$dir) {
    # Probe the real target when it already exists: being able to create a file
    # in the parent says nothing about being able to replace files inside a
    # folder that an elevated installer owns.
    $probeDir = if (Test-Path $InstallDir) { $InstallDir } else { $dir }
    $probe = Join-Path $probeDir '.trax-write-probe'
    try {
        New-Item -ItemType Directory -Force $probeDir | Out-Null
        Set-Content -Path $probe -Value 'x' -Encoding ascii
        Remove-Item $probe -Force
    } catch {
        Throw-NeedsElevation "Writing to $probeDir"
    }
}

function Invoke-Cargo([string[]]$cargoArgs) {
    # Cargo writes progress to stderr. Windows PowerShell turns a native
    # command's stderr into an error record, which under 'Stop' aborts the
    # script even on success — so judge it by the exit code instead.
    Push-Location $PSScriptRoot
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & cargo @cargoArgs
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($code -ne 0) { throw "cargo $($cargoArgs -join ' ') failed (exit $code)" }
    } finally {
        Pop-Location
    }
}

function Get-InstalledVersion {
    $dll = Join-Path $InstallDir 'bin\64bit\trax.dll'
    if (-not (Test-Path $dll)) { return $null }
    # Rust does not embed a VERSIONINFO resource, so the staged tree carries a
    # version.txt instead. Every install path (this script, the zip and the
    # setup.exe) ships it, so they all report the same thing.
    $stamp = Join-Path $InstallDir 'version.txt'
    if (Test-Path $stamp) { return (Get-Content $stamp -Raw).Trim() }
    return 'unknown'
}

# --------------------------------------------------------------------- steps

function Step-Build {
    $cargoArgs = @('build')
    if (-not $DebugBuild) { $cargoArgs += '--release' }
    Say "building ($BuildProfile)..."
    Invoke-Cargo $cargoArgs

    $dll = Join-Path $TargetDir 'trax.dll'
    if (-not (Test-Path $dll)) { throw "build reported success but $dll is missing" }
    Say "  $dll"
    return $dll
}

function Step-Stage {
    # The exact tree OBS expects, so the zip can be extracted straight into
    # %PROGRAMDATA%\obs-studio\plugins\.
    $dll = Step-Build
    $treeRoot = Join-Path $StageDir $PluginName
    if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
    $bin = Join-Path $treeRoot 'bin\64bit'
    $data = Join-Path $treeRoot 'data'
    New-Item -ItemType Directory -Force $bin | Out-Null
    New-Item -ItemType Directory -Force $data | Out-Null

    Copy-Item $dll (Join-Path $bin 'trax.dll') -Force
    $pdb = Join-Path $TargetDir 'trax.pdb'
    if (Test-Path $pdb) { Copy-Item $pdb (Join-Path $bin 'trax.pdb') -Force }
    foreach ($f in $DataFiles) {
        $src = Join-Path $Root $f
        if (-not (Test-Path $src)) { throw "missing overlay file: $src" }
        Copy-Item $src (Join-Path $data $f) -Force
    }
    Set-Content -Path (Join-Path $treeRoot 'version.txt') -Value (Get-PluginVersion) -Encoding ascii
    return $treeRoot
}

function Step-Install {
    $version = Get-PluginVersion
    $previous = Get-InstalledVersion
    $tree = Step-Stage

    Assert-ObsClosed "installing"
    Assert-Writable (Split-Path $InstallDir -Parent)

    # Replace what we ship, but leave anything setup.exe put there alone. Wiping
    # the whole folder would take its uninstall\ record with it and strand the
    # entry in Add/Remove Programs.
    try {
        foreach ($sub in 'bin', 'data') {
            $p = Join-Path $InstallDir $sub
            if (Test-Path $p) { Remove-Item $p -Recurse -Force }
        }
        New-Item -ItemType Directory -Force $InstallDir | Out-Null
        Copy-Item (Join-Path $tree '*') $InstallDir -Recurse -Force
    } catch [System.UnauthorizedAccessException] {
        Throw-NeedsElevation 'Installing'
    } catch {
        if ($_.Exception.Message -match 'denied') { Throw-NeedsElevation 'Installing' }
        throw
    }

    if (Test-Path (Join-Path $InstallDir 'uninstall')) {
        Say "  (over an installer-managed copy; Add/Remove Programs still points here)"
    }

    if ($previous) {
        Say "updated $PluginName $previous -> $version"
    } else {
        Say "installed $PluginName $version"
    }
    Say "  $InstallDir"
    Say ""
    Say "Start OBS and add a 'TRAX Now Playing' source."
}

function Step-Uninstall {
    if (-not (Test-Path $InstallDir)) {
        Say "not installed (nothing at $InstallDir)"
        return
    }
    Assert-ObsClosed "uninstalling"

    $version = Get-InstalledVersion

    # An installer-managed copy has its own uninstaller; use it so the entry in
    # Add/Remove Programs goes away too.
    $unins = Join-Path $InstallDir 'uninstall\unins000.exe'
    if (Test-Path $unins) {
        Say "running the installer's own uninstaller..."
        $p = Start-Process -FilePath $unins -ArgumentList '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
        if ($p.ExitCode -ne 0) { throw "the uninstaller exited with $($p.ExitCode)" }
        Say "removed $PluginName $version (and its Add/Remove Programs entry)"
        return
    }

    try {
        Remove-Item $InstallDir -Recurse -Force
    } catch {
        if ($_.Exception.Message -match 'denied') { Throw-NeedsElevation 'Uninstalling' }
        throw
    }

    # Leave the plugins folder itself only if we were the last one in it.
    $parent = Split-Path $InstallDir -Parent
    if ((Test-Path $parent) -and -not (Get-ChildItem $parent)) { Remove-Item $parent -Force }

    Say "removed $PluginName $version from $InstallDir"
    Say ""
    Say "Any TRAX source still in a scene will show as missing until you delete it."
}

function Step-Status {
    $built = Join-Path $TargetDir 'trax.dll'
    $rows = [ordered]@{
        'source version'  = Get-PluginVersion
        'built' = if (Test-Path $built) { "yes  $((Get-Item $built).LastWriteTime)" } else { 'no' }
        'installed'       = if (Get-InstalledVersion) { Get-InstalledVersion } else { 'no' }
        'install path'    = $InstallDir
        'OBS running'     = if (Get-ObsProcess) { 'yes' } else { 'no' }
    }
    foreach ($k in $rows.Keys) { "{0,-18} {1}" -f $k, $rows[$k] }
}

function Step-Package {
    $version = Get-PluginVersion
    $tree = Step-Stage

    $notes = @"
TRAX Now Playing — OBS plugin $version

Install by hand:
  Copy the "$PluginName" folder into
    %PROGRAMDATA%\obs-studio\plugins\
  so that you end up with
    %PROGRAMDATA%\obs-studio\plugins\$PluginName\bin\64bit\trax.dll
    %PROGRAMDATA%\obs-studio\plugins\$PluginName\data\overlay.html

  Close OBS first. Then start OBS and add a "TRAX Now Playing" source.

Uninstall by hand:
  Delete %PROGRAMDATA%\obs-studio\plugins\$PluginName

Requires Windows 10/11 and OBS Studio 30.x.
"@
    Set-Content -Path (Join-Path $StageDir 'INSTALL.txt') -Value $notes -Encoding utf8

    $zip = Join-Path $DistDir "$PluginName-$version-windows-x64.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $zip
    Say "packaged $zip ($([int]((Get-Item $zip).Length / 1KB)) KB)"

    # An .exe installer, only if Inno Setup happens to be available.
    # winget installs Inno per-user, the .exe installer puts it in Program Files.
    $iscc = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:ISCC"
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

    if ($iscc) {
        Say "building setup.exe with Inno Setup..."
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $iscc "/DAppVersion=$version" "/DStageDir=$StageDir" "/DOutDir=$DistDir" (Join-Path $PSScriptRoot 'installer\trax.iss')
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($code -ne 0) { throw "ISCC failed (exit $code)" }
        Say "packaged $DistDir\$PluginName-$version-setup.exe"
    } else {
        Say "Inno Setup not found, so only the zip was built."
        Say "  For an .exe installer: winget install JRSoftware.InnoSetup, then re-run."
    }
}

# ---------------------------------------------------------------------- main

# Re-launch elevated on request, before anything touches the filesystem.
if ($Elevate -and -not (Test-Elevated)) {
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, $Action)
    if ($DebugBuild) { $psArgs += '-DebugBuild' }
    if ($Force) { $psArgs += '-Force' }
    Say "re-launching elevated..."
    $p = Start-Process powershell -Verb RunAs -ArgumentList $psArgs -Wait -PassThru
    exit $p.ExitCode
}

switch ($Action) {
    'build'     { Step-Build | Out-Null }
    'install'   { Step-Install }
    'update'    { Step-Install }     # same thing; it replaces what is there
    'uninstall' { Step-Uninstall }
    'status'    { Step-Status }
    'package'   { Step-Package }
}
