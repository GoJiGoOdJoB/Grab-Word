@echo off
setlocal
set PORT=3000
set URL=http://localhost:%PORT%

title Grab-Word Dev Server
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %ERRORLEVEL% EQU 0 (
  echo Dev server already running at %URL%
  start "" %URL%
  exit /b 0
)

echo Starting server at %URL% ...
start "" %URL%
npx serve . -p %PORT% -s
pause