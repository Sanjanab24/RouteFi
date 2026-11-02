@echo off
title RouteFi
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist blockchain\node_modules (
  echo Installing blockchain packages - first run only...
  call npm --prefix blockchain install
)
if not exist frontend\node_modules (
  echo Installing dashboard packages - first run only...
  call npm --prefix frontend install
)

node start.js
pause
