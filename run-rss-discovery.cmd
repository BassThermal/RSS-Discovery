@echo off
setlocal

cd /d "%~dp0"

echo [RSS Discovery] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo [RSS Discovery] Node.js is not installed or not on PATH.
  echo Install Node.js LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

echo [RSS Discovery] Installing dependencies...
call npm install
if errorlevel 1 (
  echo [RSS Discovery] npm install failed.
  pause
  exit /b 1
)

echo [RSS Discovery] Starting local server on http://localhost:3000 ...
start "" http://localhost:3000
call npm start

endlocal
