@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  echo [LOI] Khong tim thay Node.js 24+. Hay cai dat Node.js de tiep tuc.
  pause
  exit /b 1
)

"%NODE_EXE%" "scripts\clean.mjs" %*
echo.
echo Nhan phim bat ky de thoat...
pause >nul
exit /b %ERRORLEVEL%
