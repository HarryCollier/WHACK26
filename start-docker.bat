@echo off
setlocal
echo ========================================================
echo   Starting WHACK Tutoring Platform (Docker Mode)
echo ========================================================

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

docker compose up -d --build

echo.
echo ========================================================
echo   Docker containers started in background!
echo   Frontend : http://localhost:5173
echo   Backend  : http://localhost:8000
echo   Logs     : docker compose logs -f
echo   To stop  : docker compose down
echo ========================================================
