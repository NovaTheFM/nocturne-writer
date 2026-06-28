@echo off
cd /d "%~dp0"

set PORT=8813

echo Очищаю порт %PORT% от предыдущих запусков...
powershell -Command "Get-NetTCPConnection -LocalPort %PORT% -ErrorAction SilentlyContinue | Foreach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo.
echo Запускаю локальный сервер в:
echo %cd%
echo.
echo Открываю http://localhost:%PORT%/index.html
echo.
echo Чтобы выключить сервер — закрой это окно.
echo.

start "" "http://localhost:%PORT%/index.html"
python -m http.server %PORT%