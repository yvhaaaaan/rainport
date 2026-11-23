@echo off
setlocal
cd /d "%~dp0"
if exist runtime\node.exe (
  set UWS_USE_FALLBACK=1
  runtime\node.exe play.mjs
) else (
  where node >nul 2>nul || (echo Please install Node.js 22 or newer. & pause & exit /b 1)
  if not exist node_modules\ethers\package.json (call npm install --no-audit --no-fund || (pause & exit /b 1))
  node play.mjs
)
if errorlevel 1 pause
