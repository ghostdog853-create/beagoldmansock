@echo off
cd /d "%~dp0"
echo.
echo   WAVE FLOOR - http://localhost:8100
echo   demo mode - http://localhost:8100/?demo=1
echo.
start "" http://localhost:8100
node server/server.js
pause
