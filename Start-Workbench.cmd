@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [Irodori] 正在启动工作台，请稍候。启动阶段和关键日志将在此显示。
if not exist ".venv\Scripts\python.exe" (
  echo Please complete the setup in README.md first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -u "scripts\start.py" %*
if errorlevel 1 pause

