@echo off
REM Lanceur de la version installee de Phototheque (Node.js livre dans ..\node).
chcp 65001 >nul
title Phototheque
set "PROG=%~dp0.."
"%PROG%\node\node.exe" "%PROG%\scripts\lancer.mjs" %*
if errorlevel 1 pause
