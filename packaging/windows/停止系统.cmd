@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
"runtime\python\python.exe" -B "launcher.py" stop
set "system_exit=%errorlevel%"
popd
if not "%system_exit%"=="0" (
  pause
  exit /b %system_exit%
)
exit /b 0
