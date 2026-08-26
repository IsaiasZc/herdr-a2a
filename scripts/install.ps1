<#
  Windows installer for herdr-a2a.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1 status
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1 uninstall

  It only modifies the current user's profile and never needs elevation. Agent
  skills are directory junctions (rather than symbolic links), which also work
  when Windows Developer Mode is disabled.
#>
[CmdletBinding()]
param(
  [ValidateSet("install", "status", "uninstall")]
  [string]$Command = "install"
)

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$HomeDir = [Environment]::GetFolderPath("UserProfile")
$Herdr = if ($env:HERDR_BIN_PATH) { $env:HERDR_BIN_PATH } else { "herdr" }
$Npm = "npm.cmd"
$Node = "node.exe"
$PluginId = "herdr-a2a"
$SkillName = "herdr-a2a"
$SkillSource = Join-Path $Repo "src\bridge\skill"
$CliEntry = Join-Path $Repo "dist\bridge\cli.js"
$MainEntry = Join-Path $Repo "dist\main.js"
$BinDir = Join-Path $env:LOCALAPPDATA "herdr-a2a\bin"
$CliPath = Join-Path $BinDir "herdr-a2a.cmd"
$SkillDirs = @(
  @{ Agent = "Claude Code"; Dir = (Join-Path $HomeDir ".claude\skills") },
  @{ Agent = "Codex"; Dir = (Join-Path $HomeDir ".codex\skills") },
  @{ Agent = "OpenCode"; Dir = (Join-Path $HomeDir ".config\opencode\skills") }
)

function Write-Ok([string]$Message) { Write-Host "  ✓ $Message" }
function Write-Skip([string]$Message) { Write-Host "  · $Message" }
function Write-Warn([string]$Message) { Write-Warning $Message }
function Write-Step([string]$Message) { Write-Host "`n$Message" }

function Get-ShortError($ErrorRecord) {
  return (($ErrorRecord | Out-String).Trim() -split "`r?`n")[0]
}

function Test-OurJunction([string]$Link, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Link)) { return $false }
  try {
    $item = Get-Item -LiteralPath $Link -Force
    if ($item.LinkType -ne "Junction" -or $null -eq $item.Target) { return $false }
    $actual = [IO.Path]::GetFullPath([string]($item.Target | Select-Object -First 1))
    return $actual -eq [IO.Path]::GetFullPath($Target)
  } catch {
    return $false
  }
}

function Install-Junction([string]$Link, [string]$Target, [string]$Label) {
  if (Test-OurJunction $Link $Target) {
    Write-Skip "$Label already linked"
    return
  }
  if (Test-Path -LiteralPath $Link) {
    $item = Get-Item -LiteralPath $Link -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      Write-Warn "${Label}: $Link exists and is not a link — left untouched"
      return
    }
    Remove-Item -LiteralPath $Link -Force
  }
  New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
  Write-Ok "$Label → $Link"
}

function Remove-Junction([string]$Link, [string]$Target, [string]$Label) {
  if (-not (Test-OurJunction $Link $Target)) {
    Write-Skip "$Label not linked by us"
    return
  }
  Remove-Item -LiteralPath $Link -Force
  Write-Ok "$Label removed"
}

