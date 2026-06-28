@echo off
cd /d "%~dp0"

set PORT=8100

echo Запускаю локальный сервер в:
echo %cd%
echo.
echo Открываю http://localhost:%PORT%/index.html
echo.
echo Чтобы выключить сервер — закрой это окно.
echo.

start "" "http://localhost:%PORT%/index.html"
python -m http.server %PORT%