# GameChat one-line installer:
#   irm https://raw.githubusercontent.com/groot99-droid/gamechat/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # progress bar makes Windows PowerShell 5 downloads extremely slow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'groot99-droid/gamechat'
$api  = "https://api.github.com/repos/$repo/releases/latest"
Write-Host 'Looking up the latest GameChat release...'
$rel   = Invoke-RestMethod $api -Headers @{ 'User-Agent' = 'gamechat-installer' }
$asset = $rel.assets | Where-Object { $_.name -like 'GameChat-Setup-*.exe' } | Select-Object -First 1
if (-not $asset) { throw 'No installer found in the latest release.' }
$dest = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size/1MB)) MB)..."
Invoke-WebRequest $asset.browser_download_url -OutFile $dest -UseBasicParsing
Write-Host 'Starting setup (SmartScreen: More info > Run anyway; firewall: Allow).'
Start-Process $dest -Wait
Write-Host 'Done. Open GameChat from the desktop shortcut.'