function Get-CliContents {
  return "@echo off`r`n$Node `"$CliEntry`" %*`r`n"
}

function Test-OurCli {
  if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) { return $false }
  return (Get-Content -LiteralPath $CliPath -Raw) -eq (Get-CliContents)
}

function Ensure-Path {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $userPath) { $userPath = "" }
  $parts = $userPath -split ";" | Where-Object { $_ }
  if ($parts -notcontains $BinDir) {
    $newPath = (@($parts) + $BinDir) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Ok "added $BinDir to your user PATH (open a new terminal to use it)"
  }
  if (($env:Path -split ";") -notcontains $BinDir) { $env:Path += ";$BinDir" }
}

function Invoke-Herdr([string[]]$Arguments) {
  & $Herdr @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "herdr $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Test-PluginLinked {
  try {
    $json = (Invoke-Herdr @("plugin", "list", "--json") | Out-String) | ConvertFrom-Json
    return $null -ne @($json.result.plugins | Where-Object { $_.plugin_id -eq $PluginId })[0]
  } catch {
    return $false
  }
}

function Get-Gateway {
  try {
    $json = (& $Node $CliEntry "discover" "--json" | Out-String) | ConvertFrom-Json
    return @{ Up = $true; BaseUrl = $json.baseUrl; Agents = @($json.agents).Count }
  } catch {
    return @{ Up = $false }
  }
}

function Build {
  Write-Step "Building"
  if (-not (Test-Path -LiteralPath (Join-Path $Repo "node_modules"))) {
    & $Npm "install" "--silent"
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    Write-Ok "dependencies installed"
  } else {
    Write-Skip "dependencies already installed"
  }
  & $Npm "run" "build"
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  Write-Ok "compiled to dist/"
}

function Install-Plugin {
  Write-Step "Herdr plugin (so Herdr owns the gateway)"
  if (Test-PluginLinked) { Invoke-Herdr @("plugin", "unlink", $PluginId) | Out-Null }
  try {
    Invoke-Herdr @("plugin", "link", $Repo) | Out-Null
    Write-Ok "linked $PluginId from $Repo"
  } catch {
    Write-Warn "could not link the plugin: $(Get-ShortError $_)"
  }
}

function Install-Cli {
  Write-Step "CLI"
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  if ((Test-Path -LiteralPath $CliPath -PathType Leaf) -and -not (Test-OurCli)) {
    Write-Warn "$CliPath exists and was not created by this installer — left untouched"
    return
  }
  Set-Content -LiteralPath $CliPath -Value (Get-CliContents) -Encoding ascii -NoNewline
  Ensure-Path
  Write-Ok "herdr-a2a → $CliPath"
}

function Install-Skill {
  Write-Step "Caller skill (junctioned, so editing the repo updates every agent)"
  $installed = 0
  foreach ($skillDir in $SkillDirs) {
    if (-not (Test-Path -LiteralPath $skillDir.Dir -PathType Container)) {
      Write-Skip "$($skillDir.Agent): $($skillDir.Dir) does not exist — skipped"
      continue
    }
    Install-Junction (Join-Path $skillDir.Dir $SkillName) $SkillSource "$($skillDir.Agent) skill"
    $installed += 1
  }
  if ($installed -eq 0) { Write-Warn "no agent skills directory found; the CLI still works on its own" }
}

function Start-GatewayNow {
  Write-Step "Gateway for the current session"
  $before = Get-Gateway
  if ($before.Up) {
    Write-Skip "already serving at $($before.BaseUrl) ($($before.Agents) agents)"
    return
  }
  if (-not $env:HERDR_SOCKET_PATH) {
    Write-Warn "not running inside a Herdr session — start the gateway from a Herdr pane"
    return
  }
  Start-Process -FilePath $Node -ArgumentList @($MainEntry, "serve") -WorkingDirectory $Repo -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i += 1) {
    Start-Sleep -Milliseconds 500
    $now = Get-Gateway
    if ($now.Up) {
      Write-Ok "serving at $($now.BaseUrl) ($($now.Agents) delegatable agents)"
      return
    }
  }
  Write-Warn "the gateway did not come up in 15s — run node dist/main.js doctor to see why"
}

function Install {
  Write-Host "Installing herdr-a2a from $Repo"
  Build
  Install-Plugin
  Install-Cli
  Install-Skill
  Start-GatewayNow
}

function Status {
  Write-Host "herdr-a2a at $Repo`n"
  Write-Host "plugin:   $(if (Test-PluginLinked) { "linked" } else { "NOT linked" })"
  Write-Host "cli:      $(if (Test-OurCli) { $CliPath } else { "NOT linked" })"
  foreach ($skillDir in $SkillDirs) {
    $link = Join-Path $skillDir.Dir $SkillName
    $state = if (-not (Test-Path -LiteralPath $skillDir.Dir)) { "agent not installed" } elseif (Test-OurJunction $link $SkillSource) { "linked" } else { "NOT linked" }
    Write-Host "skill:    $($skillDir.Agent.PadRight(12)) $state"
  }
  $gateway = Get-Gateway
  Write-Host "gateway:  $(if ($gateway.Up) { "$($gateway.BaseUrl) ($($gateway.Agents) agents)" } else { "not reachable" })"
  Write-Host "built:    $(if (Test-Path -LiteralPath $CliEntry) { "yes" } else { "no — run npm run build" })"
}

function Uninstall {
  Write-Host "Removing herdr-a2a links (the repo itself is left alone)"
  Write-Step "Herdr plugin"
  if (Test-PluginLinked) {
    try {
      Invoke-Herdr @("plugin", "unlink", $PluginId) | Out-Null
      Write-Ok "unlinked"
    } catch {
      Write-Warn "could not unlink the plugin: $(Get-ShortError $_)"
    }
  } else { Write-Skip "not linked" }
  Write-Step "CLI"
  if (Test-OurCli) {
    Remove-Item -LiteralPath $CliPath -Force
    Write-Ok "herdr-a2a removed"
  } else { Write-Skip "herdr-a2a not installed by us" }
  Write-Step "Skill"
  foreach ($skillDir in $SkillDirs) {
    Remove-Junction (Join-Path $skillDir.Dir $SkillName) $SkillSource "$($skillDir.Agent) skill"
  }
}

try {
  switch ($Command) {
    "install" { Install }
    "status" { Status }
    "uninstall" { Uninstall }
  }
  exit 0
} catch {
  Write-Error "failed: $(Get-ShortError $_)"
  exit 1
}
