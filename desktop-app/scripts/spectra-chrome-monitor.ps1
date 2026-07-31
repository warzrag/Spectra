$log = 'C:\Users\Administrator\Downloads\spectra-chrome-monitor.log'
$encoding = [Text.Encoding]::UTF8

function Write-MonitorLine([string]$line) {
  [IO.File]::AppendAllText(
    $log,
    $line + [Environment]::NewLine,
    $encoding
  )
}

[IO.File]::WriteAllText(
  $log,
  ('MONITOR_START ' + (Get-Date).ToString('o') + [Environment]::NewLine),
  $encoding
)

$tracked = @{}
$deadline = (Get-Date).AddMinutes(3)

try {
  while ((Get-Date) -lt $deadline) {
    $current = @(
      Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" `
        -ErrorAction SilentlyContinue
    )

    foreach ($item in $current) {
      $processId = [int]$item.ProcessId
      if ($tracked.ContainsKey($processId)) {
        continue
      }

      try {
        $process = [Diagnostics.Process]::GetProcessById($processId)
        $tracked[$processId] = $process
        Write-MonitorLine (
          'START|' + (Get-Date).ToString('o') +
          '|PID=' + $processId +
          '|PPID=' + $item.ParentProcessId +
          '|CMD=' + [string]$item.CommandLine
        )
      } catch {
        Write-MonitorLine (
          'START_ERROR|' + (Get-Date).ToString('o') +
          '|PID=' + $processId +
          '|ERROR=' + $_.Exception.Message
        )
      }
    }

    foreach ($processId in @($tracked.Keys)) {
      $process = $tracked[$processId]
      try {
        $process.Refresh()
        if (!$process.HasExited) {
          continue
        }
        Write-MonitorLine (
          'STOP|' + (Get-Date).ToString('o') +
          '|PID=' + $processId +
          '|EXIT=' + $process.ExitCode
        )
        $process.Dispose()
        $tracked.Remove($processId)
      } catch {
        Write-MonitorLine (
          'STOP_ERROR|' + (Get-Date).ToString('o') +
          '|PID=' + $processId +
          '|ERROR=' + $_.Exception.Message
        )
        $tracked.Remove($processId)
      }
    }

    Start-Sleep -Milliseconds 100
  }
} catch {
  Write-MonitorLine (
    'MONITOR_ERROR|' + (Get-Date).ToString('o') +
    '|ERROR=' + $_.Exception.ToString()
  )
} finally {
  Write-MonitorLine ('MONITOR_END ' + (Get-Date).ToString('o'))
}
