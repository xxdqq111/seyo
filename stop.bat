@echo off
REM ==========================================================================
REM  Seyo - stop (English alias)
REM  Keep this file pure ASCII; the real logic is in stop.ps1.
REM ==========================================================================
setlocal
cd /d "%~dp0"
title Seyo - stop

where powershell >nul 2>nul
if errorlevel 1 goto NOPWSH

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
if errorlevel 1 pause
endlocal
exit /b 0

:NOPWSH
echo.
echo  [ERROR] PowerShell not found.
echo.
pause
endlocal
exit /b 1
