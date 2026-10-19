@echo off
REM ==========================================================================
REM  Seyo - start (English alias of the launcher)
REM  Same thing as the Chinese-named launcher in this folder.
REM  Keep this file pure ASCII; the real logic is in start.ps1.
REM ==========================================================================
setlocal
cd /d "%~dp0"
title Seyo

where powershell >nul 2>nul
if errorlevel 1 goto NOPWSH

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
endlocal
exit /b 0

:NOPWSH
echo.
echo  [ERROR] PowerShell not found. Windows 10/11 should have it.
echo.
pause
endlocal
exit /b 1
