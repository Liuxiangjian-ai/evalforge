<#
.SYNOPSIS
  Install EvalForge into a DeepSeek Harness profile.

.DESCRIPTION
  Links this package into the target profile, adds it to
  `dsh.profile.bundles`, and runs the profile's package install.
  Restart the Harness afterwards (or let HMR reload a web profile).

.PARAMETER Profile
  Profile name under $DSH_HOME/profiles. Defaults to $env:DSH_PROFILE.

.PARAMETER SkipInstall
  Write the manifest changes only; skip pnpm.

.EXAMPLE
  pwsh -File .\scripts\install.ps1 -Profile desktop
#>
[CmdletBinding()]
param(
  [string]$Profile = $env:DSH_PROFILE,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

if (-not $Profile) {
  throw "No profile given. Pass -Profile <name> or set `$env:DSH_PROFILE."
}

$profileDir = Join-Path $dshHome "profiles\$Profile"
if (-not (Test-Path $profileDir)) {
  throw "Profile '$Profile' does not exist at $profileDir"
}

$packageFile = Join-Path $profileDir 'package.json'
$manifest = Get-Content -Raw $packageFile | ConvertFrom-Json

if (-not $manifest.PSObject.Properties['dependencies']) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$linkSpec = 'link:' + ($pluginDir -replace '\\', '/')
$manifest.dependencies | Add-Member -NotePropertyName 'dsh-plugin-evalforge' -NotePropertyValue $linkSpec -Force

if (-not $manifest.PSObject.Properties['dsh']) {
  throw "Profile manifest has no 'dsh' section; this does not look like a Harness profile."
}
$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-plugin-evalforge') {
  $bundles += 'dsh-plugin-evalforge'
}
$manifest.dsh.profile.bundles = $bundles

$backup = "$packageFile.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $packageFile $backup
$manifest | ConvertTo-Json -Depth 12 | Set-Content -Path $packageFile -Encoding utf8
Write-Host "Updated $packageFile (backup: $backup)"
Write-Host "Linked: $linkSpec"

if ($SkipInstall) {
  Write-Host 'Skipped package install (-SkipInstall).'
  exit 0
}

Push-Location $profileDir
try {
  if (Get-Command dsh -ErrorAction SilentlyContinue) {
    dsh plugin --profile $Profile install
  } else {
    pnpm install
  }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Installed. Restart the Harness (or reload the web page for an HMR profile) and open EvalForge in the sidebar.'
