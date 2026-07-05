@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PORT=8843

echo [Nocturne] Очищаю порт %PORT% от предыдущих запусков...
powershell -Command "Get-NetTCPConnection -LocalPort %PORT% -ErrorAction SilentlyContinue | Foreach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo [Nocturne] Запуск браузера на http://localhost:%PORT%...
start "" "http://localhost:%PORT%/index.html"

echo [Nocturne] Запуск сервера разработчика...
set PORT=%PORT%
node server.mjs
