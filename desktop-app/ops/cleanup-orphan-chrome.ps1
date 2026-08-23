param(
  [int]$GraceMinutes = 10,
  [switch]$WhatIfMode
)

$ErrorActionPreference = "Stop"
$profileRoot = "C:\Users\Administrator\AppData\Local\AntidetectBrowser\Profiles"
$dataRoot = "C:\ProgramData\VenusBot"
$logRoot = Join-Path $dataRoot "logs"
$logFile = Join-Path $logRoot "orphan-cleanup.log"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Get-ProfilePath([string]$commandLine) {
  if ($commandLine -match '--user-data-dir="([^"]+)"') {
    return $Matches[1]
  }
  if ($commandLine -match '--user-data-dir=([^\s]+)') {
    return $Matches[1]
  }
  return ""
}

$allProcesses = @(Get-CimInstance Win32_Process)
$chrome = @($allProcesses | Where-Object Name -eq "chrome.exe")

# A profile is active whenever its root browser process still exists. This is
# independent of whether Spectra is running as Spectra.exe (production) or
# electron.exe (development). Only renderer/utility processes left behind
# without a root browser process are eligible for orphan cleanup.
$activeProfiles = @{}
foreach ($process in $chrome) {
  $commandLine = [string]$process.CommandLine
  $profilePath = Get-ProfilePath $commandLine
  if (
    $profilePath.StartsWith($profileRoot, [StringComparison]::OrdinalIgnoreCase) -and
    $commandLine -notmatch '--type='
  ) {
    $activeProfiles[$profilePath] = $true
  }
}

$cutoff = (Get-Date).AddMinutes(-[Math]::Max(1, $GraceMinutes))
$orphans = @()
foreach ($process in $chrome) {
  $commandLine = [string]$process.CommandLine
  $profilePath = Get-ProfilePath $commandLine
  if (
    -not $profilePath.StartsWith($profileRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $activeProfiles.ContainsKey($profilePath) -or
    $commandLine -notmatch '--type='
  ) {
    continue
  }

  $createdAt = if ($process.CreationDate) {
    [datetime]$process.CreationDate
  } else {
    Get-Date
  }
  if ($createdAt -le $cutoff) {
    $runtime = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    $orphans += [pscustomobject]@{
      ProcessId = [int]$process.ProcessId
      ProfilePath = $profilePath
      PrivateMB = if ($runtime) {
        [Math]::Round($runtime.PrivateMemorySize64 / 1MB)
      } else {
        0
      }
    }
  }
}

$freedMB = [Math]::Round(($orphans | Measure-Object PrivateMB -Sum).Sum)
$stopped = 0
$failed = 0
if (-not $WhatIfMode) {
  foreach ($orphan in $orphans) {
    Stop-Process -Id $orphan.ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 15
    if (Get-Process -Id $orphan.ProcessId -ErrorAction SilentlyContinue) {
      $failed += 1
    } else {
      $stopped += 1
    }
  }
}

$activeUsage = @()
foreach ($profilePath in $activeProfiles.Keys) {
  $profileProcesses = @(
    $chrome | Where-Object {
      (Get-ProfilePath ([string]$_.CommandLine)) -eq $profilePath
    }
  )
  $privateMB = 0
  foreach ($process in $profileProcesses) {
    $runtime = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    if ($runtime) {
      $privateMB += $runtime.PrivateMemorySize64 / 1MB
    }
  }
  if ($privateMB -ge 1536) {
    $activeUsage += @{
      profile = Split-Path $profilePath -Leaf
      privateMB = [Math]::Round($privateMB)
    }
  }
}

$entry = [ordered]@{
  timestamp = (Get-Date).ToString("o")
  mode = if ($WhatIfMode) { "audit" } else { "cleanup" }
  activeProfiles = $activeProfiles.Count
  orphanCandidates = $orphans.Count
  stopped = $stopped
  failed = $failed
  estimatedPrivateMBReleased = $freedMB
  highMemoryActiveProfiles = $activeUsage
}
($entry | ConvertTo-Json -Compress -Depth 5) | Add-Content -LiteralPath $logFile
$entry | ConvertTo-Json -Depth 5
