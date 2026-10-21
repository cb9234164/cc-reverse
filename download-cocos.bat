@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 exit /b 1
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 18 or newer and reopen this launcher.
  popd
  pause
  exit /b 1
)
if not exist "node_modules\commander\package.json" (
  echo Run npm ci --ignore-scripts --no-audit --no-fund in this repository first.
  popd
  pause
  exit /b 1
)
node.exe "%~dp0scripts\download-cocos-interactive.js"
set "downloadExitCode=%errorlevel%"
popd
echo.
if not "%downloadExitCode%"=="0" echo Download incomplete. Check the report. Exit code: %downloadExitCode%
pause
exit /b %downloadExitCode%
