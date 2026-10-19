@echo off
REM ==========================================================================
REM  Seyo stop shim.
REM  Keep pure ASCII (see the launcher shim for why).
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
