@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "PYTHONDONTWRITEBYTECODE=1"
set "PYTHONIOENCODING=utf-8"
set "packageRoot=%~1"
if not defined packageRoot for %%I in ("%~dp0..\..") do set "packageRoot=%%~fI"
if not exist "%packageRoot%\runtime\python\python.exe" set /p "packageRoot=请输入包含启动系统.cmd的便携目录："
if not exist "%packageRoot%\runtime\python\python.exe" (
  echo 未找到便携Python环境。请确认选择的是完整便携目录。
  pause
  exit /b 1
)
set "outputRoot=%~2"
if not defined outputRoot set /p "outputRoot=请输入生成文件的F盘目录，不要选择软件数据目录："
if not defined outputRoot exit /b 1
if exist "F:\work\project2026-1\data\runtime\cache\tmp" (
  set "TEMP=F:\work\project2026-1\data\runtime\cache\tmp"
  set "TMP=F:\work\project2026-1\data\runtime\cache\tmp"
  set "TMPDIR=F:\work\project2026-1\data\runtime\cache\tmp"
)
"%packageRoot%\runtime\python\python.exe" -B -X utf8 "%~dp0按当前资源生成例程.py" --portable-root "%packageRoot%" --output "%outputRoot%"
if errorlevel 1 (
  echo 请按提示检查目录和资源，软件数据库未被修改。
  pause
  exit /b 1
)
pause
