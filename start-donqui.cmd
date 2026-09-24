@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run npm ci first.
  pause
  exit /b 1
)
if not exist "dist-electron\main.js" (
  call npm run build-vite
  if errorlevel 1 (pause & exit /b 1)
)
start "Donqui Studio" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
