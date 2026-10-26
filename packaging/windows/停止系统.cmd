@echo off
chcp 65001 >nul
"%~dp0runtime\python\python.exe" -B "%~dp0launcher.py" stop
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
