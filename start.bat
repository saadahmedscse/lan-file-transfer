@echo off
setlocal
title Ferry - file sharing (close this window to stop)
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Download it from https://nodejs.org and run start.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\ws\package.json" (
  echo.
  echo   First run: installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Could not install dependencies. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem Ferry runs inside this window. Closing the window stops the server and clears the session.
rem Files or folders dropped onto start.bat are shared from disk as soon as it starts.
node server\index.js %*

echo.
echo   Ferry has stopped. Press any key to close this window.
pause >nul
