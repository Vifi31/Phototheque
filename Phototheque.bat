@echo off
REM Photothèque — lanceur Windows.
REM Démarre le serveur local puis ouvre l'application dans le navigateur.
chcp 65001 >nul
setlocal

set "PORT=3212"
if not "%PHOTOTHEQUE_PORT%"=="" set "PORT=%PHOTOTHEQUE_PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js introuvable. Installez-le depuis https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installation des dependances...
  call npm install --no-audit --no-fund
)

start "" "http://localhost:%PORT%"
echo Phototheque demarre sur http://localhost:%PORT%  (Ctrl+C pour arreter)
node server.mjs

endlocal
