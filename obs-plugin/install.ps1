# Kept for convenience: everything now lives in build.ps1.
#
#   .\build.ps1 install
param([switch]$DebugBuild, [switch]$Force, [switch]$Elevate)
& (Join-Path $PSScriptRoot 'build.ps1') install -DebugBuild:$DebugBuild -Force:$Force -Elevate:$Elevate
