@echo off
chcp 65001 >nul 2>nul
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-whale.ps1"
exit /b %ERRORLEVEL%
