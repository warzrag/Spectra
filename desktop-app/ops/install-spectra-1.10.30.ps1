$ErrorActionPreference = 'Stop'

$spectraChromeProcesses = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq 'chrome.exe' -and
      $_.CommandLine -match 'Spectra|spectra-profiles'
    }
)

if ($spectraChromeProcesses.Count -gt 0) {
  throw "Installation refused: $($spectraChromeProcesses.Count) Spectra Chrome process(es) active"
}

Get-Process -Name Spectra -ErrorAction SilentlyContinue | Stop-Process -Force
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Process -Name Spectra -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
}

$installer = 'C:\SpectraDeploy\1.10.30\Spectra-Setup-1.10.30.exe'
$expectedHash = 'D64626CD86BC323342DC9C63D6D343264E9D1F2DB5ACA4CFA8EACAF0B0CC09D7'
$actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
  throw 'Installer checksum mismatch'
}

$process = Start-Process `
  -FilePath $installer `
  -ArgumentList '/S', '/allusers' `
  -WindowStyle Hidden `
  -Wait `
  -PassThru

if ($process.ExitCode -ne 0) {
  throw "Installer exit code $($process.ExitCode)"
}

$executable = 'C:\Program Files\Spectra\Spectra.exe'
$version = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
[pscustomobject]@{
  ExitCode = $process.ExitCode
  Version = $version
  Path = $executable
} | ConvertTo-Json -Compress
