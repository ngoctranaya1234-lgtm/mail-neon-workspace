@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Mail Neon Workspace

echo ================================================================
echo   MAIL NEON WORKSPACE - KHOI DONG GIAO DIEN APP CHROME (HTTPS)
echo ================================================================

set "NODE_EXE="
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  echo [LOI] Khong tim thay Node.js 24+. Hay cai dat Node.js tai https://nodejs.org
  pause
  exit /b 1
)
"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)"
if errorlevel 1 (
  echo [LOI] Du an can Node.js 24 tro len. Hay cap nhat tai https://nodejs.org
  pause
  exit /b 1
)

set "NEED_INSTALL=0"
if not exist "node_modules\imapflow" set "NEED_INSTALL=1"
if not exist "node_modules\smtp-server" set "NEED_INSTALL=1"
if "!NEED_INSTALL!"=="1" (
  echo [1/4] Dang kiem tra thu vien dependency can thiet...
  where pnpm >nul 2>nul
  if not errorlevel 1 (
    call pnpm install --frozen-lockfile
  ) else (
    if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.mjs" (
      "%NODE_EXE%" "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\pnpm\bin\pnpm.mjs" install --frozen-lockfile
    ) else (
      where npm >nul 2>nul
      if errorlevel 1 (
        echo [LOI] Chua co npm hoac pnpm. Hay cai dat Node.js 24 tai https://nodejs.org
        pause
        exit /b 1
      )
      call npm install --no-audit --no-fund
    )
  )
  if errorlevel 1 (
    echo [LOI] Cai dat thu vien that bai.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo [2/4] Khoi tao file cau hinh bao mat .env...
  "%NODE_EXE%" "scripts\setup.mjs"
  if errorlevel 1 exit /b 1
)

if not exist "cert.pfx" (
  echo [3/4] Khoi tao chung chi HTTPS bao mat...
  "%NODE_EXE%" "scripts\setup-tls.mjs"
  if errorlevel 1 exit /b 1
)

echo [4/4] Dang mo ung dung tren Google Chrome...

echo.
echo ================================================================
echo   MAY CHU HTTPS SAN SANG TAI: https://127.0.0.1:3000
echo   SETUP_TOKEN nam trong tep .env; giu kin tep nay.
echo ================================================================
echo.
echo Dang khoi chay cua so Google Chrome (App Mode)...

rem Tim kiem Google Chrome tren may tinh (loai bo hoan toan Edge)
set "CHROME_EXE="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE for /f "delims=" %%I in ('where chrome 2^>nul') do if not defined CHROME_EXE set "CHROME_EXE=%%I"

if defined CHROME_EXE (
  start "" "%CHROME_EXE%" --user-data-dir="%LOCALAPPDATA%\MailNeonWorkspace\ChromeProfile" --app=https://127.0.0.1:3000 --allow-insecure-localhost --window-size=1280,820
) else (
  echo [!] Khong tim thay duong dan Google Chrome tieu chuan, mo qua trinh duyet mac dinh...
  start "" "https://127.0.0.1:3000"
)

rem Khoi dong server HTTPS va SMTP ngam
"%NODE_EXE%" -e "const h=require('https');const r=h.get('https://127.0.0.1:3000/healthz',{rejectUnauthorized:false,timeout:1200},s=>process.exit(s.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)})"
if not errorlevel 1 (
  echo [INFO] May chu da chay san tren cong 3000; su dung cua so Chrome vua mo.
  exit /b 0
)
set "AUTO_BOOTSTRAP_LOCAL=true"
"%NODE_EXE%" "src\server.mjs"

pause

