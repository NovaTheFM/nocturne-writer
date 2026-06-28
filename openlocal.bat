@echo off
cd /d "%~dp0"

set PORT=8886

echo Очищаю порт %PORT% от предыдущих запусков...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%PORT% ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
)

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