@echo off
rem Double-click this file to start MVR Presets.
rem Keep this window open while you use the app. Close it (or press Ctrl+C) to stop.

cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
node --env-file=.env server.js
pause
