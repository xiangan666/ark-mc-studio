@echo off
setlocal
chcp 65001 >nul
set "ARKMC_ROOT=%~dp0"
powershell.exe -NoProfile -Command "$ErrorActionPreference = 'Stop'; $root = $env:ARKMC_ROOT; $version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version; $target = Join-Path $root ('release\ArkMC-Studio-' + $version + '-Windows-x64.exe'); if (Test-Path -LiteralPath $target) { Start-Process -FilePath $target } else { Write-Host '尚未生成当前版本便携程序。请在此目录执行 npm run package。'; exit 1 }"
if errorlevel 1 pause
