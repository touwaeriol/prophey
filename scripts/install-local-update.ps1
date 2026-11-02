# Install the freshly built Prophey over the running one, without interrupting a live session.
#
# It does not kill anything: it waits for Prophey to exit (the user quitting, or the app's own
# updater), runs the NSIS installer silently into the same directory, then starts it again.
# Previous attempts used `tasklist | find "Prophey.exe"`, which matched Git's find.exe instead
# (Git's bin is first on PATH for this app) and installed while the app was still running.
param(
  [string]$Setup = "$env:LOCALAPPDATA\Temp\Prophey-0.6.26-Setup.exe",
  [string]$Exe = 'D:\app\Agent\Agent Desktop\Prophey\Prophey.exe',
  [int]$TimeoutMinutes = 240
)

$log = Join-Path $env:LOCALAPPDATA 'Temp\prophey-update.log'
function Say([string]$text) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $log -Value $line -Encoding utf8
}

Say "waiting for Prophey.exe to exit (limit $TimeoutMinutes min)"
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
while ((Get-Process -Name Prophey -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
}
if (Get-Process -Name Prophey -ErrorAction SilentlyContinue) {
  Say 'timed out waiting; nothing installed'
  exit 1
}

Start-Sleep -Seconds 2
Say "installing $Setup"
$process = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
Say "installer exit code $($process.ExitCode)"

Start-Sleep -Seconds 6
if (Test-Path $Exe) {
  Start-Process -FilePath $Exe | Out-Null
  Say "started $Exe"
} else {
  Say "MISSING $Exe"
  exit 1
}
