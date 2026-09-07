@echo off
REM One-click launcher for TRAX. Double-click this file.
REM Pass --configure to also open the config page:  start.bat --configure

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js was not found on PATH.
    echo   Install it from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\ws" (
    echo Installing dependencies...
    call npm install --omit=dev
    if errorlevel 1 (
        echo.
        echo   npm install failed. See the output above.
        echo.
        pause
        exit /b 1
    )
)

node start.js %*

echo.
echo TRAX has stopped.
pause
