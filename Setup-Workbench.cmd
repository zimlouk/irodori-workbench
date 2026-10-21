@echo off
cd /d "%~dp0"
python "scripts\setup_check.py"
if errorlevel 1 goto failed
if not exist ".venv\Scripts\python.exe" python -m venv .venv
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.lock.txt
if errorlevel 1 goto failed
pushd frontend
call npm.cmd ci
if errorlevel 1 (
  popd
  goto failed
)
call npm.cmd run build
if errorlevel 1 (
  popd
  goto failed
)
popd
echo Setup complete. Run Start-Workbench.cmd.
exit /b 0
:failed
echo Setup failed. Review the output above.
pause
exit /b 1
