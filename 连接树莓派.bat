@echo off
rem ==========================================================
rem  Seyo - SSH into the Raspberry Pi
rem
rem  Double-click this file. Chinese output from the Pi will
rem  display correctly because we switch the console to UTF-8.
rem
rem  To connect to a different machine, run from cmd:
rem      ?????.bat user@192.168.1.50rem ==========================================================

rem Pi outputs UTF-8; Windows defaults to GBK(936) which garbles it
chcp 65001 >nul 2>nul

title Seyo - SSH to Raspberry Pi

set TARGET=%~1
if "%TARGET%"=="" set TARGET=x@192.168.110.190

echo.
echo   Connecting to %TARGET% ...
echo   (type "exit" to come back)
echo.

ssh %TARGET%

echo.
echo   Disconnected.
pause
