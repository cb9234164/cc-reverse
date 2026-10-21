@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and reopen this launcher.
  popd
  pause
  exit /b 1
)

if not exist "node_modules\commander\package.json" (
  echo Install dependencies in this repository first:
  echo npm ci --ignore-scripts --no-audit --no-fund
  popd
  pause
  exit /b 1
)

node.exe "%~dp0scripts\recover-orbit-interactive.js"
set "recoveryExitCode=%errorlevel%"
popd
echo.
if not "%recoveryExitCode%"=="0" echo Recovery stopped. Exit code: %recoveryExitCode%
pause
exit /b %recoveryExitCode%
