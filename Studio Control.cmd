@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
echo Emoji.gg Upload Studio
echo.
echo 1. Start and open dashboard
echo 2. Stop after active batches
echo 3. Restart after active batches
echo 4. Show status
choice /c 1234 /n /m "Choose 1-4: "
if errorlevel 4 node launcher.mjs status
if errorlevel 3 if not errorlevel 4 node launcher.mjs restart
if errorlevel 2 if not errorlevel 3 node launcher.mjs stop
if errorlevel 1 if not errorlevel 2 node launcher.mjs start
echo.
pause
