@echo off
cd /d "%~dp0"
title Seyo - Deploy to Raspberry Pi

rem Switch console to UTF-8 so Chinese coming back from the Pi is not garbled
chcp 65001 >nul 2>nul

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] powershell not found.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-pi.ps1"
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo Done.
) else (
  echo Failed with code %RC%. Read the messages above.
)
pause
exit /b %RC%
