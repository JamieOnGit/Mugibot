@echo off
rem Double-click this file to try Mugibot with the dummy stores.
rem It checks Node.js, creates .env the first time, starts Mugibot and opens
rem the dashboard. Leave the window open while you use it.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)"
if errorlevel 1 goto oldnode

if not exist .env (
  copy .env.example .env >nul
  echo Created .env - the admin username is jamie. Change ADMIN_USERNAMES in .env to use another.
)

node scripts\demo.js
pause
exit /b

:nonode
echo Mugibot needs Node.js, and it isn't installed on this computer yet.
echo Opening nodejs.org: download the LTS version, install it,
echo then double-click start-demo-windows.bat again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:oldnode
for /f %%v in ('node -v') do set NODEVER=%%v
echo Mugibot needs Node.js 22.13 or newer, and this computer has %NODEVER%.
echo Opening nodejs.org: download the LTS version, install it,
echo then double-click start-demo-windows.bat again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1
