@echo off
REM ==========================================================================
REM  Seyo launcher shim.
REM  IMPORTANT: keep this file pure ASCII. cmd.exe parses .bat with the OEM
REM  codepage, so non-ASCII bytes here cause stray command errors. All the
REM  real (Chinese) text lives in start.ps1, which handles UTF-8 fine.
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
