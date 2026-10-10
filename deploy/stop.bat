@echo off
set "SCRIPT_DIR=%~dp0"
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Users\123\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=C:\Users\123\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE (
  echo [ERROR] node not found. Install Node.js 18+ or check PATH.
  exit /b 1
)
"%NODE_EXE%" "%SCRIPT_DIR%stop-geo.cjs"
