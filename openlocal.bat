@echo off
cd /d "%~dp0"

set PORT=8843

echo [Nocturne] Cleaning port %PORT%...
powershell -Command "Get-NetTCPConnection -LocalPort %PORT% -ErrorAction SilentlyContinue | Foreach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo [Nocturne] Opening browser at http://localhost:%PORT%...
start "" "http://localhost:%PORT%/index.html"

echo [Nocturne] Starting developer server...
node server.mjs

if %ERRORLEVEL% neq 0 (
  echo [ERROR] Server exited with code %ERRORLEVEL%
  pause
)
