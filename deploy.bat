@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM WaSend one-command deploy: auth, D1, migrations, secrets, deploy.
REM Usage: deploy.bat [--dry-run] [--skip-secrets]   (arguments pass through to scripts/deploy.mjs)

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is required but was not found on PATH. Install Node 20+ from https://nodejs.org
  exit /b 1
)

node "%~dp0scripts\deploy.mjs" %*
exit /b %errorlevel%
