@echo off
setlocal
echo ========================================================
echo   Starting WHACK Tutoring Platform (Local Fast Mode)
echo ========================================================

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

:: Set temp directory for matplotlib to prevent Windows permission warnings
set MPLCONFIGDIR=%TEMP%\mpl
if not exist "%TEMP%\mpl" mkdir "%TEMP%\mpl"

:: 1. Launch Backend (Daphne ASGI Server on port 8000)
echo [1/2] Starting Daphne Backend on http://localhost:8000 ...
start "WHACK Backend (Daphne)" cmd /k "cd /d "%SCRIPT_DIR%backend" && "%SCRIPT_DIR%venv\Scripts\python.exe" -m daphne -b 127.0.0.1 -p 8000 server.asgi:application"

:: 2. Launch Frontend (Vite Dev Server on port 5173 with instant hot-reload)
echo [2/2] Starting Vite Frontend on http://localhost:5173 ...
start "WHACK Frontend (Vite)" cmd /k "cd /d "%SCRIPT_DIR%frontend" && npm run dev"

echo.
echo ========================================================
echo   Both servers launched in separate windows!
echo   Frontend : http://localhost:5173
echo   Backend  : http://localhost:8000
echo   To stop  : Close the terminal windows
echo ========================================================
